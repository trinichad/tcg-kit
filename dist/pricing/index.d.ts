export { C as CATEGORY_ID, a as INDEX_GAMES, I as IndexGame } from '../catalogues-B2qHmLL2.js';

type Game = 'pokemon' | 'magic' | 'yugioh' | 'lorcana' | 'onepiece' | 'dragonball' | 'sports';
type ConditionCode = 'NM' | 'LP' | 'MP' | 'HP' | 'DM';
declare const CONDITIONS: {
    value: ConditionCode;
    label: string;
}[];
/** Graded-slab info read off the label (PSA / BGS / CGC / SGC / TAG / ACE). */
interface GradedInfo {
    grader: string;
    grade: string;
    cert?: string;
}
declare const GRADERS: readonly ["PSA", "CGC", "BGS", "SGC", "TAG", "ACE"];
declare const GRADES: readonly ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6", "5", "4", "3", "2", "1"];
interface SubTypePrice {
    name: string;
    marketPrice: number | null;
}
/** A TCGplayer product a card was matched to. */
interface ProductMatch {
    productId: number;
    name: string;
    categoryId: number | null;
    groupId: number | null;
    groupName: string;
    /** Set abbreviation ("OP09", "SVI") when known — exact-match signal. */
    groupCode?: string;
    number: string;
    rarity: string;
    imageUrl: string;
    url: string;
    subTypes: SubTypePrice[];
    score: number;
}
interface ResolveRequestCard {
    /** Binder-pocket id in the source app; optional here, echoed back on the result. */
    cell?: number;
    game: string;
    name: string;
    setName?: string;
    setCode?: string;
    number?: string;
    /** As read off the card ("Japanese", "Chinese", …) — steers which
     * TCGplayer product lines are searched (e.g. Pokemon Japan). */
    language?: string;
    /** Printing / art variant ("special alternate art", "1st edition holo") —
     * nudges ranking between base and alt-art sibling products. */
    printing?: string;
}
interface ResolveResult {
    cell: number;
    status: 'matched' | 'uncertain' | 'none';
    best: ProductMatch | null;
    candidates: ProductMatch[];
    note?: string;
}
interface SaleSample {
    date: string;
    price: number;
    condition: string;
    variant: string;
    /** PriceCharting rows: the sold listing's title and link. TCGplayer photo listings: the seller's own title. */
    title?: string;
    url?: string;
    /** TCGplayer: sold from a custom (photo) listing — the seller's own description, not the plain product. */
    custom?: boolean;
}
/** A live TCGplayer listing (current ask). */
interface ListingSample {
    price: number;
    shipping: number | null;
    condition: string;
    variant: string;
    quantity: number;
    /** A custom (photo) listing: the seller's own title/description, which may not be the plain product. */
    custom?: boolean;
    /** The seller's own words on a custom listing (title + description, tags stripped). */
    title?: string;
}
/** Per-condition quotes, prefetched so condition changes need no request. */
type ConditionQuotes = Partial<Record<ConditionCode, PriceQuote>>;
interface PriceQuote {
    productId: number;
    subType: string;
    condition: ConditionCode;
    price: number | null;
    /**
     * tcg_market – TCGplayer's OWN market for this exact printing × condition
     *              (infinite-api price history). Exact, never "corrected".
     * sales      – median of recent sold listings in this exact condition+printing
     * sales_adj  – estimated from recent sales in other conditions
     * scaled     – scaled from the nearest TCGplayer per-condition market rung
     * market     – TCGplayer market price (NM)
     * market_adj – market price adjusted for condition
     * graded     – per-grade market value from eBay solds (PriceCharting)
     * ebay       – median of current eBay live ASKS (fallback when no sold guide)
     * ask        – current TCGplayer ask level: the solds (or TCGplayer's
     *              market) were too old or too few to outweigh the live asks,
     *              or looked like bad data
     */
    source: 'tcg_market' | 'sales' | 'sales_adj' | 'scaled' | 'market' | 'market_adj' | 'graded' | 'ebay' | 'ask' | 'none';
    estimated: boolean;
    salesUsed: number;
    marketPrice: number | null;
    sales: SaleSample[];
    url: string;
    /** `tcg_market` rungs: the day of the bucket the market came from (YYYY-MM-DD). */
    asOf?: string;
    /** Graded quotes: which price-guide row was used (e.g. "PSA 10"). */
    gradeLabel?: string;
    /** The full per-grade value ladder from the price guide (label → USD). */
    grades?: Record<string, number>;
    sourceUrl?: string;
    note?: string;
    /** Cheapest live TCGplayer asks in this exact condition+printing. */
    listings?: ListingSample[];
    /** Live listing range for the whole printing (all conditions): low / mid. */
    listedLow?: number | null;
    listedMid?: number | null;
    /** Set when the slab's cert was verified against PSA's records. */
    psa?: PsaVerify;
    /** How a raw quote was put together (absent on graded/eBay quotes). */
    basis?: PriceBasis;
}
/**
 * The evidence behind a raw price. Solds fade with age (a sale today weighs
 * 1, halving every 14 days) and are blended with the cheapest live ask, so
 * a consumer can say how old the sales are and what the market is asking now.
 */
