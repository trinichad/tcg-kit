// Origin: BinderPricer server/core/util.ts @ e995c9e (identical to PokéDebut's
// execution/lib/util.mjs, which was ported from it).
// Changed: `fetchRetry` is now built by `createFetchRetry(fetchImpl)` so the
// fetch implementation can be injected — no other behaviour differs.

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function median(nums: number[]): number {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A persistent concurrency gate. `run(fn)` never lets more than `max` calls
 * execute at once — excess calls queue and start as slots free. Used to keep
 * bursts of scrapes (a slab-heavy binder page) from tripping upstream 429s.
 */
export function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

export type FetchLike = typeof fetch;
export type FetchRetry = (
  url: string,
  init?: RequestInit & { timeoutMs?: number },
  retries?: number,
) => Promise<Response>;

/**
 * fetch with retry on 429 / 5xx (honoring Retry-After) and on network errors.
 * Each attempt gets a fresh timeout signal. Returns the Response (even when
 * !ok, so callers log the status their own way); re-throws only if the final
 * network attempt throws.
 */
export function createFetchRetry(fetchImpl: FetchLike): FetchRetry {
  return async function fetchRetry(url, init = {}, retries = 2): Promise<Response> {
    const { timeoutMs = 20_000, ...rest } = init;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
        if ((r.status === 429 || r.status >= 500) && attempt < retries) {
          const retryAfter = Number(r.headers.get('retry-after'));
          const backoff =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : 600 * (attempt + 1) * (attempt + 1); // 600ms, 2.4s
          await sleep(Math.min(backoff, 5000));
          continue;
        }
        return r;
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  };
}

/** Map with bounded concurrency, preserving order. Errors become null. */
export async function limitMap<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error('[limitMap] item failed:', err);
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}
