// Origin: BinderPricer server/core/pricing.ts @ ad9350c ("stale solds yield to
// live asks, never above the cheapest listing"), with PokedexDebut's rung 0
// (`tcg_market`, TCGplayer's own per-SKU market) folded in as the sold level.
//
// The metric, in one paragraph (Chad, 2026-09-22): a sale from months ago must
// not set the price; the live listings must be considered; and a price can
// never sit above the cheapest copy a customer could buy right now. So every
// condition's sold evidence — TCGplayer's own market for that SKU when it has
// one, else our median of the last solds — carries a recency weight that
// halves every two weeks, is blended (in ratio terms) with the cheapest live
// ask, and is finally capped at the cheapest delivered listing.
//
// Changed vs BinderPricer: `quote()` asks TCGplayer for its own market for this
// exact printing × condition FIRST and uses it as the sold level (its age read
// off the daily sales buckets); the ladder scales gaps from the NEAREST
// anchored rung (PokéDebut's rule — vintage ladders are steep) instead of the
// implied-NM median; TCGplayer's own rungs are never pooled or "corrected",
// only capped by a cheaper listing. Everything else — half-life, ask discount
// and weight, the contradiction rule, the bad-data tripwire with its
// corroboration, the sub-$2 and lone-ask rules, the cap — is the same logic
// and the same constants.

import type { PricingCtx } from './context';
import type { CsvPrice, TcgCsv } from './providers/tcgcsv';
import { saneMarketPrice } from './providers/tcgcsv';
import type { ListingRow, TcgLive } from './providers/tcglive';
import type { SkuMarket, TcgPlayerSku } from './providers/tcgplayer-sku';
import type {
  ConditionCode,
  ConditionQuotes,
  ListingSample,
  PriceBasis,
  PriceQuote,
  PriceRef,
  SaleSample,
} from './types';
import { round2 } from './util';

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
 * How fast a sale stops being evidence. A sale today is one full vote; one
 * this many days old is half a vote, and it keeps halving — a month old is a
 * quarter, two months a sixteenth. Anything much older than a month is
 * background, not a price: the dealer's rule that an old sale must not set
 * the price when the live listings say otherwise.
 */
export const SALE_HALF_LIFE_DAYS = 14;

/**
 * A TCGplayer SKU market with no sale in its month window is at least this
 * old — it is treated as a sale this many days ago (a quarter of a vote).
 */
export const STALE_MARKET_AGE_DAYS = 30;

/**
 * Asks are wishes, not sales: a listing that has not sold yet sits, by
 * definition, at or above the clearing price. The cheapest live ask counts
 * at this fraction of its price. Where cards do have fresh solds, the sold
 * price sits at 0.9–1.05x the cheapest ask (measured across 16 condition
 * rungs of six cards on 2026-09-22).
 */
export const ASK_DISCOUNT = 0.9;

/** The asks carry the weight of one fresh sale once this many are listed. */
const ASK_FULL_WEIGHT_AT = 3;

/**
 * Asks carry full weight from this price up and proportionally less below,
 * and the "never above the cheapest ask" cap only applies from here. Under
 * a couple of dollars, listings are shipping-and-bulk noise: a $0.02 Bede
 * behind $1.31 shipping is not what a $0.18 common sells for (an audit of
 * 48 cards had every sub-$1 common capped at a bulk ask before this).
 */
export const ASK_TRUST_FROM = 2;

/**
 * Bad-data tripwire: a thin sold sample this far below a >$50 ask floor is
 * not this card being sold at market (a lot piece, a fake "sold"). It is
 * discarded rather than blended — a bogus $250 1st-ed Charizard sale must
 * not drag a $4,300 card down to $2,000 through the blend.
 */
const BAD_SALE_BELOW_ASK = 0.4;

const DAY_MS = 86_400_000;

/**
 * A seller's own words saying the copy is not the plain product: another
 * language, a graded slab, a proxy, a signed card. TCGplayer files a custom
 * (photo) listing under the product the seller picked, so a Spanish copy sits
 * under the English product with language "English" — only the seller's title
 * says otherwise ("Mega Charizard X ex 125/094 Spanish see pics", $479.99 under
 * English copies selling at $640–670; "Mega Char PSA 10", $2,149.99, in the
 * same list). Applied to custom listings and photo-listing sales only;
 * standard entries carry the product name.
 */
export const NOT_THE_PRODUCT =
  /\b(spanish|espa[ñn]ol|japanese|japan|jpn|german|deutsch|french|fran[cç]ais|italian|italiano|portuguese|portugu[eê]s|korean|chinese|thai|indonesian|russian|latam|latin american|slab|slabbed|graded|proxy|signed|autographed?)\b|\b(psa|bgs|cgc|sgc|ace|tag)\s*\d{1,2}(?:\.5)?\b/i;