interface PriceBasis {
    /** The sold level: TCGplayer's own market for the SKU, or the recency-weighted median of the solds used. */
    soldLevel: number | null;
    /** Total recency weight of the solds behind it (3 fresh sales ≈ 3, one month-old sale ≈ 0.25). */
    soldWeight: number;
    /** Age in days of the newest sale behind the sold level. */
    newestSaleDays: number | null;
    /** Cheapest live ask in this condition+printing (item price, no shipping). */
    askFloor: number | null;
    /** Weight the asks carried in the blend (1 = as much as one fresh sale). */
    askWeight: number;
    /** The price is never above this: the cheapest delivered ask (price + shipping), when it is real money. */
    askCap: number | null;
}
/** Authoritative slab identity from PSA's cert-verification API. */
interface PsaVerify {
    cert: string;
    grade: string;
    gradeDescription: string;
    year: string;
    brand: string;
    subject: string;
    cardNumber: string;
    variety: string;
    url: string;
}
/** Why a PSA lookup returned no data — drives honest user-facing notes. */
type PsaLookupError = 'quota' | 'auth' | 'notfound' | 'error';
/** One reference price from an independent source (Scryfall, YGOPRODeck, …). */
interface CrossPrice {
    currency: 'USD' | 'EUR';
    price: number;
    label: string;
}
/** Independent cross-check prices for a card, for a "second opinion" display. */
interface CrossCheck {
    source: string;
    matchedName: string;
    prices: CrossPrice[];
    url?: string;
}
/** What to price: one product, one printing, one condition. */
interface PriceRef {
    productId: number;
    categoryId?: number | null;
    groupId?: number | null;
    /** TCGplayer printing name; "" or "Market" accepts any variant's sales. */
    subType?: string;
    condition: ConditionCode;
    /** How many of the most recent solds to median (1..10, default 3). */
    salesCount?: number;
}
/** Graded-slab lookup. `grader: 'RAW'` fetches ungraded eBay comps instead. */
interface GradedQuery {
    name: string;
    setName?: string;
    number?: string;
    variant?: string;
    grader: string;
    grade: string;
    /** "sports" routes the lookup to sportscardspro.com (same engine). */
    game?: string;
    /** Cert number read off the slab label (PSA certs are verified). */
    cert?: string;
    /** True when the user picked the grade by hand — a cert lookup then only
     * annotates instead of overriding their choice. */
    lockGrade?: boolean;
    /** A cert verification the caller already has (PSA quotas are tiny — reuse it). */
    psa?: PsaVerify;
    /** The caller's own failed verification, so we don't spend a second call. */
    psaError?: PsaLookupError;
    /** Per-call token overrides (else `config.tokens`). */
    psaToken?: string;
    pcToken?: string;
}
/** One row of `groupPrices()` — tcgcsv prices for a whole set. */
interface GroupPrice {
    productId: number;
    subType: string;
    /** Sanitised market (see `saneMarketPrice`), USD. */
    market: number | null;
    low: number | null;
    mid: number | null;
    high: number | null;
    /** True when the published market looked stale and mid/low was used. */
    adjusted: boolean;
}
/** `lookupPrice()` — resolve + pick the printing + price every condition. */
interface PricedCard {
    match: ProductMatch | null;
    quotes: ConditionQuotes;
    confidence: PriceConfidence | null;
    /** The printing `pickSubType` chose from the match. */
    subType: string;
    /** The condition `confidence` was read off (default NM). */
    condition: ConditionCode;
    status: ResolveResult['status'];
    note?: string;
}
type PriceConfidence = 'exact' | 'estimated' | 'low';
/** A price band a card falls into (buylist tier, bulk bin, case slot…). */
interface TierRule {
    id: string;
    label: string;
    /** Inclusive bounds in whole cents; omit either for an open end. */
    minCents?: number;
    maxCents?: number;
}
interface HealthResult {
    name: string;
    ok: boolean;
    ms: number;
    note?: string;
}
/** Pluggable cache. Implement this to share a cache across processes. */
interface CacheStore {
    get<T>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown, ttlMs: number): Promise<void>;
}
interface PricingConfig {
    /**
     * Identifying User-Agent for tcgcsv + PriceCharting/sportscardspro. Those
     * hosts BLOCK browser-impersonating UAs (tcgcsv's block page asks you to
     * name your application), so this must stay an honest identifier.
     */
    userAgent?: string;
    /**
     * Chrome UA for TCGplayer's live/sku endpoints, which are the site's own
     * frontend calls and want a browser UA plus a tcgplayer.com origin/referer.
     * Deliberately the opposite policy from `userAgent` — do not unify them.
     */
    chromeUserAgent?: string;
    /** Defaults to an in-memory TTL cache (200 entries). Never caches null. */
    cache?: CacheStore;
    tokens?: {
        pricecharting?: string;
        psa?: string;
        ebay?: {
            clientId: string;
            clientSecret: string;
        };
    };
    /** Concurrent-request caps per provider. Defaults: tcglive 6, pricecharting 2. */
    concurrency?: {
        tcglive?: number;
        pricecharting?: number;
    };
    /**
     * Pacing for TCGplayer's WAF-guarded per-SKU price-history endpoint.
     * Defaults: one request per 1200 ms, 8-minute cooldown after 5 straight
     * failures. Raising the rate gets the host IP a flat 403 (see the provider).
     */
    sku?: {
        minIntervalMs?: number;
        cooldownMs?: number;
    };
    /** Inject a fetch (proxy, instrumentation, tests). Defaults to global fetch. */
    fetch?: typeof fetch;
    /** Inject the clock sale ages are measured against (tests). Defaults to Date.now. */
    now?: () => number;
}

