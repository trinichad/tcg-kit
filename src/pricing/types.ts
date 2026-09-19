// Pricing subset of BinderPricer's shared/types.ts @ e995c9e.
// Changed: auth / AI / index-admin / billing types left behind; ConditionCode
// keeps BinderPricer's `DM` (PokéDebut spells it `DMG` — normalised here);
// PriceQuote.source gains `tcg_market` + `scaled` (PokéDebut ladder), and
// PriceQuote gains `asOf`; the config/result types for this package are new.

export type Game = 'pokemon' | 'magic' | 'yugioh' | 'lorcana' | 'onepiece' | 'dragonball' | 'sports';

export type ConditionCode = 'NM' | 'LP' | 'MP' | 'HP' | 'DM';

export const CONDITIONS: { value: ConditionCode; label: string }[] = [
  { value: 'NM', label: 'Near Mint' },
  { value: 'LP', label: 'Lightly Played' },
  { value: 'MP', label: 'Moderately Played' },
  { value: 'HP', label: 'Heavily Played' },
  { value: 'DM', label: 'Damaged' },
];

/** Graded-slab info read off the label (PSA / BGS / CGC / SGC / TAG / ACE). */
export interface GradedInfo {
  grader: string; // "PSA", "CGC", "BGS", "SGC", "TAG", "ACE"
  grade: string; // "10", "9.5", "8", …
  cert?: string;
}

export const GRADERS = ['PSA', 'CGC', 'BGS', 'SGC', 'TAG', 'ACE'] as const;
export const GRADES = ['10', '9.5', '9', '8.5', '8', '7.5', '7', '6', '5', '4', '3', '2', '1'] as const;

export interface SubTypePrice {
  name: string; // TCGplayer printing, e.g. "Holofoil", "Reverse Holofoil", "Normal"
  marketPrice: number | null;
}

/** A TCGplayer product a card was matched to. */
export interface ProductMatch {
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
  score: number; // 0..1 match confidence
}

export interface ResolveRequestCard {
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

export interface ResolveResult {
  cell: number;
  status: 'matched' | 'uncertain' | 'none';
  best: ProductMatch | null;
  candidates: ProductMatch[];
  note?: string;
}

export interface SaleSample {
  date: string;
  price: number;
  condition: string; // TCGplayer condition, or the marketplace ("eBay") for PriceCharting rows
  variant: string;
  /** PriceCharting rows: the sold listing's title and link. */
  title?: string;
  url?: string;
}

/** A live TCGplayer listing (current ask). */
export interface ListingSample {
  price: number;
  shipping: number | null;
  condition: string;
  variant: string;
  quantity: number;
}

/** Per-condition quotes, prefetched so condition changes need no request. */
export type ConditionQuotes = Partial<Record<ConditionCode, PriceQuote>>;

export interface PriceQuote {
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
  source:
    | 'tcg_market'
    | 'sales'
    | 'sales_adj'
    | 'scaled'
    | 'market'
    | 'market_adj'
    | 'graded'
    | 'ebay'
    | 'ask'
    | 'none';
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
export interface PsaVerify {
  cert: string;
  grade: string; // "8"
  gradeDescription: string; // "NM-MT 8"
  year: string;
  brand: string; // "POKEMON XY"
  subject: string; // "FA/FLAREON EX"
  cardNumber: string; // "RC28"
  variety: string;
  url: string; // psacard.com cert page
}

/** Why a PSA lookup returned no data — drives honest user-facing notes. */
export type PsaLookupError = 'quota' | 'auth' | 'notfound' | 'error';

/** One reference price from an independent source (Scryfall, YGOPRODeck, …). */
export interface CrossPrice {
  currency: 'USD' | 'EUR';
  price: number;
  label: string; // "market", "foil", "eBay", "Cardmarket", "TCGplayer", …
}

/** Independent cross-check prices for a card, for a "second opinion" display. */
export interface CrossCheck {
  source: string; // "Scryfall" | "YGOPRODeck"
  matchedName: string; // which product the source matched (surfaces wrong matches)
  prices: CrossPrice[];
  url?: string;
}

// ── Package API shapes (new) ────────────────────────────────────────────────

/** What to price: one product, one printing, one condition. */
export interface PriceRef {
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
export interface GradedQuery {
  name: string;
  setName?: string;
  number?: string;
  variant?: string;
  grader: string; // "PSA" … or "RAW" for ungraded eBay comps
  grade: string; // ignored when grader is "RAW"
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
export interface GroupPrice {
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
export interface PricedCard {
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

export type PriceConfidence = 'exact' | 'estimated' | 'low';

/** A price band a card falls into (buylist tier, bulk bin, case slot…). */
export interface TierRule {
  id: string;
  label: string;
  /** Inclusive bounds in whole cents; omit either for an open end. */
  minCents?: number;
  maxCents?: number;
}

export interface HealthResult {
  name: string;
  ok: boolean;
  ms: number;
  note?: string;
}

// ── Configuration ───────────────────────────────────────────────────────────

/** Pluggable cache. Implement this to share a cache across processes. */
export interface CacheStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown, ttlMs: number): Promise<void>;
}

export interface PricingConfig {
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
    ebay?: { clientId: string; clientSecret: string };
  };
  /** Concurrent-request caps per provider. Defaults: tcglive 6, pricecharting 2. */
  concurrency?: { tcglive?: number; pricecharting?: number };
  /**
   * Pacing for TCGplayer's WAF-guarded per-SKU price-history endpoint.
   * Defaults: one request per 1200 ms, 8-minute cooldown after 5 straight
   * failures. Raising the rate gets the host IP a flat 403 (see the provider).
   */
  sku?: { minIntervalMs?: number; cooldownMs?: number };
  /** Inject a fetch (proxy, instrumentation, tests). Defaults to global fetch. */
  fetch?: typeof fetch;
}