const notTheProduct = (e: { custom?: boolean; title?: string }): boolean =>
  e.custom === true && NOT_THE_PRODUCT.test(e.title ?? '');

/**
 * Which live asks may set the floor and the cap.
 *
 * Custom listings — a seller's own photos, title and description — are where
 * the copy that is NOT the product lives (the Spanish Charizard above), so
 * they never set the floor while a standard listing exists, and never when
 * their own words name another language. They still show in the asks list.
 * And a single ask far below both fresh sales and the next ask is a mislisted
 * or underpriced copy about to vanish, not the market: skipped too.
 */
export function askPool<T extends { price: number; custom?: boolean; title?: string }>(
  eligible: T[],
  soldLevel: number | null,
  soldWeight: number,
): T[] {
  const honest = eligible.filter((l) => !notTheProduct(l));
  const standard = honest.filter((l) => !l.custom);
  let pool = standard.length ? standard : honest;
  const byPrice = [...pool].sort((a, b) => a.price - b.price);
  if (
    byPrice.length >= 2 &&
    soldLevel != null &&
    soldWeight >= 1 &&
    byPrice[0].price < soldLevel * 0.75 &&
    byPrice[0].price < byPrice[1].price * 0.8
  ) {
    pool = pool.filter((l) => l !== byPrice[0]);
  }
  return pool;
}

/**
 * Everything one quote is computed from, fetched once and kept apart from
 * the maths so a quote can be replayed from a fixture (tests/pricing).
 */
export interface QuoteEvidence {
  /** TCGplayer's own market for this exact printing × condition, if it has one. */
  market: SkuMarket | null;
  /** Solds in this exact condition, newest first (any printing). */
  exact: SaleSample[];
  /** Solds across all conditions, newest first; only consulted when `exact` holds none of this printing. */
  mixed: SaleSample[];
  /** Live asks for the product, cheapest first (any condition/printing). */
  listings: ListingRow[];
  /** tcgcsv price rows for this product, one per printing. */
  rows: CsvPrice[];
  /** The clock sale ages are measured against. */
  now: number;
}

/** A quote plus what the ladder needs to weigh it against the other conditions. */
export interface Priced {
  quote: PriceQuote;
  /** Evidence weight: recency-weighted solds plus asks. 0 = nothing of its own. */
  weight: number;
  /** True when the price rests on this condition's own market, solds or asks. */
  anchor: boolean;
}

export function saleAgeDays(date: string, now: number): number {
  const t = Date.parse(date);
  // An unparseable date is treated as a fortnight old: still evidence, not a full vote.
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY_MS) : SALE_HALF_LIFE_DAYS;
}

export const recencyWeight = (ageDays: number): number => 0.5 ** (ageDays / SALE_HALF_LIFE_DAYS);

/**
 * Median where each value counts `weight` times: the value at which half the
 * total weight is reached. With equal weights this is the ordinary median
 * (an exact tie between two middle values averages them). Items must be
 * non-empty.
 */
export function weightedMedian(items: { value: number; weight: number }[]): number {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, i) => sum + i.weight, 0) / 2;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].weight;
    if (acc > half + 1e-9) return sorted[i].value;
    if (Math.abs(acc - half) <= 1e-9) {
      return i + 1 < sorted.length ? (sorted[i].value + sorted[i + 1].value) / 2 : sorted[i].value;
    }
  }
  return sorted[sorted.length - 1].value;
}

/**
 * The cheapest live ask by item price — shipping excluded, because the sold
 * prices it is compared with exclude shipping too. A lone ask under a TENTH
 * of the next one is a broken or troll listing, not the market, and is
 * skipped. Anything less extreme is a real listing a customer could buy:
 * Mewtwo LV.X NM asked $185 under a row of $399–450 wishes, Tyranitar
 * reverse holo MP $199.99 under a $600 one, and both were the market.
 */
export function askFloorOf(listings: { price: number }[]): number | null {
  const ps = listings.map((l) => l.price).sort((a, b) => a - b);
  if (!ps.length) return null;
  return ps.length >= 2 && ps[0] < ps[1] / 10 ? ps[1] : ps[0];
}

/**
 * Weighted average of price levels in ratio terms (log space). A $125 sale
 * under $858 asks is a 7x gap, not a $733 one; averaging the ratios keeps a
 * lone wish from dragging a fresh sale up by hundreds of dollars, while
 * levels within a few percent of each other blend to the same number either
 * way. Falls back to the plain weighted mean if a level is not positive.
 */
