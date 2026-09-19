// New in this package: the instance context every provider factory takes.
// Replaces BinderPricer's module-level `const UA = …`, module-level
// `createLimiter(n)` and `process.env.*` reads — all of which were per-process
// globals. Nothing in src/pricing/** reads process.env; scripts/* do that.

import { createCached, createMemoryCache, type Cached } from './cache';
import type { PricingConfig } from './types';
import { createFetchRetry, createLimiter, type FetchLike, type FetchRetry } from './util';

/**
 * tcgcsv's usage guidelines require an identifying User-Agent — they BLOCK
 * browser-impersonating UAs (the block page says to name your application).
 * sportscardspro 403s browser UAs too, and pricecharting may follow.
 */
export const DEFAULT_USER_AGENT = 'HoloTcgKit/0.1 (+https://holohuntingtcg.com)';

/**
 * The opposite policy, on purpose: TCGplayer's live endpoints are the ones
 * tcgplayer.com's own frontend calls, so they want a browser UA and a
 * tcgplayer.com origin/referer. Preserved verbatim from BinderPricer.
 */
export const DEFAULT_CHROME_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

export const SKU_DEFAULT_MIN_INTERVAL_MS = 1200;
export const SKU_DEFAULT_COOLDOWN_MS = 8 * 60 * 1000;

export type Limit = <T>(fn: () => Promise<T>) => Promise<T>;

export interface PricingCtx {
  fetch: FetchLike;
  fetchRetry: FetchRetry;
  cached: Cached;
  /** Identifying UA — tcgcsv, PriceCharting, sportscardspro, cross-check APIs. */
  userAgent: string;
  /** Chrome UA — TCGplayer live search / listings / sales / price history. */
  chromeUserAgent: string;
  tokens: {
    pricecharting?: string;
    psa?: string;
    ebay?: { clientId: string; clientSecret: string };
  };
  sku: { minIntervalMs: number; cooldownMs: number };
  /** Concurrency gate for TCGplayer's live endpoints (default 6). */
  limitTcgLive: Limit;
  /** Concurrency gate for PriceCharting scrapes (default 2). */
  limitPriceCharting: Limit;
}

export function createContext(config: PricingConfig = {}): PricingCtx {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('tcg-kit/pricing: no fetch available — pass config.fetch');
  }
  return {
    fetch: fetchImpl,
    fetchRetry: createFetchRetry(fetchImpl),
    cached: createCached(config.cache ?? createMemoryCache()),
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    chromeUserAgent: config.chromeUserAgent ?? DEFAULT_CHROME_USER_AGENT,
    tokens: {
      pricecharting: config.tokens?.pricecharting?.trim() || undefined,
      psa: config.tokens?.psa?.trim() || undefined,
      ebay: config.tokens?.ebay,
    },
    sku: {
      minIntervalMs: config.sku?.minIntervalMs ?? SKU_DEFAULT_MIN_INTERVAL_MS,
      cooldownMs: config.sku?.cooldownMs ?? SKU_DEFAULT_COOLDOWN_MS,
    },
    // Bound concurrent calls (fetchRetry handles 429/5xx backoff). These
    // endpoints haven't rate-limited in practice, but a full binder page fans
    // out many search/listing/sales calls at once — cap the burst as a safety
    // net. Higher than PriceCharting's cap since this is the high-frequency
    // raw-pricing path.
    limitTcgLive: createLimiter(config.concurrency?.tcglive ?? 6),
    // Politeness gate. PriceCharting returns 429 to a burst of rapid scrapes —
    // a slab-heavy page fires several graded lookups at once, and without this
    // the later ones silently degrade to "set price manually".
    limitPriceCharting: createLimiter(config.concurrency?.pricecharting ?? 2),
  };
}
