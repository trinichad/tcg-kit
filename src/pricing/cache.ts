// Origin: BinderPricer server/core/cache.ts @ e995c9e.
// Changed: the module-level Map is now built per `createPricing()` instance by
// `createMemoryCache({ maxEntries })`, and the cache is pluggable via the
// `CacheStore` interface. The "never cache null" rule is unchanged and is
// enforced in `createCached`, above whatever store is plugged in.

import type { CacheStore } from './types';

interface Entry {
  exp: number;
  value: unknown;
}

/**
 * In-memory TTL cache with LRU-ish eviction (drops the entries closest to
 * expiry). On a serverless host this lives for the lifetime of a warm
 * instance; locally it lives for the process.
 *
 * `maxEntries` default 200 (BinderPricer's, sized for a request/response app).
 * A long-running batch job wants far more — PokéDebut's refresh job used 5000.
 */
export function createMemoryCache(opts: { maxEntries?: number } = {}): CacheStore {
  const maxEntries = opts.maxEntries ?? 200;
  const store = new Map<string, Entry>();

  function evictIfNeeded(): void {
    if (store.size <= maxEntries) return;
    const byExp = [...store.entries()].sort((a, b) => a[1].exp - b[1].exp);
    for (const [key] of byExp.slice(0, Math.ceil(maxEntries / 5))) store.delete(key);
  }

  return {
    async get<T>(key: string): Promise<T | undefined> {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.exp <= Date.now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value as T;
    },
    async set(key: string, value: unknown, ttlMs: number): Promise<void> {
      store.set(key, { exp: Date.now() + ttlMs, value });
      evictIfNeeded();
    },
  };
}

export type Cached = <T>(key: string, ttlMs: number, fn: () => Promise<T>) => Promise<T>;

/** Wrap a store with in-flight de-duplication and the never-cache-null rule. */
export function createCached(store: CacheStore): Cached {
  const inflight = new Map<string, Promise<unknown>>();

  return async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const hit = await store.get<T>(key);
    if (hit !== undefined) return hit;

    const pending = inflight.get(key);
    if (pending) return pending as Promise<T>;

    const p = (async () => {
      try {
        const value = await fn();
        // The guarded fetchers signal failure with null — don't cache that, or
        // one transient upstream blip serves stale "unavailable" for the whole
        // TTL (seen as a sales-based price silently degrading to an estimate).
        if (value !== null) await store.set(key, value, ttlMs);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}