export function blendLevels(levels: { value: number; weight: number }[]): number {
  const total = levels.reduce((sum, l) => sum + l.weight, 0);
  if (levels.every((l) => l.value > 0)) {
    return Math.exp(levels.reduce((sum, l) => sum + l.weight * Math.log(l.value), 0) / total);
  }
  return levels.reduce((sum, l) => sum + l.weight * l.value, 0) / total;
}

const fmtAge = (days: number): string =>
  days < 1 ? 'today' : days < 2 ? 'yesterday' : `${Math.round(days)} days ago`;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function variantMatcher(subType: string): (variant: string) => boolean {
  const wantVariant = norm(subType);
  // "Market" is the placeholder sub-type used when we couldn't load the real
  // printing list — accept sales of any variant in that case.
  return (v: string) => !wantVariant || wantVariant === 'market' || norm(v) === wantVariant;
}

/**
 * Drop sales that sit far outside the recent price cluster.
 *
 * mpapi hands back the last five solds per condition, but a quote only
 * medians the most recent N of them (default 3). A median of three survives
 * one bad number and no more — so two deliberate undercuts in a row (or a lot
 * piece, or a mispriced listing) becomes the price. Judging each sale against
 * the median of the FULL window uses evidence that was already fetched.
 *
 * The band is deliberately wide (0.4x to 3x): it is there to reject sales that
 * are not really this card being sold at market, not to smooth normal drift. A
 * genuine crash of up to 60% inside one window still passes through.
 */
export function withoutOutliers<T>(sales: T[], valueOf: (s: T) => number): T[] {
  if (sales.length < 4) return sales; // too little context to call anything an outlier
  const centre = weightedMedian(sales.map((s) => ({ value: valueOf(s), weight: 1 })));
  if (!(centre > 0)) return sales;
  const kept = sales.filter((s) => valueOf(s) >= centre * 0.4 && valueOf(s) <= centre * 3);
  return kept.length >= 2 ? kept : sales;
}

/**
 * Stage 1 — weigh the evidence for one condition.
 *
 * 0. TCGplayer's own market for this exact printing × condition, when it has
 *    one: the sold level, weighed by the sales behind it (the daily buckets
 *    say when copies last sold; none in the window ⇒ a month old at best).
 * 1. Else solds in this exact condition+printing, newest first, outliers
 *    dropped, the last N taken; each carries a recency weight (1 today,
 *    halving every SALE_HALF_LIFE_DAYS); the level is their weighted median.
 * 2. Else the mixed-condition pool normalised to NM and scaled, at half
 *    weight (indirect evidence).
 * 3. The cheapest live ask in this condition+printing carries up to the
 *    weight of one fresh sale.
 */
export interface Assessment {
  params: PriceRef;
  soldLevel: number | null;
  soldWeight: number;
  salesUsed: number;
  newestSaleDays: number | null;
  /** The sold level is this condition's own (TCGplayer's SKU market or exact solds), not the mixed pool. */
  exactUsed: boolean;
  source: PriceQuote['source'];
  shown: SaleSample[];
  marketPrice: number | null;
  /** TCGplayer's published product market price as-is (null when missing or the 100000 placeholder). */
  publishedMarket: number | null;
  marketNote?: string;
  listedLow: number | null;
  listedMid: number | null;
  listings: ListingSample[];
  askFloor: number | null;
  askWeight: number;
  /** Cheapest delivered ask (price + shipping), null when under ASK_TRUST_FROM. */
  askCap: number | null;
  /** How many asks the floor rests on (custom/foreign/lone-underpriced ones excluded). */
  askCount: number;
  /** `tcg_market` rungs: the day of the bucket the market came from. */
  asOf?: string;
}

