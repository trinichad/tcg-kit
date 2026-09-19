export { C as CATEGORY_ID, a as INDEX_GAMES, I as IndexGame } from '../catalogues-B2qHmLL2.cjs';

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
    /** PriceCharting rows: the sold listing's title and link. */
    title?: string;
    url?: string;
}
/** A live TCGplayer listing (current ask). */
interface ListingSample {
    price: number;
    shipping: number | null;
    condition: string;
    variant: string;
    quantity: number;
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
     * ask        – current TCGplayer ask level, used when a thin sold sample is
     *              implausibly far below the live asks (bad-data guard)
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
declare function enforceMonotonic(quotes: PriceQuote[]): void;
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
declare function withoutOutliers<T>(sales: T[], valueOf: (s: T) => number): T[];

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

export { ALL_CONDITIONS, CONDITIONS, CONDITION_ID, CONDITION_NAME, type CacheStore, type ConditionCode, type ConditionQuotes, type CrossCheck, type CrossPrice, type CsvCategory, type CsvGroup, type CsvPrice, type CsvProduct, DEFAULT_CHROME_USER_AGENT, DEFAULT_USER_AGENT, type EbayAsks, type EbayListing, FACTOR, GRADERS, GRADES, type Game, type GradedInfo, type GradedQuery, type GroupPrice, type HealthResult, type ListingRow, type ListingSample, type MergedEdition, type PcCardQuery, type PcData, type PcHost, type PcSale, type PcSearchHit, type PriceConfidence, type PriceQuote, type PriceRef, type PricedCard, type PricingConfig, type ProductMatch, type PsaLookup, type PsaLookupError, type PsaVerify, type ResolveRequestCard, type ResolveResult, SKU_DEFAULT_COOLDOWN_MS, SKU_DEFAULT_MIN_INTERVAL_MS, type SaleSample, type SearchHit, type SkuMarket, type SkuMarkets, type SkuState, type SubTypePrice, type TcgPricing, type TierRule, assignTier, confidenceOf, createMemoryCache, createPricing, currentEdition, editionKey, enforceMonotonic, extValue, fromCents, gameForProductLine, gradeLabelFor, imageUrl, median, mergedEditions, nameSim, normNum, normNumber, normText, numMatch, numberScore, numberTokens, numberTotal, numberingOk, pickSubType, round2, saneMarketPrice, scorePcHit, splitProductName, toCents, withBuffer, withoutOutliers };