/**
 * TCGplayer's product image CDN. Verified sizes: `200w` serves 200×280 and
 * `400w` serves 322×450 — 400w is the largest size the CDN actually serves
 * (larger tokens fall back or 404), so there is no point asking for more.
 */
declare function imageUrl(productId: number, size?: '200w' | '400w'): string;
/** Dollars → whole cents (round-half-up). */
declare function toCents(usd: number): number;
/** Whole cents → dollars. */
declare function fromCents(cents: number): number;
/**
 * Add a percentage buffer to a cents amount, rounded half-up to whole cents.
 * `withBuffer(1000, 10)` → 1100. A negative pct discounts.
 */
declare function withBuffer(cents: number, pct: number): number;
/**
 * Which price band a value falls in. Rules are tried in order and the first
 * whose bounds contain the value wins (bounds inclusive; omit either for an
 * open end). `nearBoundary` is true when the value sits within `marginPct`
 * (default 10) of one of the chosen tier's own boundaries — the signal that a
 * small price move would reclassify the card, so a human should look.
 */
declare function assignTier(valueCents: number | null, rules: TierRule[], opts?: {
    marginPct?: number;
}): {
    tier: TierRule | null;
    nearBoundary: boolean;
};
/**
 * How much to trust a quote's number.
 *  - `exact`     — TCGplayer's own per-condition market, or ≥2 real solds in
 *                  that exact condition. Nothing was inferred.
 *  - `estimated` — factor-scaled from another condition or another rung.
 *  - `low`       — a bare product market price, the live-ask floor, a single
 *                  sold, or no price at all. Show it, but flag it.
 */
declare function confidenceOf(quote: PriceQuote): PriceConfidence;

/**
 * Which TCGplayer printing a read corresponds to.
 *
 * Vintage sets list "1st Edition Holofoil" alongside "Unlimited Holofoil".
 * Never drift into a 1st Edition subtype (often 10x the price) unless the
 * scan actually saw the stamp.
 */