export function assess(params: PriceRef, ev: QuoteEvidence): Assessment {
  const { condition } = params;
  const subType = params.subType ?? '';
  const n = Math.min(Math.max(params.salesCount || 3, 1), 10);
  const variantOk = variantMatcher(subType);
  const weightOf = (s: SaleSample) => recencyWeight(saleAgeDays(s.date, ev.now));
  const newestOf = (sales: SaleSample[]) => Math.min(...sales.map((s) => saleAgeDays(s.date, ev.now)));

  let soldLevel: number | null = null;
  let soldWeight = 0;
  let salesUsed = 0;
  let newestSaleDays: number | null = null;
  let source: PriceQuote['source'] = 'none';
  let exactUsed = false;
  let shown: SaleSample[] = [];
  let asOf: string | undefined;

  const exact = ev.exact.filter(
    (s) => variantOk(s.variant) && s.condition === CONDITION_NAME[condition] && !notTheProduct(s),
  );

  if (ev.market && ev.market.market > 0) {
    // ── 0. TCGplayer's own market for this SKU is the sold level ───────────
    // Its age is the age of the sales behind it: each of the newest N units
    // sold in the window is a vote that fades like any other sale.
    const units: number[] = [];
    for (const day of ev.market.sales ?? []) {
      for (let i = 0; i < day.quantity && units.length < n; i++) units.push(saleAgeDays(day.date, ev.now));
    }
    soldLevel = ev.market.market;
    soldWeight = units.length
      ? units.reduce((sum, age) => sum + recencyWeight(age), 0)
      : recencyWeight(STALE_MARKET_AGE_DAYS);
    salesUsed = ev.market.sold;
    newestSaleDays = units.length ? Math.min(...units) : STALE_MARKET_AGE_DAYS;
    source = 'tcg_market';
    exactUsed = true;
    asOf = ev.market.asOf;
    shown = exact;
  } else if (exact.length) {
    // ── 1. Solds in this exact condition — a real lookup, not an estimate ──
    // Judge against the whole window, then price off the most recent survivors.
    const take = withoutOutliers(exact, (s) => s.price).slice(0, n);
    soldLevel = weightedMedian(take.map((s) => ({ value: s.price, weight: weightOf(s) })));
    soldWeight = take.reduce((sum, s) => sum + weightOf(s), 0);
    salesUsed = take.length;
    newestSaleDays = newestOf(take);
    source = 'sales';
    exactUsed = true;
    shown = exact;
  } else {
    // ── 2. No sales in this exact condition: normalize recent sales to NM
    //    using the condition factors, then scale to the requested condition.
    const usable = ev.mixed.filter((s) => variantOk(s.variant) && !notTheProduct(s));
    shown = usable;
    const known = usable.filter((s) => CODE_BY_NAME[s.condition]);
    if (known.length >= 2) {
      // Outliers here are judged on NM-equivalent value, since the pool mixes
      // conditions and a cheap Damaged sale is not an outlier by itself.
      const nmEquivalent = (s: SaleSample) => s.price / FACTOR[CODE_BY_NAME[s.condition]];
      const take = withoutOutliers(known, nmEquivalent).slice(0, Math.max(n, 5));
      soldLevel = weightedMedian(
        take.map((s) => ({ value: nmEquivalent(s) * FACTOR[condition], weight: weightOf(s) })),
      );
      // Other conditions' sales are indirect evidence for this one: half weight.
      soldWeight = take.reduce((sum, s) => sum + weightOf(s), 0) / 2;
      salesUsed = take.length;
      newestSaleDays = newestOf(take);
      source = 'sales_adj';
    }
  }

  // ── 3. Product market price for the printing (sanitised) ─────────────────
  let marketPrice: number | null = null;
  let publishedMarket: number | null = null;
  let marketNote: string | undefined;
  let listedLow: number | null = null;
  let listedMid: number | null = null;
  const wantVariant = norm(subType);
  const row =
    ev.rows.find((r) => norm(r.subTypeName) === wantVariant) ?? ev.rows.find((r) => r.marketPrice != null);
  if (row) {
    const sane = saneMarketPrice(row);
    marketPrice = sane.price;
    publishedMarket =
      row.marketPrice != null && row.marketPrice > 0 && row.marketPrice !== 100000 ? row.marketPrice : null;
    // Drop TCGplayer's 100000 "no listings" placeholder (see saneMarketPrice).
    listedLow = row.lowPrice != null && row.lowPrice !== 100000 ? row.lowPrice : null;
    listedMid = row.midPrice != null && row.midPrice !== 100000 ? row.midPrice : null;
    if (sane.adjusted) {
      marketNote = `TCGplayer's published market price ($${row.marketPrice}) looks stale for this printing — using current listing prices instead`;
    }
  }

  // Live asks in this exact condition+printing (cheapest first). Solds say
  // what buyers paid, asks say the current competition. The 100000 placeholder
  // / troll listings are dropped so they can't set the floor or show as a
  // real "current ask".
  const eligible = ev.listings.filter(
    (l) => variantOk(l.variant) && l.condition === CONDITION_NAME[condition] && l.price < 100000,
  );
  const listings: ListingSample[] = eligible.slice(0, 5);
  // The asks the maths may rest on — see askPool.
  const pool = askPool(eligible, soldLevel, soldWeight);
  const askFloor = askFloorOf(pool);
  const askWeight =
    askFloor == null
      ? 0
      : (Math.min(pool.length, ASK_FULL_WEIGHT_AT) / ASK_FULL_WEIGHT_AT) *
        Math.min(1, askFloor / ASK_TRUST_FROM);
  // What a customer would actually pay for the cheapest copy, shipping in.
  const delivered = askFloorOf(pool.map((l) => ({ price: l.price + (l.shipping ?? 0) })));
  const askCap = delivered != null && delivered >= ASK_TRUST_FROM ? delivered : null;

  return {
    params,
    soldLevel,
    soldWeight,
    salesUsed,
    newestSaleDays,
    exactUsed,
    source,
    shown,
    marketPrice,
    publishedMarket,
    marketNote,
    listedLow,
    listedMid,
    listings,
    askFloor,
    askWeight,
    askCap,
    askCount: pool.length,
    asOf,
  };
}

