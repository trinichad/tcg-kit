// Origin: PokedexDebut execution/pricing/tcglive.mjs @ working tree (the
// `skuMarkets` half), which is the more accurate primary price source.
// Changed: module-level pacing state + `process.env.SKU_*` become per-instance
// (`createSkuMarkets(ctx)`, config `sku.minIntervalMs` / `sku.cooldownMs`);
// defaults preserved (1200 ms, 8 min). Pacing and breaker logic untouched.

import type { PricingCtx } from '../context';

const MIN = 60_000;

/** After this many consecutive failures the breaker trips. */
const SKU_BREAK = 5;
/** How many cool-downs to spend before the breaker stays open for the run. */
const SKU_COOLDOWNS = 2;

export interface SkuMarket {
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
  sales: { date: string; quantity: number }[];
}

/** printing|condition → market. Keys use the lower-cased printing name. */
export type SkuMarkets = Record<string, SkuMarket>;

export interface SkuState {
  requests: number;
  failures: number;
  consecutiveFailures: number;
  blocked: boolean;
  lastStatus: number | null;
  cooldowns: number;
}

interface RawSku {
  variant?: string;
  condition?: string;
  language?: string;
  totalQuantitySold?: number | string;
  buckets?: { marketPrice?: number | string; quantitySold?: number | string; bucketStartDate?: string }[];
}

const normVariant = (s: unknown): string =>
  String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

/** The TCGplayer market for one printing + condition name, or null. */
export function skuMarketFor(
  markets: SkuMarkets | null,
  subType: string,
  conditionName: string,
): SkuMarket | null {
  return markets?.[`${normVariant(subType)}|${conditionName}`] ?? null;
}

export type TcgPlayerSku = ReturnType<typeof createSkuMarkets>;

/**
 * TCGplayer's own market price for every SKU of a product — printing ×
 * condition — the number tcgplayer.com shows once a condition is selected.
 * One call covers all conditions.
 *
 * This endpoint sits behind an AWS WAF: ~3,200 calls in two minutes earned a
 * flat 403 from the load balancer for hours (2026-09-17), and 605 paced calls
 * at 2.5/s did it again (2026-09-18). So it is paced — one request at a time,
 * at least `sku.minIntervalMs` apart (default 1200 ms ⇒ ≤ 50/min). After
 * SKU_BREAK consecutive failures the breaker trips: up to SKU_COOLDOWNS times
 * per instance it waits `sku.cooldownMs` (a block has lifted within ~6 min
 * both times) and resumes at half the pace; after that it stays open and
 * `skuMarkets()` returns null for the rest of the run.
 */
export function createSkuMarkets(ctx: PricingCtx) {
  const minIntervalMs = ctx.sku.minIntervalMs;
  const cooldownMs = ctx.sku.cooldownMs;

  // Per-instance pacing state (module-level in the source).
  let lastAt = 0;
  let interval = minIntervalMs;
  let inflight: Promise<unknown> = Promise.resolve();

  const state: SkuState = {
    requests: 0,
    failures: 0,
    consecutiveFailures: 0,
    blocked: false,
    lastStatus: null,
    cooldowns: 0,
  };

  /** Serialise to one request at a time (createLimiter(1) in the source). */
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = inflight.then(fn, fn);
    inflight = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function skuGet(url: string): Promise<{ result?: RawSku[] } | null> {
    return serial(async () => {
      const wait = lastAt + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      state.requests++;
      try {
        const r = await ctx.fetchRetry(url, { headers: headers() });
        state.lastStatus = r.status;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        state.consecutiveFailures = 0;
        return (await r.json()) as { result?: RawSku[] };
      } catch (err) {
        state.failures++;
        if (++state.consecutiveFailures >= SKU_BREAK) {
          if (state.cooldowns < SKU_COOLDOWNS) {
            // Cool down, then carry on more slowly: the next request waits out the pause.
            state.cooldowns++;
            state.consecutiveFailures = 0;
            interval *= 2;
            lastAt = Date.now() + cooldownMs;
            console.error(
              `[tcgplayer-sku] price/history: ${SKU_BREAK} consecutive failures (last ${
                (err as Error)?.message ?? err
              }) — cooling down ${Math.round(cooldownMs / 60000)} min, then one request per ${(
                interval / 1000
              ).toFixed(1)} s (cool-down ${state.cooldowns}/${SKU_COOLDOWNS})`,
            );
          } else if (!state.blocked) {
            state.blocked = true;
            console.error(
              `[tcgplayer-sku] price/history: ${SKU_BREAK} consecutive failures again (last ${
                (err as Error)?.message ?? err
              }) — circuit open, skipping the rest of this run`,
            );
          }
        }
        return null;
      }
    });
  }

  const headers = (): Record<string, string> => ({
    'user-agent': ctx.chromeUserAgent,
    accept: 'application/json',
    origin: 'https://www.tcgplayer.com',
    referer: 'https://www.tcgplayer.com/',
  });

  /**
   * Daily buckets, newest first; prices arrive as strings; a SKU with no
   * market yet is simply absent. Keys are `${printing}|${condition}` with the
   * printing lower-cased (TCGplayer spells printings exactly like TCGCSV's
   * subTypeName). Returns null when the endpoint is unreachable or blocked.
   */
  async function skuMarkets(productId: number): Promise<SkuMarkets | null> {
    if (state.blocked) return null;
    return ctx.cached(`sku:${productId}`, 60 * MIN, async () => {
      const resp = await skuGet(
        `https://infinite-api.tcgplayer.com/price/history/${productId}/detailed?range=month`,
      );
      if (!resp) return null;
      const out: SkuMarkets = {};
      for (const s of resp.result ?? []) {
        if (s.language && s.language !== 'English') continue;
        const latest = (s.buckets ?? []).find((b) => Number(b.marketPrice) > 0);
        if (!latest) continue;
        out[`${normVariant(s.variant)}|${s.condition}`] = {
          market: Number(latest.marketPrice),
          sold: Number(s.totalQuantitySold ?? 0),
          asOf: String(latest.bucketStartDate ?? '').slice(0, 10),
          sales: (s.buckets ?? [])
            .filter((b) => Number(b.quantitySold) > 0)
            .map((b) => ({
              date: String(b.bucketStartDate ?? '').slice(0, 10),
              quantity: Number(b.quantitySold),
            })),
        };
      }
      return out;
    });
  }

  return { skuMarkets, skuMarketFor, state };
}