declare function pickSubType(printing: string, subTypes: SubTypePrice[]): string;
interface MergedEdition {
    label: string;
    product: ProductMatch;
    subType: string;
    price: number | null;
}
/**
 * WOTC Base Set variants live in TWO TCGplayer products: "X (Shadowless)" —
 * which carries the "1st Edition" and shadowless printings — and plain "X",
 * the shadowed Unlimited. Merge them into one 1st Edition / Shadowless /
 * Unlimited picker, drawn from the matched product plus its sibling among the
 * candidates. Returns null for cards that don't have this split.
 *
 * (Which printing of a card is in your hand — the difference between $10 and
 * $400 on a WOTC-era Pokémon card.)
 */
declare function mergedEditions(match: ProductMatch | undefined, candidates: ProductMatch[]): MergedEdition[] | null;
/** Identity of one merged option, stable across re-renders. */
declare const editionKey: (o: MergedEdition) => string;
/** The option currently in effect for a slot, or the first as a fallback. */
declare function currentEdition(merged: MergedEdition[], match: ProductMatch | undefined, 
/** A freshly scanned slot has no subType yet — fall back to the first. */
subType: string | undefined): MergedEdition;

/**
 * In-memory TTL cache with LRU-ish eviction (drops the entries closest to
 * expiry). On a serverless host this lives for the lifetime of a warm
 * instance; locally it lives for the process.
 *
 * `maxEntries` default 200 (BinderPricer's, sized for a request/response app).
 * A long-running batch job wants far more — PokéDebut's refresh job used 5000.
 */
declare function createMemoryCache(opts?: {
    maxEntries?: number;
}): CacheStore;

declare function round2(n: number): number;
declare function median(nums: number[]): number;

/**
 * tcgcsv's usage guidelines require an identifying User-Agent — they BLOCK
 * browser-impersonating UAs (the block page says to name your application).
 * sportscardspro 403s browser UAs too, and pricecharting may follow.
 */
declare const DEFAULT_USER_AGENT = "HoloTcgKit/0.1 (+https://holohuntingtcg.com)";
/**
 * The opposite policy, on purpose: TCGplayer's live endpoints are the ones
 * tcgplayer.com's own frontend calls, so they want a browser UA and a
 * tcgplayer.com origin/referer. Preserved verbatim from BinderPricer.
 */
declare const DEFAULT_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
declare const SKU_DEFAULT_MIN_INTERVAL_MS = 1200;
declare const SKU_DEFAULT_COOLDOWN_MS: number;

interface CsvCategory {
    categoryId: number;
    name: string;
    displayName?: string;
}
interface CsvGroup {
    groupId: number;
    name: string;
    abbreviation?: string;
    categoryId: number;
}
interface CsvProduct {
    productId: number;
    name: string;
    cleanName?: string;
    imageUrl?: string;
    url?: string;
    groupId: number;
    categoryId: number;
    extendedData?: {
        name: string;
        value: string;
    }[];
}
interface CsvPrice {
    productId: number;
    lowPrice: number | null;
    midPrice: number | null;
    highPrice: number | null;
    marketPrice: number | null;
    subTypeName: string;
}
/** Map a TCGplayer product-line name (e.g. "Pokemon") back to our Game id. */
declare function gameForProductLine(line: string): Game | null;
declare function extValue(product: CsvProduct, name: string): string;
/**
 * TCGplayer's published market price can be stale nonsense on thin vintage
 * printings (e.g. 1st Ed Shadowless Venusaur: market $72.87 while the
 * CHEAPEST live listing is $825). When market is below half the lowest
 * listing, fall back to the mid/low listing price instead.
 */
declare function saneMarketPrice(row: CsvPrice): {
    price: number | null;
    adjusted: boolean;
};

interface SearchHit {
    productId: number;
    productName: string;
    setName: string;
    setCode: string;
    setId: number | null;
    productLineName: string;
    rarityName: string;
    number: string;
    marketPrice: number | null;
    lowestPrice: number | null;
    sealed: boolean;
}
interface ListingRow {
    price: number;
    shipping: number | null;
    condition: string;
    variant: string;
    quantity: number;
    /** A custom (photo) listing: the seller's own title/description, which may not be the plain product. */
    custom: boolean;
    /** The seller's own words on a custom listing (title + description, tags stripped); '' otherwise. */
    title: string;
}