/**
 * An independent estimate of what this condition should be worth, for the
 * bad-data tripwire: the other conditions' own sold levels scaled to this
 * one (their evidence weight deciding), or failing that TCGplayer's
 * published product market price. Null when there is neither.
 *
 * Why the other conditions and not the market stat alone: on a 1st-Ed
 * Charizard the bogus $250 "sale" had ALSO become TCGplayer's market price,
 * but the LP/MP copies still sold in the thousands.
 */
export function corroborationFor(a: Assessment, others: Assessment[]): number | null {
  const factor = FACTOR[a.params.condition];
  const solds = others
    .filter((o) => o.exactUsed && o.soldLevel != null)
    .map((o) => ({
      value: (o.soldLevel as number) / FACTOR[o.params.condition],
      weight: Math.max(o.soldWeight, 1e-6),
    }));
  if (solds.length) return weightedMedian(solds) * factor;
  return a.publishedMarket == null ? null : a.publishedMarket * factor;
}

/**
 * Stage 2 — the price: the weight-blended sold and ask levels, never above
 * the cheapest delivered ask. Fresh solds keep the say; as they age the asks
 * take over and the source turns to `ask`. Nothing at all → TCGplayer's
 * product market price scaled by condition.
 */
export function finish(a: Assessment, corroboration: number | null): Priced {
  const { productId, condition } = a.params;
  const subType = a.params.subType ?? '';
  let { soldLevel, soldWeight, salesUsed, newestSaleDays, source, askWeight, askCap } = a;
  const { askFloor, marketPrice, listings, askCount } = a;
  const fromTcg = a.source === 'tcg_market';

  // A single listing far above what the other conditions sell for is one
  // seller's wish (Tyrogue HP: one ask at $4,321 on a $12 card). Ignore it
  // rather than let it lead a rung whose own solds have gone stale.
  let wishNote: string | undefined;
  if (askFloor != null && askCount === 1 && corroboration != null && askFloor > corroboration * 3) {
    wishNote = `the one live ${condition} ask ($${round2(askFloor)}) is far above what other conditions sell for — ignored`;
    askWeight = 0;
    askCap = null;
  }

  // Sanity vs the live ask floor. A thin sold sample sitting far below the
  // cheapest current asks is almost always bad data — a mispriced/fake
  // "sold" or a lot part. A 1st-Ed Charizard asking $4,300 NM does not sell
  // for $250. Discard it outright; blending would only halve the damage.
  // Independent evidence has to agree that the sale is absurd, though: a
  // real $125 sale under $858 wishes (Tyranitar Expedition reverse holo,
  // whose MP/HP/DM copies sell for $40–150) is the asks being wrong.
  let guardNote: string | undefined;
  if (
    soldLevel != null &&
    askFloor != null &&
    askFloor > 50 &&
    salesUsed <= 2 &&
    soldLevel < askFloor * BAD_SALE_BELOW_ASK &&
    (corroboration == null || soldLevel < corroboration * BAD_SALE_BELOW_ASK)
  ) {
    guardNote = `ignored a lone $${round2(soldLevel)} figure far below the $${round2(askFloor)} live asks — priced at the current ask level`;
    soldLevel = null;
    soldWeight = 0;
    salesUsed = 0;
    newestSaleDays = null;
  }

  // The ask level: the cheapest ask, discounted because a listing nobody
  // has bought is at or above the clearing price — but never discounted
  // below what the card actually sold for. When the last sale met the ask
  // (Tyranitar NM: sold $139.99, asks from $140) the ask is a real price and
  // the two agree instead of the discount dragging both down 5%.
  const askLevel =
    askFloor == null || askWeight <= 0
      ? null
      : Math.max(askFloor * ASK_DISCOUNT, Math.min(askFloor, soldLevel ?? 0));

  // An ask that a fresh sale contradicts is not the market: three sellers
  // asking $858 the day after a $125 sale are wishing. The asks' weight is
  // cut by how far the solds sit below them, scaled by how fresh those solds
  // are — stale solds carry little weight and so leave the asks' say intact,
  // which is the whole point.
  if (soldLevel != null && askLevel != null && askLevel > 0) {
    const freshness = Math.min(1, soldWeight);
    askWeight *= 1 - freshness * (1 - Math.min(1, soldLevel / askLevel));
  }

  let price: number | null = null;
  let estimated = false;
  let blendNote: string | undefined;
  const weight = soldWeight + askWeight;
  if (soldLevel != null || askLevel != null) {
    const levels: { value: number; weight: number }[] = [];
    if (soldLevel != null) levels.push({ value: soldLevel, weight: soldWeight });
    if (askLevel != null) levels.push({ value: askLevel, weight: askWeight });
    price = round2(blendLevels(levels));
    // Never above what the card can be bought for right now. A dealer cannot
    // list a Damaged copy at $178 when the cheapest Damaged ask is $21.95 —
    // the customer can simply buy that one instead.
    const capped = askCap != null && price > askCap;
    if (capped) price = round2(askCap as number);
    // Asks carry the price when the solds are less than half a fresh sale's
    // worth and the asks outweigh them and sit materially ABOVE the solds —
    // that is the estimate worth flagging. Asks below the solds are a cap,
    // not a guess: the card can be bought for that, so the number is exact.
    const askLed =
      soldLevel == null ||
      (askWeight > soldWeight &&
        soldWeight < 0.5 &&
        (askLevel as number) - soldLevel >= soldLevel * 0.05);
    const what = fromTcg ? `TCGplayer's ${condition} market` : plural(salesUsed, `${condition} sold`);
    const age = newestSaleDays == null ? '' : fromTcg && newestSaleDays >= STALE_MARKET_AGE_DAYS ? ' (no sale in the last month)' : ` (newest ${fmtAge(newestSaleDays)})`;
    if (soldLevel == null) {
      source = 'ask';
      blendNote = `no ${condition} solds of this printing on record — priced just under the cheapest live ask ($${round2(askFloor as number)})`;
    } else if (askLed) {
      source = 'ask';
      blendNote = `${what}${age} at $${round2(soldLevel)} — too old or too few to outweigh the live ${condition} asks from $${round2(askFloor as number)}`;
    } else if (capped) {
      blendNote = `${what}${age} at $${round2(soldLevel)} sits above the cheapest live ${condition} ask — held at that ask ($${round2(askCap as number)}${askCap !== askFloor ? ' delivered' : ''}) so it can't be beaten online`;
    } else if (askLevel != null && Math.abs(price - soldLevel) >= soldLevel * 0.05) {
      blendNote = `${what}${age} at $${round2(soldLevel)}, live ${condition} asks from $${round2(askFloor as number)} — blended`;
    }
    estimated = !TRUSTED.has(source) || source === 'ask';
  } else if (marketPrice != null) {
    price = round2(marketPrice * FACTOR[condition]);
    source = condition === 'NM' ? 'market' : 'market_adj';
    estimated = condition !== 'NM';
  }

  const basis: PriceBasis = {
    soldLevel: soldLevel == null ? null : round2(soldLevel),
    soldWeight: round2(soldWeight),
    newestSaleDays: newestSaleDays == null ? null : Math.round(newestSaleDays),
    askFloor: askFloor == null ? null : round2(askFloor),
    askWeight: round2(askWeight),
    askCap: askCap == null ? null : round2(askCap),
  };

  return {
    quote: {
      productId,
      subType,
      condition,
      price,
      source,
      estimated,
      salesUsed,
      marketPrice,
      sales: a.shown.slice(0, 5),
      url: `https://www.tcgplayer.com/product/${productId}`,
      asOf: a.asOf,
      note: guardNote ?? blendNote ?? wishNote ?? a.marketNote,
      listings,
      listedLow: a.listedLow,
      listedMid: a.listedMid,
      basis,
    },
    weight,
    anchor: price != null && (a.exactUsed || askWeight > 0),
  };
}

