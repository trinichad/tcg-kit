// Origin: BinderPricer server/core/pricecharting.ts @ e995c9e.
// Changed: module-level UA / limiter / cache and the PRICECHARTING_API_TOKEN
// env read become `ctx` (factory `createPriceCharting`); the scoring and the
// HTML parsers are untouched, including their regexes.
//
// PriceCharting — per-grade market values computed from eBay sold listings,
// plus the recent solds themselves. Used to price graded slabs (PSA/BGS/CGC/
// SGC/TAG…) and to show eBay comps for raw cards. Parsed from their
// server-rendered pages (no published free API) — guarded like tcglive.
//
// Sports cards live on sportscardspro.com — the same engine and page markup
// under a different host, so every parser here works for both.

import type { PricingCtx } from '../context';
import { nameSim, normNumber } from '../match';

const HOUR = 3600_000;

export type PcHost = 'tcg' | 'sports';
const HOST_URL: Record<PcHost, string> = {
  tcg: 'https://www.pricecharting.com',
  sports: 'https://www.sportscardspro.com',
};

export interface PcSearchHit {
  url: string; // absolute product URL
  setSlug: string; // e.g. "pokemon-base-set"
  productSlug: string; // e.g. "charizard-1st-edition-4"
  setName: string; // slug words: "pokemon base set"
  productName: string; // slug words: "charizard 1st edition 4"
}

export interface PcSale {
  date: string; // "2026-07-02"
  title: string;
  price: number;
  source: string; // "ebay" | "tcgplayer" | "pwcc" | …
  url?: string;
}

export interface PcData {
  url: string;
  /** Label → USD, e.g. { "Ungraded": 352.69, "Grade 9": 2461.82, "PSA 10": 30100 } */
  grades: Record<string, number>;
  /** Label → recent sold listings (newest first), same labels as `grades`. */
  sales: Record<string, PcSale[]>;
}

// PriceCharting reuses its video-game price columns for cards.
const BUCKETS: [id: string, cardLabel: string][] = [
  ['used_price', 'Ungraded'],
  ['complete_price', 'Grade 7'],
  ['new_price', 'Grade 8'],
  ['graded_price', 'Grade 9'],
  ['box_only_price', 'Grade 9.5'],
  ['manual_only_price', 'PSA 10'],
];

