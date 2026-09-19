import { describe, expect, it } from 'vitest';
import {
  assignTier,
  confidenceOf,
  fromCents,
  imageUrl,
  toCents,
  withBuffer,
} from '../../src/pricing/index';
import type { PriceQuote, TierRule } from '../../src/pricing/index';

const quote = (p: Partial<PriceQuote>): PriceQuote => ({
  productId: 1,
  subType: 'Normal',
  condition: 'NM',
  price: 1,
  source: 'none',
  estimated: false,
  salesUsed: 0,
  marketPrice: null,
  sales: [],
  url: '',
  ...p,
});

describe('imageUrl', () => {
  it('builds the TCGplayer CDN url, 200w by default', () => {
    expect(imageUrl(42387)).toBe('https://tcgplayer-cdn.tcgplayer.com/product/42387_200w.jpg');
    expect(imageUrl(42387, '400w')).toBe(
      'https://tcgplayer-cdn.tcgplayer.com/product/42387_400w.jpg',
    );
  });
});

describe('toCents / fromCents', () => {
  it('round-trips whole dollars', () => {
    expect(toCents(12.34)).toBe(1234);
    expect(fromCents(1234)).toBe(12.34);
  });

  it('rounds half up and survives float noise', () => {
    expect(toCents(0.005)).toBe(1); // half-up, not banker's
    expect(toCents(0.125)).toBe(13); // exactly 12.5 cents → up
    expect(toCents(0.1 + 0.2)).toBe(30); // 0.30000000000000004
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(0)).toBe(0);
    // Half-up applies to the double that actually arrives: 1.005 * 100 is
    // 100.49999999999999 in IEEE-754, so it rounds DOWN. Dollars are a lossy
    // carrier for half-cents — this is why quotes stay in the source's units
    // and only the consumer converts.
    expect(toCents(1.005)).toBe(100);
  });
});

describe('withBuffer', () => {
  it('adds a percentage and lands on whole cents', () => {
    expect(withBuffer(1000, 10)).toBe(1100);
    expect(withBuffer(0, 25)).toBe(0);
    expect(withBuffer(1234, 0)).toBe(1234);
  });

  it('rounds half up', () => {
    // 101 * 1.05 = 106.05 → 106
    expect(withBuffer(101, 5)).toBe(106);
    // 10 * 1.05 = 10.5 → 11 (half up, never 10)
    expect(withBuffer(10, 5)).toBe(11);
    // 30 * 1.05 = 31.5 → 32
    expect(withBuffer(30, 5)).toBe(32);
  });

  it('discounts on a negative pct', () => {
    expect(withBuffer(1000, -20)).toBe(800);
  });
});

describe('assignTier', () => {
  const rules: TierRule[] = [
    { id: 'bulk', label: 'Bulk', maxCents: 99 },
    { id: 'binder', label: 'Binder', minCents: 100, maxCents: 999 },
    { id: 'case', label: 'Case', minCents: 1000 },
  ];

  it('returns no tier for a null value', () => {
    expect(assignTier(null, rules)).toEqual({ tier: null, nearBoundary: false });
  });

  it('picks the first rule whose bounds contain the value (bounds inclusive)', () => {
    expect(assignTier(50, rules).tier?.id).toBe('bulk');
    expect(assignTier(99, rules).tier?.id).toBe('bulk');
    expect(assignTier(100, rules).tier?.id).toBe('binder');
    expect(assignTier(999, rules).tier?.id).toBe('binder');
    expect(assignTier(1000, rules).tier?.id).toBe('case');
    expect(assignTier(500000, rules).tier?.id).toBe('case');
  });

  it('returns no tier when nothing matches', () => {
    expect(assignTier(50, [{ id: 'x', label: 'X', minCents: 100 }]).tier).toBeNull();
  });

  it('flags values within marginPct of either boundary of the chosen tier', () => {
    // binder = 100..999, default margin 10%
    expect(assignTier(105, rules).nearBoundary).toBe(true); // 5% above min
    expect(assignTier(950, rules).nearBoundary).toBe(true); // ~5% below max
    expect(assignTier(500, rules).nearBoundary).toBe(false); // mid-band
  });

  it('honours a custom marginPct', () => {
    expect(assignTier(500, rules, { marginPct: 60 }).nearBoundary).toBe(true);
    expect(assignTier(105, rules, { marginPct: 1 }).nearBoundary).toBe(false);
  });

  it('treats an open end as no boundary to be near', () => {
    // case = 1000+, so only the min counts
    expect(assignTier(1_000_000, rules).nearBoundary).toBe(false);
    expect(assignTier(1050, rules).nearBoundary).toBe(true);
  });
});

describe('confidenceOf', () => {
  it('calls TCGplayer per-condition market exact', () => {
    expect(confidenceOf(quote({ source: 'tcg_market', salesUsed: 0 }))).toBe('exact');
    expect(confidenceOf(quote({ source: 'graded', salesUsed: 0 }))).toBe('exact');
  });

  it('calls two or more exact-condition solds exact', () => {
    expect(confidenceOf(quote({ source: 'sales', salesUsed: 2 }))).toBe('exact');
    expect(confidenceOf(quote({ source: 'sales', salesUsed: 5 }))).toBe('exact');
  });

  it('does not call a lone sold exact', () => {
    expect(confidenceOf(quote({ source: 'sales', salesUsed: 1 }))).toBe('low');
  });

  it('calls anything factor-scaled estimated', () => {
    expect(confidenceOf(quote({ source: 'scaled' }))).toBe('estimated');
    expect(confidenceOf(quote({ source: 'sales_adj', salesUsed: 9 }))).toBe('estimated');
    expect(confidenceOf(quote({ source: 'market_adj' }))).toBe('estimated');
  });

  it('calls a bare market, the ask floor and everything else low', () => {
    expect(confidenceOf(quote({ source: 'market' }))).toBe('low');
    expect(confidenceOf(quote({ source: 'ask' }))).toBe('low');
    expect(confidenceOf(quote({ source: 'none', price: null }))).toBe('low');
    expect(confidenceOf(quote({ source: 'ebay' }))).toBe('low');
  });
});
