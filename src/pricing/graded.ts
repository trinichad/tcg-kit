// Origin: the BODY of BinderPricer api/graded.ts @ e995c9e — business logic
// that was stranded in an HTTP handler.
// Changed: query params → a `GradedQuery` object; `res.status(200).json(x)` →
// `return x`; `req.headers['x-psa-token'] / ['x-pc-token']` → `q.psaToken` /
// `q.pcToken`; `process.env.PRICECHARTING_API_TOKEN` → `pc.hasToken()`. The
// PSA-first ordering, the eBay fallback ladder and every note string are
// unchanged.

import type { PricingCtx } from './context';
import type { Ebay } from './providers/ebay';
import type { PcData, PcHost, PriceCharting } from './providers/pricecharting';
import { gradeLabelFor } from './providers/pricecharting';
import type { Psa } from './providers/psa';
import type { GradedQuery, PriceQuote, PsaLookupError, PsaVerify, SaleSample } from './types';

export type GradedPricer = ReturnType<typeof createGradedPricer>;

export function createGradedPricer(
  _ctx: PricingCtx,
  deps: { pc: PriceCharting; psa: Psa; ebay: Ebay },
) {
  const { pc, psa: psaApi, ebay } = deps;

  /**
   * Price a graded slab (or fetch raw eBay comps with `grader: 'RAW'`) from
   * PriceCharting's eBay-solds data. Never throws — an unpriceable slab comes
   * back as a quote with `price: null` and a note saying why.
   */
  async function priceGraded(q: GradedQuery): Promise<PriceQuote> {
    const name = (q.name ?? '').trim();
    if (!name) throw new Error('priceGraded: name required');
    const grader = (q.grader ?? '').trim().toUpperCase() || 'RAW';
    let grade = (q.grade ?? '').trim();
    const lockGrade = q.lockGrade === true;
    // Sports cards live on sportscardspro.com (same engine, different host).
    const host: PcHost = (q.game ?? '').trim().toLowerCase() === 'sports' ? 'sports' : 'tcg';

    // PSA slabs: verify the cert against PSA's own records. The verified
    // subject/number/variety replace the label READ for matching, and a
    // misread grade is corrected (unless the user picked one deliberately).
    let psa: PsaVerify | null = null;
    let note: string | undefined;
    const cert = (q.cert ?? '').trim();
    if (grader === 'PSA') {
      // The caller can pass along a verification it already fetched (and caches
      // per-device — certs are immutable), so one scan costs ONE PSA quota call,
      // not one per endpoint. PSA daily allowances are tiny (1/day entry tier).
      let error: PsaLookupError | undefined = undefined;
      if (q.psa && typeof q.psa.subject === 'string' && q.psa.subject) psa = q.psa;
      // The caller can also report that its own verification attempt failed —
      // don't spend another quota call re-discovering the same failure.
      const clientError = q.psaError;
      if (!psa && clientError) error = clientError;
      if (!psa && !clientError && cert) {
        // A token from the caller wins over the instance config — everyone's
        // lookups run under their own PSA agreement.
        const userToken = (q.psaToken ?? '').trim();
        const hadToken = psaApi.hasToken(userToken);
        ({ psa, error } = await psaApi.psaCertDetailed(cert, userToken || undefined));
        if (!hadToken) error = undefined; // no token configured → silent fallback
      }
      if (psa?.grade && psa.grade !== grade) {
        if (lockGrade) {
          note = `heads up: PSA cert ${psa.cert} is graded ${psa.gradeDescription}`;
        } else {
          note = `grade corrected to ${psa.gradeDescription} per PSA cert ${psa.cert}`;
          grade = psa.grade;
        }
      } else if (!psa && cert && error) {
        // Be honest that the price came from the label read, not PSA's record.
        note =
          error === 'quota'
            ? `PSA daily call limit reached — cert ${cert} not verified this time; priced from the label read`
            : error === 'auth'
              ? 'PSA rejected the token — re-check it in Settings; priced from the label read'
              : error === 'notfound'
                ? `PSA has no record of cert ${cert} — double-check the cert number`
                : `couldn't reach PSA to verify cert ${cert} — priced from the label read`;
      }
    }

    const empty: PriceQuote = {
      productId: 0,
      subType: grader === 'RAW' ? 'Raw' : `${grader} ${grade}`,
      condition: 'NM',
      price: null,
      source: 'none',
      estimated: false,
      salesUsed: 0,
      marketPrice: null,
      sales: [],
      url: '',
      psa: psa ?? undefined,
    };

    // PSA's number is authoritative (reprints can keep their original number —
    // a label-derived "OP09-067" can name a card that doesn't exist).
    const pickNumber = psa?.cardNumber || (q.number ?? '').trim();

    const query = {
      // PSA's record is authoritative for who/what the card is; keep the
      // AI-read set name for context (PSA's brand strings are terse).
      name: psa ? psa.subject.replace(/[/]+/g, ' ') : name,
      setName: (q.setName ?? '').trim() || undefined,
      number: pickNumber || undefined,
      variant:
        [(q.variant ?? '').trim(), psa?.variety ?? '', psa?.year ?? ''].filter(Boolean).join(' ') ||
        undefined,
    };

    const pcToken = (q.pcToken ?? '').trim();

    // Last-resort fallback: eBay Browse live ASKS (not solds) for the slab.
    // Fires whenever PriceCharting can't price it — no product match, OR a
    // product with no value for this exact grade. Off/no-op unless eBay creds
    // are configured.
    const tryEbay = async (): Promise<PriceQuote | null> => {
      const g = grader !== 'RAW' ? `${grader} ${grade}` : '';
      const coreNum = (pickNumber || '').split('/')[0];
      // Set names arrive catalog-formatted ("SWSH01: Sword & Shield Base Set",
      // "XY - Steam Siege"); eBay titles carry the plain set, not the code.
      const plainSet = (query.setName ?? '')
        .replace(/^[A-Z0-9]{2,6}\s*[:\-–]\s*/i, '')
        .replace(/\s*\(.*?\)\s*/g, ' ')
        .trim();
      // Narrowest query that still returns listings wins. Name alone is the
      // last resort for a reason: "Krabby PSA 10" matches every Krabby ever
      // slabbed, which priced a 30-cent modern common at $246 off vintage
      // listings.
      const asks =
        (coreNum ? await ebay.ebayAsks([query.name, coreNum, g].filter(Boolean).join(' ')) : null) ??
        (plainSet ? await ebay.ebayAsks([query.name, plainSet, g].filter(Boolean).join(' ')) : null) ??
        (await ebay.ebayAsks([query.name, g].filter(Boolean).join(' ')));
      if (!asks) return null;
      return {
        ...empty,
        price: asks.median,
        source: 'ebay',
        marketPrice: asks.median,
        subType: grader === 'RAW' ? 'Raw' : `${grader} ${grade}`,
        gradeLabel: grader === 'RAW' ? undefined : `${grader} ${grade}`,
        note: [note, `no sold price guide — median of ${asks.count} current eBay asks (from ${asks.low})`]
          .filter(Boolean)
          .join(' · '),
        sourceUrl: asks.url,
        url: asks.url,
      };
    };

    // Page scrape first (it carries the individual sold listings), then the
    // official Prices API — needed for sportscardspro from a datacenter IP,
    // whose Cloudflare config challenges those. The token comes from the
    // caller or the instance config.
    let data: PcData | null = null;
    const product = await pc.findPcProduct(query, host);
    if (product) data = await pc.pcData(product.url);
    if (!data) data = await pc.pcApiData(query, host, pcToken || undefined);
    if (!data) {
      const viaEbay = await tryEbay();
      if (viaEbay) return viaEbay;
      const hint =
        host === 'sports' && !pc.hasToken(pcToken)
          ? 'sports lookups need a PriceCharting API token — add one to the pricing config, or open the eBay solds link and set the price manually'
          : 'no eBay price-guide match found — set a price manually';
      return { ...empty, note: hint, sourceUrl: product?.url };
    }

    let label: string;
    if (grader === 'RAW') {
      label = 'Ungraded';
    } else {
      const resolved = gradeLabelFor(grader, grade, data.grades);
      if (!resolved) {
        // PriceCharting has the card but no value for THIS grade — try eBay
        // asks for the exact slab before giving up.
        const viaEbay = await tryEbay();
        if (viaEbay) return viaEbay;
        return {
          ...empty,
          note:
            [note, `no ${grader} ${grade} value in the price guide — set a price manually`]
              .filter(Boolean)
              .join(' · ') || undefined,
          sourceUrl: data.url,
        };
      }
      label = resolved.label;
      note = [note, resolved.note].filter(Boolean).join(' · ') || undefined;
    }

    // The actual eBay sold listings behind the guide value (tcgplayer/pwcc rows
    // are dropped — TCGplayer's own feed is shown separately).
    const sales: SaleSample[] = (data.sales[label] ?? [])
      .filter((s) => s.source === 'ebay')
      .slice(0, 5)
      .map((s) => ({
        date: s.date,
        price: s.price,
        condition: 'eBay',
        variant: label,
        title: s.title,
        url: s.url,
      }));

    const price = data.grades[label] ?? null;
    return {
      ...empty,
      price,
      source: price != null ? 'graded' : 'none',
      marketPrice: price,
      subType: grader === 'RAW' ? 'Raw' : `${grader} ${grade}`,
      gradeLabel: label,
      // The whole ladder, so a RAW lookup can show "what it'd be worth graded".
      grades: data.grades,
      sourceUrl: data.url,
      url: data.url,
      note,
      sales,
    };
  }

  return { priceGraded };
}
