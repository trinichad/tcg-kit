// Network plumbing for the Node-side scripts.
//
// Lifted from BinderPricer's `server/core/util.ts` (only the three helpers the
// index updater needs) so `scripts/` has no dependency on the kit's pricing
// entry point — the two extractions stay independent, and a script can be run
// from a checkout with nothing built.

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A persistent concurrency gate. `run(fn)` never lets more than `max` calls
 * execute at once — excess calls queue and start as slots free. Used to keep
 * bursts of scrapes (a set-heavy catalogue crawl) from tripping upstream 429s.
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

/**
 * fetch with retry on 429 / 5xx (honoring Retry-After) and on network errors.
 * Each attempt gets a fresh timeout signal. Returns the Response (even when
 * !ok, so callers log the status their own way); re-throws only if the final
 * network attempt throws.
 */
export async function fetchRetry(
  url: string,
  init: RequestInit & { timeoutMs?: number } = {},
  retries = 2,
): Promise<Response> {
  const { timeoutMs = 20_000, ...rest } = init;
  for (let attempt = 0; ; attempt++) {
    try {
      const r = await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
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
}