/** One condition on its own: the tripwire is corroborated by the product market price only. */
export function priceFromEvidence(params: PriceRef, ev: QuoteEvidence): Priced {
  const a = assess(params, ev);
  return finish(a, corroborationFor(a, []));
}

/**
 * All five conditions from evidence already fetched: each rung's tripwire is
 * corroborated by the other rungs' sold levels, then the ladder is assembled.
 */
export function ladderFromEvidence(
  base: Omit<PriceRef, 'condition'>,
  evidence: Record<ConditionCode, QuoteEvidence>,
): ConditionQuotes {
  const assessed = ALL_CONDITIONS.map((condition) => assess({ ...base, condition }, evidence[condition]));
  const priced = assessed.map((a) =>
    finish(
      a,
      corroborationFor(
        a,
        assessed.filter((o) => o !== a),
      ),
    ),
  );
  return assembleLadder(priced);
}

/**
 * Cross-check the conditions against each other.
 *
 * A condition with its own evidence — TCGplayer's market for that SKU, solds
 * in that exact condition, or live asks — keeps its own price; it is never
 * overwritten by a figure scaled from another rung (that once priced Mewtwo
 * LV.X LP at $378 "from the NM ask" while five real LP solds and a dozen LP
 * asks said ~$100). Conditions with nothing of their own are scaled from the
 * NEAREST anchored rung by factor ratio and clamped between their anchored
 * neighbours: vintage ladders are steep (Abra Shadowless: NM $10.65 → HP
 * $1.08), so "nearest rung" beats "NM × factor" by a wide margin.
 *
 * Then: with no TCGplayer rung at all, inversions are pooled (isotonic
 * regression, see enforceMonotonic). With TCGplayer rungs present, TCGplayer's
 * own numbers are never pooled or "corrected" — matching tcgplayer.com is the
 * definition of accurate — but a rung of OURS can't sit above a cleaner
 * TCGplayer grade. Last, nothing above what it can be bought for: a cleaner
 * grade's cheapest listing bounds every grade below it.
 */
