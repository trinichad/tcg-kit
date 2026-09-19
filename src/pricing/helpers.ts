// New in this package: the pure, instance-free exports. `imageUrl` replaces
// BinderPricer's private `cdnImage` in match.ts; the cents/tier/confidence
// helpers are new — consumer-side arithmetic that used to live in the app.

import type { PriceConfidence, PriceQuote, TierRule } from './types';

/**
 * TCGplayer's product image CDN. Verified sizes: `200w` serves 200×280 and
 * `400w` serves 322×450 — 400w is the largest size the CDN actually serves
 * (larger tokens fall back or 404), so there is no point asking for more.
 */
export function imageUrl(productId: number, size: '200w' | '400w' = '200w'): string {
  return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_${size}.jpg`;
}

/** Dollars → whole cents (round-half-up). */
export function toCents(usd: number): number {
  return Math.floor(usd * 100 + 0.5);
}

/** Whole cents → dollars. */
export function fromCents(cents: number): number {
  return cents / 100;
}

/**
 * Add a percentage buffer to a cents amount, rounded half-up to whole cents.
 * `withBuffer(1000, 10)` → 1100. A negative pct discounts.
 */
export function withBuffer(cents: number, pct: number): number {
  return Math.floor(cents * (1 + pct / 100) + 0.5);
}

/**
 * Which price band a value falls in. Rules are tried in order and the first
 * whose bounds contain the value wins (bounds inclusive; omit either for an
 * open end). `nearBoundary` is true when the value sits within `marginPct`
 * (default 10) of one of the chosen tier's own boundaries — the signal that a
 * small price move would reclassify the card, so a human should look.
 */
export function assignTier(
  valueCents: number | null,
  rules: TierRule[],
  opts: { marginPct?: number } = {},
): { tier: TierRule | null; nearBoundary: boolean } {
  if (valueCents == null || !Number.isFinite(valueCents)) {
    return { tier: null, nearBoundary: false };
  }
  const tier =
    rules.find(
      (r) =>
        (r.minCents == null || valueCents >= r.minCents) &&
        (r.maxCents == null || valueCents <= r.maxCents),
    ) ?? null;
  if (!tier) return { tier: null, nearBoundary: false };
  const margin = opts.marginPct ?? 10;
  const near = (bound?: number) =>
    bound != null && Math.abs(valueCents - bound) <= Math.abs(bound) * (margin / 100);
  return { tier, nearBoundary: near(tier.minCents) || near(tier.maxCents) };
}

/**
 * How much to trust a quote's number.
 *  - `exact`     — TCGplayer's own per-condition market, or ≥2 real solds in
 *                  that exact condition. Nothing was inferred.
 *  - `estimated` — factor-scaled from another condition or another rung.
 *  - `low`       — a bare product market price, the live-ask floor, a single
 *                  sold, or no price at all. Show it, but flag it.
 */
export function confidenceOf(quote: PriceQuote): PriceConfidence {
  if (quote.source === 'tcg_market') return 'exact';
  if (quote.source === 'graded') return 'exact'; // PriceCharting per-grade value: observed, not derived
  if (quote.source === 'sales' && quote.salesUsed >= 2) return 'exact';
  if (quote.source === 'sales_adj' || quote.source === 'scaled' || quote.source === 'market_adj') {
    return 'estimated';
  }
  return 'low';
}
