// Origin: BinderPricer server/core/pricing.ts @ e995c9e, with PokedexDebut
// execution/pricing/quote.mjs's rung 0 (`tcg_market`) and TCGplayer-anchored
// ladder rules folded in (PokéDebut architecture/pricing.md §2; decisions.md
// 2026-09-17 "Primary price = TCGplayer's own per-condition market").
// Changed vs BinderPricer: `quote()` now asks TCGplayer for its own market for
// this exact printing × condition FIRST and returns it untouched when present;
// `quoteAll()` gained the scaled-from-nearest-rung ladder for that case.
// Changed vs PokéDebut: BinderPricer's condition ids/codes (…DM, not DMG), its
// `sales`/`listings`/`listedLow`/`listedMid` payload, and its arbitrary
// categoryId/groupId (PokéDebut hard-coded the Pokémon category).
// Everything else — outlier band, factors, isotonic pooling, ask-floor guard —
// is byte-for-byte the same logic as both sources.

import type { PricingCtx } from './context';
import type { TcgCsv } from './providers/tcgcsv';
import { saneMarketPrice } from './providers/tcgcsv';
import type { TcgLive } from './providers/tcglive';
import type { TcgPlayerSku } from './providers/tcgplayer-sku';
import type { ConditionCode, ConditionQuotes, ListingSample, PriceQuote, PriceRef } from './types';
import { median, round2 } from './util';

const FACTOR: Record<ConditionCode, number> = {
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.55,
  DM: 0.4,
};

const CONDITION_NAME: Record<ConditionCode, string> = {
  NM: 'Near Mint',
  LP: 'Lightly Played',
  MP: 'Moderately Played',
  HP: 'Heavily Played',
  DM: 'Damaged',
};

// TCGplayer condition ids as accepted by mpapi's latestsales filter.
const CONDITION_ID: Record<ConditionCode, number> = { NM: 1, LP: 2, MP: 3, HP: 4, DM: 5 };

const CODE_BY_NAME: Record<string, ConditionCode> = Object.fromEntries(
  (Object.entries(CONDITION_NAME) as [ConditionCode, string][]).map(([code, name]) => [name, code]),
);

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const ALL_CONDITIONS = Object.keys(CONDITION_ID) as ConditionCode[];

/** Sources that are real numbers, not estimates. */
const TRUSTED = new Set<PriceQuote['source']>(['tcg_market', 'sales', 'ask']);

export { ALL_CONDITIONS, CONDITION_ID, CONDITION_NAME, FACTOR, TRUSTED };

/**
 * Force the ladder to be non-increasing (NM >= LP >= MP >= HP >= DM).
 *
 * Each condition is priced from its own sold listings, so with the thin
 * samples most cards have (1-5 sales) the medians routinely invert — an audit
 * of 60 random cards found 28% of ladders with at least one rung out of order
 * (Type: Null went NM $0.39, LP $0.25, MP $0.08, HP $0.23, DM $0.27). A played
 * copy being worth more than a clean one is never real; it's sampling noise.
 *
 * Pool-adjacent-violators is the minimal honest correction: where the order is
 * violated, the offending run is replaced by its evidence-weighted mean and
 * nothing else moves. Conditions backed by more solds pull harder, and an
 * already-monotone ladder is left completely untouched — so this only ever
 * fires on data that was self-contradictory to begin with.
 *
 * Pooling to equal prices is the correct outcome, not a cop-out: it says the
 * sales data cannot tell those grades apart, which for a $0.20 common is true.
 *
 * Used ONLY for ladders built from solds. TCGplayer's own per-condition
 * markets are never pooled — they are shown exactly as TCGplayer shows them.
 */