export function assembleLadder(priced: Priced[]): ConditionQuotes {
  const anchors = priced.filter((p) => p.anchor && p.quote.price != null);
  if (anchors.length) {
    const salesUsed = anchors.reduce((a, p) => a + p.quote.salesUsed, 0);
    priced.forEach((p, i) => {
      if (p.anchor) return;
      const q = p.quote;
      const above = priced.slice(0, i).reverse().find((o) => o.anchor && o.quote.price != null);
      const below = priced.slice(i + 1).find((o) => o.anchor && o.quote.price != null);
      const ref = (above ?? below) as Priced;
      let price = ((ref.quote.price as number) * FACTOR[q.condition]) / FACTOR[ref.quote.condition];
      // Keep a derived rung between its anchored neighbours: the condition
      // multipliers are a rule of thumb, the neighbours are evidence.
      if (above) price = Math.min(price, above.quote.price as number);
      if (below) price = Math.max(price, below.quote.price as number);
      q.price = round2(price);
      q.estimated = true;
      q.salesUsed = ref.quote.source === 'tcg_market' ? 0 : salesUsed;
      if (ref.quote.source === 'tcg_market') {
        q.source = 'scaled';
        q.note = `no TCGplayer market for ${q.condition} — scaled from its ${ref.quote.condition} market`;
      } else {
        q.source = 'sales_adj';
        q.note = `no recent ${q.condition} solds of this printing — scaled from this printing's price in other conditions`;
      }
      p.weight = 0.5;
    });
  }

  const hasTcg = priced.some((p) => p.quote.source === 'tcg_market' && p.quote.price != null);
  if (!hasTcg) {
    // Reconcile rungs that still contradict each other. Runs after the
    // anchoring above so it sees the final ladder, derived rungs included.
    enforceMonotonic(priced);
  } else {
    // TCGplayer's rungs stand as published. Ours may not sit above a cleaner
    // TCGplayer grade — a played copy is never worth more than a clean one.
    let ceiling = Infinity;
    for (const p of priced) {
      const q = p.quote;
      if (q.price == null) continue;
      if (q.source === 'tcg_market') {
        ceiling = q.price;
        continue;
      }
      if (q.price > ceiling) {
        q.price = round2(ceiling);
        q.note = `held under TCGplayer's price for a cleaner grade ($${round2(ceiling)})`;
      }
    }
  }

  // Last: nothing above what it can be bought for. A rung's own cheapest
  // delivered listing caps it, and a floor on a cleaner grade bounds every
  // grade below it — if Near Mint can be had for $100, Lightly Played is
  // not $110. Only listings propagate down, so an inverted TCGplayer ladder
  // (which is theirs to publish) is left alone unless a real copy is cheaper.
  let ceiling = Infinity;
  let ceilingFrom: ConditionCode | null = null;
  for (const p of priced) {
    const q = p.quote;
    if (q.price == null) continue;
    const floor = q.basis?.askCap ?? Infinity;
    const held = Math.min(q.price, floor, ceiling);
    if (held < q.price) {
      q.price = round2(held);
      q.note =
        held === floor
          ? `held at the cheapest live ${q.condition} ask ($${round2(floor)}) — it can't be listed for more than it can be bought for`
          : `held under the ${ceilingFrom} price — a cleaner copy can be bought for $${round2(ceiling)}`;
    }
    if (floor < ceiling) {
      ceiling = floor;
      ceilingFrom = q.condition;
    }
  }
  return Object.fromEntries(priced.map((p) => [p.quote.condition, p.quote])) as ConditionQuotes;
}

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
 * nothing else moves. Rungs backed by fresh solds and live asks pull harder;
 * derived rungs (weight 0.5) and stale ones bend. An already-monotone ladder
 * is left completely untouched — so this only ever fires on data that was
 * self-contradictory to begin with.
 *
 * Pooling to equal prices is the correct outcome, not a cop-out: it says the
 * sales data cannot tell those grades apart, which for a $0.20 common is true.
 *
 * Used ONLY for ladders built from solds. TCGplayer's own per-condition
 * markets are never pooled — they are shown exactly as TCGplayer shows them.
 */