declare function normText(s: string): string;
/** Token-set Dice similarity with a bonus when one string contains the other. */
declare function nameSim(a: string, b: string): number;
/** "004/102" → "4/102", "LOB-EN001" → "lob-en1" (consistent both sides). */
declare function normNumber(n: string): string;
/**
 * Strict form: "044/102" ≡ "44/102"; "TG18/TG30" keeps its letters; anything
 * that isn't a plain card number ("", "Unknown", "LOB-EN001") → "".
 */
declare function normNum(s: string): string;
/**
 * A number field may list several cards ("53/111, 54/111", "AR1, AR2 …",
 * "18/106 19/106"): each is its own TCGplayer product. Normalised,
 * de-duplicated, in the order written.
 */
declare function numberTokens(field: string | null | undefined): string[];
/** The "/total" part of a collector number, e.g. "4/102" → "102". */
declare function numberTotal(n: string): string;
/** Same card number, allowing a bare numerator ("44") against "44/102". */
declare function numMatch(a: string, b: string): boolean;
/**
 * Two numbers name different sets when both carry a set total and the totals
 * differ ("5/102" vs "5/130" — Base Set vs Base Set 2). Used to stop the
 * matcher confidently accepting a same-numbered card from the wrong set.
 */
declare function numberingOk(a: string, b: string): boolean;
declare function numberScore(a: string, b: string): number;
/** Search names look like "Charizard - 4/102 (CoroCoro Promo)". */
declare function splitProductName(productName: string): {
    name: string;
    number: string;
};

interface SkuMarket {
    /** TCGplayer's own market price for this printing × condition, USD. */
    market: number;
    /** Total quantity sold in the window the bucket covers. */
    sold: number;
    /** Bucket day, YYYY-MM-DD. */
    asOf: string;
    /**
     * Days in the month window on which copies sold, newest first. This is
     * how old the market price really is: a market with no sale in the window
     * is a month-old number at best, and the pricer weighs it accordingly.
     */
    sales: {
        date: string;
        quantity: number;
    }[];
}
/** printing|condition → market. Keys use the lower-cased printing name. */
type SkuMarkets = Record<string, SkuMarket>;
interface SkuState {
    requests: number;
    failures: number;
    consecutiveFailures: number;
    blocked: boolean;
    lastStatus: number | null;
    cooldowns: number;
}

declare const FACTOR: Record<ConditionCode, number>;
declare const CONDITION_NAME: Record<ConditionCode, string>;
declare const CONDITION_ID: Record<ConditionCode, number>;
declare const ALL_CONDITIONS: ConditionCode[];
/** Sources that are real numbers, not estimates. */
declare const TRUSTED: Set<"none" | "tcg_market" | "sales" | "sales_adj" | "scaled" | "market" | "market_adj" | "graded" | "ebay" | "ask">;

/**
 * How fast a sale stops being evidence. A sale today is one full vote; one
 * this many days old is half a vote, and it keeps halving — a month old is a
 * quarter, two months a sixteenth. Anything much older than a month is
 * background, not a price: the dealer's rule that an old sale must not set
 * the price when the live listings say otherwise.
 */
declare const SALE_HALF_LIFE_DAYS = 14;
/**
 * A TCGplayer SKU market with no sale in its month window is at least this
 * old — it is treated as a sale this many days ago (a quarter of a vote).
 */
declare const STALE_MARKET_AGE_DAYS = 30;
/**
 * Asks are wishes, not sales: a listing that has not sold yet sits, by
 * definition, at or above the clearing price. The cheapest live ask counts
 * at this fraction of its price. Where cards do have fresh solds, the sold
 * price sits at 0.9–1.05x the cheapest ask (measured across 16 condition
 * rungs of six cards on 2026-09-22).
 */
declare const ASK_DISCOUNT = 0.9;
/**
 * Asks carry full weight from this price up and proportionally less below,
 * and the "never above the cheapest ask" cap only applies from here. Under
 * a couple of dollars, listings are shipping-and-bulk noise: a $0.02 Bede
 * behind $1.31 shipping is not what a $0.18 common sells for (an audit of
 * 48 cards had every sub-$1 common capped at a bulk ask before this).
 */
declare const ASK_TRUST_FROM = 2;
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
declare const NOT_THE_PRODUCT: RegExp;
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
declare function askPool<T extends {
    price: number;
    custom?: boolean;
    title?: string;
}>(eligible: T[], soldLevel: number | null, soldWeight: number): T[];
/**
 * Everything one quote is computed from, fetched once and kept apart from
 * the maths so a quote can be replayed from a fixture (tests/pricing).
 */