export function enforceMonotonic(quotes: PriceQuote[]): void {
  interface Block {
    weighted: number; // sum of weight * price
    weight: number;
    members: PriceQuote[];
  }
  const blocks: Block[] = [];
  for (const q of quotes) {
    if (q.price == null) continue;
    // Real solds carry their sample size; derived rungs bend rather than lead.
    const weight = q.estimated ? 0.5 : Math.max(1, q.salesUsed);
    blocks.push({ weighted: weight * q.price, weight, members: [q] });
    // Merge back while this rung prices above the one before it.
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.weighted / prev.weight >= last.weighted / last.weight) break;
      prev.weighted += last.weighted;
      prev.weight += last.weight;
      prev.members.push(...last.members);
      blocks.pop();
    }
  }
  for (const b of blocks) {
    if (b.members.length < 2) continue; // untouched rung
    const pooled = round2(b.weighted / b.weight);
    for (const q of b.members) {
      if (q.price === pooled) continue;
      q.price = pooled;
      q.note =
        q.note ??
        'levelled with neighbouring conditions — their recent solds disagreed on which grade was worth more';
    }
  }
}

/**
 * Drop sales that sit far outside the recent price cluster.
 *
 * TCGplayer hands back the last ~25 solds, but a quote only medians the most
 * recent 3-5 of them. A median of three survives one bad number and no more —
 * so two deliberate undercuts in a row (or a lot piece, or a mispriced
 * listing) becomes the price. Judging each sale against the median of the FULL
 * window uses evidence that was already fetched and thrown away.
 *
 * The band is deliberately wide (0.4x to 3x): it is there to reject sales that
 * are not really this card being sold at market, not to smooth normal drift. A
 * genuine crash of up to 60% inside one window still passes through.
 */
export function withoutOutliers<T>(sales: T[], valueOf: (s: T) => number): T[] {
  if (sales.length < 4) return sales; // too little context to call anything an outlier
  const centre = median(sales.map(valueOf));
  if (!(centre > 0)) return sales;
  const kept = sales.filter((s) => valueOf(s) >= centre * 0.4 && valueOf(s) <= centre * 3);
  return kept.length >= 2 ? kept : sales;
}

export type Pricer = ReturnType<typeof createPricer>;