const money = (s: string): number | null => {
  const n = parseFloat(s.replace(/[$,]/g, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

const unescapeHtml = (s: string): string =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');

function parseGrades(html: string): Record<string, number> {
  const grades: Record<string, number> = {};
  for (const [id, label] of BUCKETS) {
    const m = html.match(
      new RegExp(`id="${id}"[\\s\\S]{0,300}?class="price js-price"[^>]*>\\s*([^<]+)`),
    );
    const value = m && money(m[1]);
    if (value != null && grades[label] == null) grades[label] = value;
  }
  // The "full price guide" table: Grade 1..9.5 plus grader-specific 10s.
  for (const m of html.matchAll(
    /<t[dh][^>]*>\s*((?:PSA|BGS|CGC|SGC|TAG)\s?10|Grade\s?[\d.]+)\s*<\/t[dh]>[\s\S]{0,220}?(?:class="price js-price[^"]*"[^>]*>\s*([^<]+)|<\/tr>)/g,
  )) {
    const label = m[1].replace(/\s+/g, ' ').trim();
    const value = m[2] ? money(m[2]) : null;
    if (value != null && grades[label] == null) grades[label] = value;
  }
  return grades;
}

/**
 * The sold listings are embedded in the page (verified 2026-07-06): one
 * `<div class="completed-auctions-{bucket}">` table per grade bucket, rows
 * carrying date / title-anchor (class js-{source}-completed-sale) / js-price.
 * A `<select id="completed-auctions-condition">` maps bucket → grade label.
 */
function parseSales(html: string): Record<string, PcSale[]> {
  const labelByBucket = new Map<string, string>();
  for (const m of html.matchAll(/<option value="completed-auctions-([a-z-]+)">\s*([^<(]+?)\s*\(\d+\)/g)) {
    labelByBucket.set(m[1], m[2].replace(/\s+/g, ' ').trim());
  }
  const out: Record<string, PcSale[]> = {};
  for (const sec of html.matchAll(/<div class="completed-auctions-([a-z-]+)"[\s\S]*?<\/table>/g)) {
    const label = labelByBucket.get(sec[1]);
    if (!label || out[label]) continue;
    const rows: PcSale[] = [];
    for (const r of sec[0].matchAll(
      /<td class="date">([\d-]+)<\/td>[\s\S]*?<a[^>]*class="js-(\w+)-completed-sale"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="js-price"[^>]*>\s*([^<]+)/g,
    )) {
      const price = money(r[5]);
      if (price == null) continue;
      rows.push({
        date: r[1],
        source: r[2].toLowerCase(),
        url: r[3] ? unescapeHtml(r[3]) : undefined,
        title: unescapeHtml(r[4].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(),
        price,
      });
      if (rows.length >= 12) break;
    }
    if (rows.length) out[label] = rows;
  }
  return out;
}

// ── Matching an identified card to a PriceCharting product ─────────────────

export interface PcCardQuery {
  name: string;
  setName?: string;
  number?: string;
  /** Variant cues: "shadowless", "1st edition", "reverse holo", … */
  variant?: string;
}

const VARIANT_WORDS = ['shadowless', '1st edition', 'first edition', 'reverse', 'holo', 'promo', 'delta', 'staff', 'jumbo', 'error', 'japanese', 'korean', 'chinese', 'alternate art', 'manga', 'sp'];
// Variants whose mismatch changes the price so much a wrong match is worse
// than none (unlimited vs 1st ed, English vs Japanese product pages).
const STRICT_WORDS = ['shadowless', 'edition', 'japanese', 'korean', 'chinese'];

export function scorePcHit(query: PcCardQuery, hit: PcSearchHit): number {
  // Collector number = the slug's last dash segment when it has a digit —
  // handles letter-prefixed numbering ("flareon-ex-rc28", "…-tg12") that a
  // digits-only extraction misses entirely (which mispriced a PSA slab off a
  // same-named card from a different era). Set-code-numbered games (One
  // Piece "…-op01-003", Yu-Gi-Oh "…-lob-en001") span TWO segments — offer
  // both forms so bare reads ("067") and full reads ("OP01-003") each hit.
  const segs = hit.productSlug.split('-').filter(Boolean);
  const lastSeg = segs.pop() ?? '';
  const prevSeg = segs[segs.length - 1] ?? '';
  const slugNumber = /\d/.test(lastSeg) ? lastSeg : '';
  const slugNumbers = slugNumber ? [slugNumber] : [];
  if (slugNumber && /^[a-z]{1,5}\d{1,3}$/.test(prevSeg)) {
    slugNumbers.push(`${prevSeg}-${slugNumber}`);
  }
  const hitName = slugNumbers.length
    ? hit.productName.replace(
        new RegExp(`\\s*${slugNumbers[slugNumbers.length - 1].replace('-', '\\s*')}\\s*$`, 'i'),
        '',
      )
    : hit.productName;
  let score = 0.55 * nameSim(query.name, hitName);
  if (query.number) {
    const qNum = normNumber(query.number).split('/')[0];
    let numCredit = 0;
    for (const sn of slugNumbers) {
      const sNum = normNumber(sn);
      if (!qNum || !sNum) continue;
      if (sNum === qNum) numCredit = Math.max(numCredit, 0.25);
      // Same digits, different letter prefix ("rc28" vs "28"): weak credit.
      else if (qNum.replace(/[a-z]/g, '') === sNum.replace(/[a-z]/g, '') && qNum.replace(/[a-z]/g, '')) {
        numCredit = Math.max(numCredit, 0.15);
      }
    }
    score += numCredit;
  }
  let setSim = 0;
  if (query.setName) {
    setSim = nameSim(query.setName, hit.setName);
    score += 0.12 * setSim;
    // A set that disagrees outright is usually a different card entirely
    // (2016 Generations RC28 vs 2025 Prismatic Evolutions #146).
    if (setSim < 0.25) score -= 0.15;
  }
  // Variant agreement matters enormously (unlimited vs shadowless vs 1st ed).
  // Language lives in the SET slug on PriceCharting ("pokemon-japanese-…"),
  // so match variants against set + product text together.
  let wanted = `${query.variant ?? ''} ${query.setName ?? ''}`.toLowerCase();
  // Base Set 1st Editions ARE shadowless, but PriceCharting slugs them as
  // "…-1st-edition-…" only — wanting both words would penalize the correct
  // product for "missing" shadowless, tying it with the wrong one.
  if (/1st edition|first edition/.test(wanted)) wanted = wanted.replace(/shadowless/g, '');
  // One Piece "Special (Alternate) Art" is the SP parallel (PriceCharting slug
  // "…-sp-foil-…"), a different and far pricier card than the plain "Alternate
  // Art" ($945 vs $173). Collapse it to the "sp" tag so the shared "alternate
  // art" words can't tie the score toward the wrong sibling.
  if (/\bsp\b|special\s*(?:alt|art)/.test(wanted)) {
    wanted = wanted.replace(/alternate art|alt art/g, ' ') + ' sp';
  }
  // PriceCharting abbreviates in slugs: "alt art" is their "alternate art".
  const hitText = `${hit.setName} ${hit.productName}`
    .toLowerCase()
    .replace(/\balt art\b/g, 'alternate art');
  // "sp" is a whole-word rarity tag ("sp foil") — never a substring of
  // "special", "spy", "crispin", …
  const has = (text: string, w: string) =>
    w === 'sp' ? /(?:^|[^a-z])sp(?:[^a-z]|$)/.test(text) : text.includes(w);
  for (const word of VARIANT_WORDS) {
    const wantIt = has(wanted, word.replace('first', '1st')) || has(wanted, word);
    const hasIt = has(hitText, word);
    if (wantIt && hasIt) score += 0.1;
    else if (wantIt !== hasIt && STRICT_WORDS.some((s) => word.includes(s))) score -= 0.18;
  }
  // Prefer the base card when no strong art variant was read: an SP / alt-art /
  // manga / parallel slug the read didn't ask for is usually the wrong, pricier
  // sibling (a plain base card must not resolve to its $945 SP).
  const ART_MARKERS = ['sp', 'alternate art', 'manga', 'parallel', 'full art', 'secret'];
  const wantsArt = ART_MARKERS.some((w) => has(wanted, w));
  const hitArt = ART_MARKERS.some((w) => has(hitText, w));
  if (!wantsArt && hitArt) score -= 0.08;
  return score;
}

// ── Grade → price-table label ───────────────────────────────────────────────

export function gradeLabelFor(
  grader: string,
  grade: string,
  grades: Record<string, number>,
): { label: string; note?: string } | null {
  const g = grader.toUpperCase();
  const n = parseFloat(grade);
  if (!Number.isFinite(n)) return null;
  if (n === 10) {
    const exact = `${g} 10`;
    if (grades[exact] != null) return { label: exact };
    if (grades['PSA 10'] != null) return { label: 'PSA 10', note: `${g} 10 priced at the PSA 10 value` };
    return null;
  }
  const tryLabels = (v: number) => [`Grade ${v}`, `Grade ${v.toFixed(1)}`];
  for (const label of tryLabels(n)) if (grades[label] != null) return { label };
  // Half grades and gaps: step down to the nearest available grade.
  for (let v = Math.floor(n * 2) / 2; v >= 1; v -= 0.5) {
    for (const label of tryLabels(v)) {
      if (grades[label] != null) {
        return { label, note: `no ${grader} ${grade} value — using ${label}` };
      }
    }
  }
  return null;
}

// ── API GRADE KEYS (official paid API) ──────────────────────────────────────

const API_GRADE_KEYS: [key: string, label: string][] = [
  ['loose-price', 'Ungraded'],
  ['cib-price', 'Grade 7'],
  ['new-price', 'Grade 8'],
  ['graded-price', 'Grade 9'],
  ['box-only-price', 'Grade 9.5'],
  ['manual-only-price', 'PSA 10'],
  ['bgs-10-price', 'BGS 10'],
  ['condition-17-price', 'CGC 10'],
  ['condition-18-price', 'SGC 10'],
];

export type PriceCharting = ReturnType<typeof createPriceCharting>;

export function createPriceCharting(ctx: PricingCtx) {
  async function getHtml(url: string): Promise<string | null> {
    return ctx.limitPriceCharting(async () => {
      try {
        const r = await ctx.fetchRetry(url, {
          headers: { 'user-agent': ctx.userAgent, accept: 'text/html' },
        });
        if (!r.ok) {
          console.error(`[pricecharting] ${r.status} for ${url}`);
          return null;
        }
        return await r.text();
      } catch (err) {
        console.error(`[pricecharting] fetch failed: ${url}`, err);
        return null;
      }
    });
  }

  async function pcSearch(q: string, host: PcHost = 'tcg'): Promise<PcSearchHit[] | null> {
    const base = HOST_URL[host];
    return ctx.cached(`pc:search:${host}:${q.toLowerCase()}`, 6 * HOUR, async () => {
      const html = await getHtml(`${base}/search-products?q=${encodeURIComponent(q)}&type=prices`);
      if (html === null) return null;
      const seen = new Set<string>();
      const hits: PcSearchHit[] = [];
      for (const m of html.matchAll(/href="(?:https:\/\/www\.(?:pricecharting|sportscardspro)\.com)?(\/game\/([\w%.-]+)\/([\w%.-]+))"/g)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        hits.push({
          url: `${base}${m[1]}`,
          setSlug: m[2],
          productSlug: m[3],
          setName: decodeURIComponent(m[2]).replace(/-/g, ' '),
          productName: decodeURIComponent(m[3]).replace(/-/g, ' '),
        });
        if (hits.length >= 25) break;
      }
      return hits;
    });
  }

  /** Fetch + parse a product page once: per-grade values AND the sold listings. */
  async function pcData(productUrl: string): Promise<PcData | null> {
    return ctx.cached(`pc:data:${productUrl}`, 6 * HOUR, async () => {
      const html = await getHtml(productUrl);
      if (html === null) return null;
      return { url: productUrl, grades: parseGrades(html), sales: parseSales(html) };
    });
  }

  /** Back-compat view of pcData for callers that only need the values. */
  async function pcPrices(productUrl: string): Promise<Pick<PcData, 'url' | 'grades'> | null> {
    const data = await pcData(productUrl);
    return data && { url: data.url, grades: data.grades };
  }

  async function findPcProduct(
    query: PcCardQuery,
    host: PcHost = 'tcg',
  ): Promise<PcSearchHit | null> {
    // Sports parallels ("Silver Prizm") are part of the product identity, so
    // they belong in the query. For TCGs, only the words PriceCharting builds
    // into its slugs help: language ("…-japanese-…") and edition — searching
    // WITHOUT "1st edition" never surfaces the 1st-edition product pages at
    // all. Other variant words (holofoil…) would pollute the query.
    const v = (query.variant ?? '').toLowerCase();
    // The rarity/parallel tag PriceCharting builds into the slug — the one word
    // that narrows a wall of same-number siblings (7 "op05-067" Zoro-Juurous) to
    // the right page. "Special (Alternate) Art" → the "sp" parallel.
    const rarity = /\bsp\b|special\s*(?:alt|art)/.test(v)
      ? 'sp'
      : /alternate art|alt art/.test(v)
        ? 'alternate art'
        : /manga/.test(v)
          ? 'manga'
          : '';
    const variantWords =
      host === 'sports'
        ? (query.variant ?? '').replace(/\b(normal|base|unlimited)\b/gi, '').trim()
        : [
            ...((query.variant ?? '').match(/japanese|korean|chinese|vietnamese/gi) ?? []),
            ...(/1st edition|first edition/i.test(query.variant ?? '') ? ['1st edition'] : []),
            rarity,
          ]
            .filter(Boolean)
            .join(' ');
    const q = [query.name, variantWords, query.number?.split('/')[0], query.setName]
      .filter(Boolean)
      .join(' ');
    let hits = await pcSearch(q, host);
    if (hits && hits.length === 0) {
      hits = await pcSearch([query.name, query.setName].filter(Boolean).join(' '), host);
    }
    if (!hits || hits.length === 0) return null;
    // Tiebreak equal scores toward the plainest slug: with no distinguishing
    // signal, "zoro-juurou-op05-067" (base) beats "…-championship-25-26-…" and
    // the other same-number promos — the safest default is the common card.
    const segs = (h: PcSearchHit) => h.productSlug.split('-').filter(Boolean).length;
    const scored = hits
      .map((hit) => ({ hit, score: scorePcHit(query, hit) }))
      .sort((a, b) => b.score - a.score || segs(a.hit) - segs(b.hit));
    return scored[0].score >= 0.45 ? scored[0].hit : null;
  }

  // ── Official Prices API (paid token) ──────────────────────────────────────
  // Datacenter IPs get a Cloudflare challenge from sportscardspro.com, so
  // deployed sports lookups need PriceCharting's official API instead
  // (config.tokens.pricecharting — token from their Subscription page). Same
  // grade semantics as the page buckets; individual sold listings not included.

  async function pcApiData(
    query: PcCardQuery,
    host: PcHost,
    tokenOverride?: string,
  ): Promise<PcData | null> {
    // A caller-supplied token wins over the instance config — same
    // bring-your-own pattern as the PSA token, so each user's lookups run
    // under their own PriceCharting subscription.
    const token = (tokenOverride ?? '').trim() || (ctx.tokens.pricecharting ?? '').trim();
    if (!token) return null;
    const q = [query.name, query.variant, query.number?.split('/')[0], query.setName]
      .filter(Boolean)
      .join(' ');
    const key = `pc:api:${host}:${q.toLowerCase()}`;
    return ctx.cached(key, 6 * HOUR, async () => {
      try {
        const r = await ctx.fetch(
          `https://www.pricecharting.com/api/product?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`,
          {
            headers: { 'user-agent': ctx.userAgent, accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
          },
        );
        if (!r.ok) {
          console.error(`[pricecharting] api ${r.status}`);
          return null;
        }
        const data = (await r.json()) as Record<string, unknown> & {
          'product-name'?: string;
          'console-name'?: string;
          status?: string;
        };
        if (data.status === 'error' || !data['product-name']) return null;
        // Their matcher picks one product — sanity-check it's actually our card.
        if (nameSim(query.name, String(data['product-name'])) < 0.5) return null;
        const grades: Record<string, number> = {};
        for (const [k, label] of API_GRADE_KEYS) {
          const cents = Number(data[k]);
          if (Number.isFinite(cents) && cents > 0) grades[label] = Math.round(cents) / 100;
        }
        if (!Object.keys(grades).length) return null;
        // Humans can open the sports site fine — only datacenter fetches are
        // challenged — so link to a search there for the sold history.
        const url = `${HOST_URL[host]}/search-products?q=${encodeURIComponent(q)}&type=prices`;
        return { url, grades, sales: {} };
      } catch (err) {
        console.error('[pricecharting] api request failed', err);
        return null;
      }
    });
  }

  const hasToken = (override?: string): boolean =>
    Boolean((override ?? '').trim() || (ctx.tokens.pricecharting ?? '').trim());

  return { pcSearch, pcData, pcPrices, findPcProduct, pcApiData, hasToken };
}