interface QuoteEvidence {
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
interface Priced {
    quote: PriceQuote;
    /** Evidence weight: recency-weighted solds plus asks. 0 = nothing of its own. */
    weight: number;
    /** True when the price rests on this condition's own market, solds or asks. */
    anchor: boolean;
}
declare function saleAgeDays(date: string, now: number): number;
declare const recencyWeight: (ageDays: number) => number;
/**
 * Median where each value counts `weight` times: the value at which half the
 * total weight is reached. With equal weights this is the ordinary median
 * (an exact tie between two middle values averages them). Items must be
 * non-empty.
 */
declare function weightedMedian(items: {
    value: number;
    weight: number;
}[]): number;
/**
 * The cheapest live ask by item price — shipping excluded, because the sold
 * prices it is compared with exclude shipping too. A lone ask under a TENTH
 * of the next one is a broken or troll listing, not the market, and is
 * skipped. Anything less extreme is a real listing a customer could buy:
 * Mewtwo LV.X NM asked $185 under a row of $399–450 wishes, Tyranitar
 * reverse holo MP $199.99 under a $600 one, and both were the market.
 */
declare function askFloorOf(listings: {
    price: number;
}[]): number | null;
/**
 * Weighted average of price levels in ratio terms (log space). A $125 sale
 * under $858 asks is a 7x gap, not a $733 one; averaging the ratios keeps a
 * lone wish from dragging a fresh sale up by hundreds of dollars, while
 * levels within a few percent of each other blend to the same number either
 * way. Falls back to the plain weighted mean if a level is not positive.
 */
declare function blendLevels(levels: {
    value: number;
    weight: number;
}[]): number;
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
declare function withoutOutliers<T>(sales: T[], valueOf: (s: T) => number): T[];
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
interface Assessment {
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
declare function assess(params: PriceRef, ev: QuoteEvidence): Assessment;
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
declare function corroborationFor(a: Assessment, others: Assessment[]): number | null;
/**
 * Stage 2 — the price: the weight-blended sold and ask levels, never above
 * the cheapest delivered ask. Fresh solds keep the say; as they age the asks
 * take over and the source turns to `ask`. Nothing at all → TCGplayer's
 * product market price scaled by condition.
 */
declare function finish(a: Assessment, corroboration: number | null): Priced;
/** One condition on its own: the tripwire is corroborated by the product market price only. */
declare function priceFromEvidence(params: PriceRef, ev: QuoteEvidence): Priced;
/**
 * All five conditions from evidence already fetched: each rung's tripwire is
 * corroborated by the other rungs' sold levels, then the ladder is assembled.
 */
declare function ladderFromEvidence(base: Omit<PriceRef, 'condition'>, evidence: Record<ConditionCode, QuoteEvidence>): ConditionQuotes;
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
declare function assembleLadder(priced: Priced[]): ConditionQuotes;
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
declare function enforceMonotonic(priced: Priced[]): void;

type PcHost = 'tcg' | 'sports';
interface PcSearchHit {
    url: string;
    setSlug: string;
    productSlug: string;
    setName: string;
    productName: string;
}
interface PcSale {
    date: string;
    title: string;
    price: number;
    source: string;
    url?: string;
}
interface PcData {
    url: string;
    /** Label → USD, e.g. { "Ungraded": 352.69, "Grade 9": 2461.82, "PSA 10": 30100 } */
    grades: Record<string, number>;
    /** Label → recent sold listings (newest first), same labels as `grades`. */
    sales: Record<string, PcSale[]>;
}
interface PcCardQuery {
    name: string;
    setName?: string;
    number?: string;
    /** Variant cues: "shadowless", "1st edition", "reverse holo", … */
    variant?: string;
}
declare function scorePcHit(query: PcCardQuery, hit: PcSearchHit): number;
declare function gradeLabelFor(grader: string, grade: string, grades: Record<string, number>): {
    label: string;
    note?: string;
} | null;

interface EbayListing {
    title: string;
    price: number;
    shipping: number | null;
    condition: string;
    url: string;
}
interface EbayAsks {
    count: number;
    low: number;
    median: number;
    items: EbayListing[];
    url: string;
}

interface PsaLookup {
    psa: PsaVerify | null;
    error?: PsaLookupError;
}

interface TcgPricing {
    /** Free-text / TCGplayer-URL product search. */
    search(q: string, game?: Game): Promise<{
        results: ProductMatch[];
        note?: string;
    }>;
    /** Identify one card (name / set / number / printing) → a TCGplayer product. */
    resolveCard(q: ResolveRequestCard): Promise<ResolveResult>;
    resolveMany(qs: ResolveRequestCard[], opts?: {
        concurrency?: number;
    }): Promise<ResolveResult[]>;
    /** Add catalog data (printings, canonical number/rarity/image) to a match. */
    enrich(match: ProductMatch, setCode?: string): Promise<ProductMatch>;
    /**
     * A product by id when its set is known (a scan hit carries `groupId`; the
     * card index maps any productId to its group). One cached tcgcsv call, no
     * search. Null when the product isn't in that group.
     */
    productById(productId: number, categoryId: number, groupId: number): Promise<ProductMatch | null>;
    /** One product, one printing, one condition. */
    price(ref: PriceRef): Promise<PriceQuote>;
    /** All five conditions, cross-checked against each other. */
    priceAll(ref: Omit<PriceRef, 'condition'>): Promise<ConditionQuotes>;
    /** Many refs; respects provider pacing and never throws per item. */
    priceMany(refs: PriceRef[], opts?: {
        concurrency?: number;
    }): Promise<(PriceQuote | null)[]>;
    /** A graded slab, or raw eBay comps with `grader: 'RAW'`. */
    priceGraded(q: GradedQuery): Promise<PriceQuote>;
    /** A second opinion from an independent per-game API (MTG/YGO only). */
    crossCheck(game: Game, name: string): Promise<CrossCheck | null>;
    /** Every product's prices for one set, in one call. */
    groupPrices(categoryId: number, groupId: number): Promise<GroupPrice[]>;
    /** resolve → pickSubType → priceAll, in one call. */
    lookupPrice(q: ResolveRequestCard & {
        condition?: ConditionCode;
    }): Promise<PricedCard>;
    /** Are the upstreams answering? One cheap call each. */
    healthcheck(): Promise<HealthResult[]>;
}
declare function createPricing(config?: PricingConfig): TcgPricing;

export { ALL_CONDITIONS, ASK_DISCOUNT, ASK_TRUST_FROM, type Assessment, CONDITIONS, CONDITION_ID, CONDITION_NAME, type CacheStore, type ConditionCode, type ConditionQuotes, type CrossCheck, type CrossPrice, type CsvCategory, type CsvGroup, type CsvPrice, type CsvProduct, DEFAULT_CHROME_USER_AGENT, DEFAULT_USER_AGENT, type EbayAsks, type EbayListing, FACTOR, GRADERS, GRADES, type Game, type GradedInfo, type GradedQuery, type GroupPrice, type HealthResult, type ListingRow, type ListingSample, type MergedEdition, NOT_THE_PRODUCT, type PcCardQuery, type PcData, type PcHost, type PcSale, type PcSearchHit, type PriceBasis, type PriceConfidence, type PriceQuote, type PriceRef, type Priced, type PricedCard, type PricingConfig, type ProductMatch, type PsaLookup, type PsaLookupError, type PsaVerify, type QuoteEvidence, type ResolveRequestCard, type ResolveResult, SALE_HALF_LIFE_DAYS, SKU_DEFAULT_COOLDOWN_MS, SKU_DEFAULT_MIN_INTERVAL_MS, STALE_MARKET_AGE_DAYS, type SaleSample, type SearchHit, type SkuMarket, type SkuMarkets, type SkuState, type SubTypePrice, TRUSTED, type TcgPricing, type TierRule, askFloorOf, askPool, assembleLadder, assess, assignTier, blendLevels, confidenceOf, corroborationFor, createMemoryCache, createPricing, currentEdition, editionKey, enforceMonotonic, extValue, finish, fromCents, gameForProductLine, gradeLabelFor, imageUrl, ladderFromEvidence, median, mergedEditions, nameSim, normNum, normNumber, normText, numMatch, numberScore, numberTokens, numberTotal, numberingOk, pickSubType, priceFromEvidence, recencyWeight, round2, saleAgeDays, saneMarketPrice, scorePcHit, splitProductName, toCents, weightedMedian, withBuffer, withoutOutliers };