export function enforceMonotonic(priced: Priced[]): void {
  interface Block {
    weighted: number; // sum of weight * price
    weight: number;
    members: PriceQuote[];
  }
  const blocks: Block[] = [];
  for (const p of priced) {
    const q = p.quote;
    if (q.price == null) continue;
    const weight = p.weight > 0 ? p.weight : 0.5;
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
      // A material move deserves the pooling note over whatever came before.
      const before = q.price as number; // members only ever hold priced rungs
      const moved = Math.abs(pooled - before) >= before * 0.05;
      q.price = pooled;
      if (moved || !q.note) {
        q.note =
          'levelled with neighbouring conditions — their recent solds disagreed on which grade was worth more';
      }
    }
  }
}

export type Pricer = ReturnType<typeof createPricer>;

export function createPricer(
  ctx: PricingCtx,
  deps: { csv: TcgCsv; live: TcgLive; sku: TcgPlayerSku },
) {
  const { csv, live, sku } = deps;
  const now = () => (typeof ctx.now === 'function' ? ctx.now() : Date.now());

  async function rowsFor(params: Omit<PriceRef, 'condition'>): Promise<CsvPrice[]> {
    const categoryId = params.categoryId ?? null;
    const groupId = params.groupId ?? null;
    if (categoryId == null || groupId == null) return [];
    try {
      return (await csv.prices(categoryId, groupId)).filter((r) => r.productId === params.productId);
    } catch (err) {
      console.error('[pricing] market price lookup failed:', err);
      return [];
    }
  }

  /**
   * Fetch one condition's evidence. TCGplayer's own SKU market comes first
   * (one paced call covers every condition of the product and is shared
   * through the cache); the sold feeds are only consulted when it has none.
   */
  async function gather(params: PriceRef, at: number, shared?: { rows: CsvPrice[]; listings: ListingRow[] }): Promise<QuoteEvidence> {
    const { productId, condition } = params;
    const subType = params.subType ?? '';
    const variantOk = variantMatcher(subType);
    const markets = await sku.skuMarkets(productId);
    const market = sku.skuMarketFor(markets, subType, CONDITION_NAME[condition]);
    let exact: SaleSample[] = [];
    let mixed: SaleSample[] = [];
    if (!(market && market.market > 0)) {
      exact = (await live.latestSales(productId, CONDITION_ID[condition])) ?? [];
      const hasExact = exact.some((s) => variantOk(s.variant) && s.condition === CONDITION_NAME[condition]);
      mixed = hasExact ? [] : ((await live.latestSales(productId)) ?? []);
    }
    const rows = shared?.rows ?? (await rowsFor(params));
    const listings = shared?.listings ?? ((await live.currentListings(productId)) ?? []);
    return { market, exact, mixed, listings, rows, now: at };
  }

  async function quote(params: PriceRef): Promise<PriceQuote> {
    return priceFromEvidence(params, await gather(params, now())).quote;
  }

  /**
   * Quotes for every condition in one go, cross-checked against each other.
   * The per-SKU market, product market and listings are fetched once per
   * product; the condition-filtered sold feeds run in parallel for the
   * conditions TCGplayer has no market for.
   */
  async function quoteAll(params: Omit<PriceRef, 'condition'>): Promise<ConditionQuotes> {
    const at = now();
    const [rows, listings] = await Promise.all([
      rowsFor(params),
      (async () => (await live.currentListings(params.productId)) ?? [])(),
    ]);
    const gathered = await Promise.all(
      ALL_CONDITIONS.map((condition) => gather({ ...params, condition }, at, { rows, listings })),
    );
    const evidence = Object.fromEntries(
      ALL_CONDITIONS.map((c, i) => [c, gathered[i]]),
    ) as Record<ConditionCode, QuoteEvidence>;
    return ladderFromEvidence(params, evidence);
  }

  return { quote, quoteAll };
}