export function createPricer(
  _ctx: PricingCtx,
  deps: { csv: TcgCsv; live: TcgLive; sku: TcgPlayerSku },
) {
  const { csv, live, sku } = deps;

  async function quote(params: PriceRef): Promise<PriceQuote> {
    const { productId, condition } = params;
    const categoryId = params.categoryId ?? null;
    const groupId = params.groupId ?? null;
    const subType = params.subType ?? '';
    const n = Math.min(Math.max(params.salesCount || 3, 1), 10);
    const url = `https://www.tcgplayer.com/product/${productId}`;

    // ── 0. TCGplayer's own market for this exact printing + condition ───────
    // The number tcgplayer.com shows once a condition is selected. Exact, not
    // an estimate, and never "corrected" — matching tcgplayer.com is the
    // definition of accurate here. One call covers all five conditions.
    const markets = await sku.skuMarkets(productId);
    const hit = sku.skuMarketFor(markets, subType, CONDITION_NAME[condition]);
    if (hit && hit.market > 0) {
      return {
        productId,
        subType,
        condition,
        price: round2(hit.market),
        source: 'tcg_market',
        estimated: false,
        salesUsed: hit.sold,
        marketPrice: null,
        sales: [],
        url,
        asOf: hit.asOf,
        listings: [],
        listedLow: null,
        listedMid: null,
      };
    }

    const wantVariant = norm(subType);
    // "Market" is the placeholder sub-type used when we couldn't load the real
    // printing list — accept sales of any variant in that case.
    const variantOk = (v: string) =>
      !wantVariant || wantVariant === 'market' || norm(v) === wantVariant;

    // ── 1. Solds in this exact condition — a real lookup, not an estimate ───
    // The mixed-condition pool is only fetched when that comes back empty
    // (then we estimate) or for the market fallback.
    const exactPool = (await live.latestSales(productId, CONDITION_ID[condition])) ?? [];
    const exact = exactPool.filter(
      (s) => variantOk(s.variant) && s.condition === CONDITION_NAME[condition],
    );

    let price: number | null = null;
    let source: PriceQuote['source'] = 'none';
    let estimated = false;
    let salesUsed = 0;
    let shown = exact;

    if (exact.length) {
      // Judge against the whole window, then price off the most recent survivors.
      const take = withoutOutliers(exact, (s) => s.price).slice(0, n);
      price = round2(median(take.map((s) => s.price)));
      salesUsed = take.length;
      source = 'sales';
    } else {
      // ── 2. No sales in this exact condition: normalize recent sales to NM
      //    using the condition factors, then scale to the requested condition.
      const usable = ((await live.latestSales(productId)) ?? []).filter((s) =>
        variantOk(s.variant),
      );
      shown = usable;
      const known = usable.filter((s) => CODE_BY_NAME[s.condition]);
      if (known.length >= 2) {
        // Outliers here are judged on NM-equivalent value, since the pool mixes
        // conditions and a cheap Damaged sale is not an outlier by itself.
        const take = withoutOutliers(known, (s) => s.price / FACTOR[CODE_BY_NAME[s.condition]]).slice(
          0,
          Math.max(n, 5),
        );
        const nmEquivalent = take.map((s) => s.price / FACTOR[CODE_BY_NAME[s.condition]]);
        price = round2(median(nmEquivalent) * FACTOR[condition]);
        salesUsed = take.length;
        source = 'sales_adj';
        estimated = true;
      }
    }

    // ── 3. Product market price for the printing (sanitised) ───────────────
    let marketPrice: number | null = null;
    let note: string | undefined;
    let listedLow: number | null = null;
    let listedMid: number | null = null;
    if (categoryId != null && groupId != null) {
      try {
        const rows = await csv.prices(categoryId, groupId);
        const mine = rows.filter((r) => r.productId === productId);
        const row =
          mine.find((r) => norm(r.subTypeName) === wantVariant) ??
          mine.find((r) => r.marketPrice != null);
        if (row) {
          const sane = saneMarketPrice(row);
          marketPrice = sane.price;
          // Drop TCGplayer's 100000 "no listings" placeholder (see saneMarketPrice).
          listedLow = row.lowPrice != null && row.lowPrice !== 100000 ? row.lowPrice : null;
          listedMid = row.midPrice != null && row.midPrice !== 100000 ? row.midPrice : null;
          if (sane.adjusted) {
            note = `TCGplayer's published market price ($${row.marketPrice}) looks stale for this printing — using current listing prices instead`;
          }
        }
      } catch (err) {
        console.error('[pricing] market price lookup failed:', err);
      }
    }

    // Live asks in this exact condition+printing (cheapest first). Helps decide
    // a sell price: solds say what buyers paid, asks say the current competition.
    const listings: ListingSample[] = ((await live.currentListings(productId)) ?? [])
      // Drop TCGplayer's 100000 placeholder / troll listings so they can't set
      // the ask floor or show as a real "current ask".
      .filter(
        (l) =>
          variantOk(l.variant) && l.condition === CONDITION_NAME[condition] && l.price < 100000,
      )
      .slice(0, 5);

    if (price === null && marketPrice != null) {
      price = round2(marketPrice * FACTOR[condition]);
      source = condition === 'NM' ? 'market' : 'market_adj';
      estimated = condition !== 'NM';
    }

    // ── 4. Sanity vs the live ask floor ────────────────────────────────────
    // A thin sold/market sample sitting far below the cheapest current asks is
    // almost always bad data — a mispriced/fake "sold" or a lot part. A 1st-Ed
    // Charizard asking $4,300 NM does not sell for $250. When the sample is
    // thin and the price is a small fraction of the ask level on a non-trivial
    // card, use that ask level (a real "buy it for this").
    const askLevel = listings.length
      ? median(listings.map((l) => l.price + (l.shipping ?? 0)))
      : null;
    if (
      price != null &&
      askLevel != null &&
      askLevel > 50 &&
      salesUsed <= 2 &&
      price < askLevel * 0.4
    ) {
      price = round2(askLevel);
      source = 'ask';
      estimated = true;
      note =
        note ??
        `ignored a lone $${round2(exact[0]?.price ?? marketPrice ?? 0)} figure far below the ~$${round2(askLevel)} live asks — priced at the current ask level`;
    }

    return {
      productId,
      subType,
      condition,
      price,
      source,
      estimated,
      salesUsed,
      marketPrice,
      sales: shown.slice(0, 5),
      url,
      note,
      listings,
      listedLow,
      listedMid,
    };
  }

  /**
   * Quotes for every condition in one go, so a client can switch conditions
   * (and compare them) without further requests. The five condition-filtered
   * fetches run in parallel; the market-price, mixed-pool and per-SKU lookups
   * are shared through the cache's in-flight de-duplication.
   *
   * Ladder rules, in order:
   *
   * 1. When TCGplayer has a market for AT LEAST ONE condition, those rungs
   *    stay exactly as TCGplayer has them (never pooled, never "corrected"); a
   *    rung with real solds or an ask floor keeps its own price; every other
   *    rung is scaled from the NEAREST TCGplayer rung by factor ratio and
   *    clamped between its trusted neighbours. Vintage ladders are steep (Abra
   *    Shadowless: NM $10.65 → HP $1.08), so "nearest rung" beats "NM × factor"
   *    by a wide margin.
   * 2. With no TCGplayer condition market at all, BinderPricer's rules apply:
   *    if NM fell to the ask floor, every other condition = NM ask × factor;
   *    otherwise conditions without their own solds are scaled from the median
   *    NM-equivalent of the ones that have them; then the ladder is forced
   *    monotone by weighted isotonic pooling.
   */
  async function quoteAll(params: Omit<PriceRef, 'condition'>): Promise<ConditionQuotes> {
    const quotes = await Promise.all(
      ALL_CONDITIONS.map((condition) => quote({ ...params, condition })),
    );
    const result = () =>
      Object.fromEntries(ALL_CONDITIONS.map((c, i) => [c, quotes[i]])) as ConditionQuotes;

    // ── 1. TCGplayer-anchored ladder ───────────────────────────────────────
    if (quotes.some((q) => q.source === 'tcg_market')) {
      quotes.forEach((q, i) => {
        if (TRUSTED.has(q.source) && q.price != null) return;
        const above = quotes
          .slice(0, i)
          .reverse()
          .find((t) => t.source === 'tcg_market');
        const below = quotes.slice(i + 1).find((t) => t.source === 'tcg_market');
        const ref = (above ?? below) as PriceQuote;
        let p = round2(((ref.price as number) * FACTOR[q.condition]) / FACTOR[ref.condition]);
        if (above?.price != null && p > above.price) p = above.price;
        if (below?.price != null && p < below.price) p = below.price;
        q.price = p;
        q.source = 'scaled';
        q.estimated = true;
        q.salesUsed = 0;
        q.note = `no TCGplayer market for ${q.condition} — scaled from its ${ref.condition} market`;
      });
      return result();
    }

    // ── 2a. NM fell back to the ask floor ──────────────────────────────────
    // This printing's sold data is unreliable (sparse and self-contradictory —
    // a $250 NM, a $10,000 MP). Don't trust any condition's own solds; scale
    // the whole ladder from the NM ask.
    const nm = quotes[0]; // ALL_CONDITIONS[0] === 'NM'
    if (nm.source === 'ask' && nm.price != null) {
      for (const q of quotes) {
        if (q === nm) continue;
        q.price = round2(nm.price * FACTOR[q.condition]);
        q.source = 'sales_adj';
        q.estimated = true;
        q.salesUsed = 0;
        q.note = `scaled from the NM ask level — recent solds for this printing looked unreliable`;
      }
      return result();
    }

    // ── 2b. Anchor to conditions with a trustworthy price ──────────────────
    // Real solds, or the ask-floor fallback (which fires when solds are bad
    // data). Either is a far better NM basis than a stale market price.
    const anchored = (s: PriceQuote['source']) => s === 'sales' || s === 'ask';
    const trusted = quotes.filter((q) => anchored(q.source) && q.price != null);
    if (trusted.length) {
      const impliedNm = median(trusted.map((q) => (q.price as number) / FACTOR[q.condition]));
      const salesUsed = trusted.reduce((a, q) => a + q.salesUsed, 0);
      for (const q of quotes) {
        if (anchored(q.source)) continue;
        q.price = round2(impliedNm * FACTOR[q.condition]);
        q.source = 'sales_adj';
        q.estimated = true;
        q.salesUsed = salesUsed;
        q.note = `no recent ${q.condition} solds of this printing — scaled from this printing's price in other conditions`;
      }
    }

    // Last: reconcile rungs that still contradict each other. Runs after the
    // anchoring above so it sees the final ladder, derived rungs included.
    enforceMonotonic(quotes);
    return result();
  }

  return { quote, quoteAll };
}
