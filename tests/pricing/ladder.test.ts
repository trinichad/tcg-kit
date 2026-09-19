// Ladder maths, offline. Every provider here is a stub — nothing in this file
// touches the network.

import { describe, expect, it } from 'vitest';
import { createPricer } from '../../src/pricing/pricing';
import { CONDITION_NAME, enforceMonotonic, withoutOutliers } from '../../src/pricing/index';
import { skuMarketFor, type SkuMarkets } from '../../src/pricing/providers/tcgplayer-sku';
import type { PricingCtx } from '../../src/pricing/context';
import type { TcgCsv } from '../../src/pricing/providers/tcgcsv';
import type { TcgLive } from '../../src/pricing/providers/tcglive';
import type { TcgPlayerSku } from '../../src/pricing/providers/tcgplayer-sku';
import type { ConditionCode, PriceQuote, SaleSample } from '../../src/pricing/index';

const CODES: ConditionCode[] = ['NM', 'LP', 'MP', 'HP', 'DM'];

const quote = (condition: ConditionCode, p: Partial<PriceQuote>): PriceQuote => ({
  productId: 1,
  subType: 'Normal',
  condition,
  price: null,
  source: 'sales',
  estimated: false,
  salesUsed: 1,
  marketPrice: null,
  sales: [],
  url: '',
  ...p,
});

/** A pricer whose only data is what the test hands it. */
function stubPricer(opts: {
  markets?: SkuMarkets | null;
  /** condition code → sold prices in that exact condition */
  solds?: Partial<Record<ConditionCode, number[]>>;
}) {
  const csv = { prices: async () => [] } as unknown as TcgCsv;
  const live = {
    currentListings: async () => [],
    latestSales: async (_productId: number, conditionId?: number): Promise<SaleSample[]> => {
      if (!conditionId) return [];
      const code = CODES[conditionId - 1];
      return (opts.solds?.[code] ?? []).map((price) => ({
        date: '2026-09-01',
        price,
        condition: CONDITION_NAME[code],
        variant: 'Normal',
      }));
    },
  } as unknown as TcgLive;
  const sku = {
    skuMarkets: async () => opts.markets ?? null,
    skuMarketFor,
  } as unknown as TcgPlayerSku;
  return createPricer({} as PricingCtx, { csv, live, sku });
}

const market = (m: number) => ({ market: m, sold: 3, asOf: '2026-09-17' });

describe('withoutOutliers', () => {
  it('leaves thin windows alone — under four sales there is no context', () => {
    const sales = [100, 1, 100];
    expect(withoutOutliers(sales, (s) => s)).toEqual(sales);
  });

  it('drops sales outside the 0.4x..3x band around the full-window median', () => {
    // median of [10,10,10,10,1,40] = 10 → keep 4..30
    expect(withoutOutliers([10, 10, 10, 10, 1, 40], (s) => s)).toEqual([10, 10, 10, 10]);
  });

  it('keeps the drop only when at least two survive', () => {
    const sales = [1, 1, 100, 100];
    // median 50.5 → band 20.2..151.5 keeps only the two 100s
    expect(withoutOutliers(sales, (s) => s)).toEqual([100, 100]);
    // …but a band that would leave one survivor is abandoned wholesale
    // (median 500.5 → band 200.2..1501.5 keeps only the 1000)
    expect(withoutOutliers([1, 1, 1000, 5000], (s) => s)).toEqual([1, 1, 1000, 5000]);
  });

  it('passes a genuine 60% crash through', () => {
    expect(withoutOutliers([100, 100, 100, 40], (s) => s)).toEqual([100, 100, 100, 40]);
  });
});

describe('enforceMonotonic', () => {
  it('leaves an already-ordered ladder completely untouched', () => {
    const quotes = [
      quote('NM', { price: 10 }),
      quote('LP', { price: 8 }),
      quote('MP', { price: 5 }),
      quote('HP', { price: 3 }),
      quote('DM', { price: 1 }),
    ];
    enforceMonotonic(quotes);
    expect(quotes.map((q) => q.price)).toEqual([10, 8, 5, 3, 1]);
    expect(quotes.every((q) => q.note === undefined)).toBe(true);
  });

  it('pools the documented Type: Null ladder (.39/.25/.08/.23/.27) into order', () => {
    const quotes = [
      quote('NM', { price: 0.39 }),
      quote('LP', { price: 0.25 }),
      quote('MP', { price: 0.08 }),
      quote('HP', { price: 0.23 }),
      quote('DM', { price: 0.27 }),
    ];
    enforceMonotonic(quotes);
    // MP/HP/DM contradicted each other, so they pool to their weighted mean
    // ((0.08+0.23+0.27)/3 = 0.19). NM and LP were never in violation.
    expect(quotes.map((q) => q.price)).toEqual([0.39, 0.25, 0.19, 0.19, 0.19]);
    const prices = quotes.map((q) => q.price as number);
    for (let i = 1; i < prices.length; i++) expect(prices[i]).toBeLessThanOrEqual(prices[i - 1]);
    expect(quotes[0].note).toBeUndefined();
    expect(quotes[2].note).toMatch(/levelled with neighbouring conditions/);
  });

  it('weights rungs by their evidence — an estimate bends, real solds lead', () => {
    const quotes = [
      quote('NM', { price: 1, salesUsed: 1 }),
      quote('LP', { price: 5, salesUsed: 9 }),
    ];
    enforceMonotonic(quotes);
    // (1*1 + 5*9)/10 = 4.6, pulled hard toward the nine-sale rung
    expect(quotes.map((q) => q.price)).toEqual([4.6, 4.6]);
  });

  it('skips rungs with no price', () => {
    const quotes = [quote('NM', { price: null }), quote('LP', { price: 3 })];
    enforceMonotonic(quotes);
    expect(quotes.map((q) => q.price)).toEqual([null, 3]);
  });
});

describe('quoteAll — TCGplayer-anchored ladder (PokéDebut rule)', () => {
  it('shows TCGplayer rungs exactly and scales the gaps from the NEAREST rung', async () => {
    // Abra Shadowless-style steep vintage ladder: TCGplayer publishes NM and
    // HP; LP/MP/DM have no market and no solds.
    const pricer = stubPricer({
      markets: {
        'normal|Near Mint': market(10.65),
        'normal|Heavily Played': market(1.08),
      },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });

    expect(quotes.NM).toMatchObject({ price: 10.65, source: 'tcg_market', estimated: false });
    expect(quotes.HP).toMatchObject({ price: 1.08, source: 'tcg_market', estimated: false });

    // LP + MP are nearest to NM (above); DM is nearest to HP (below).
    expect(quotes.LP).toMatchObject({ price: 9.05, source: 'scaled', estimated: true });
    expect(quotes.MP).toMatchObject({ price: 7.46, source: 'scaled', estimated: true });
    expect(quotes.DM).toMatchObject({ price: 0.79, source: 'scaled', estimated: true });

    // The whole point: DM from the HP rung is $0.79, not NM × 0.4 = $4.26.
    expect(quotes.DM!.price).toBeLessThan(10.65 * 0.4);
    expect(quotes.DM!.note).toContain('scaled from its HP market');
  });

  it('never "corrects" TCGplayer, even when its own ladder inverts', async () => {
    const pricer = stubPricer({
      markets: {
        'normal|Near Mint': market(5),
        'normal|Moderately Played': market(9), // TCGplayer says MP > NM
      },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM!.price).toBe(5);
    expect(quotes.MP!.price).toBe(9);
  });

  it('clamps a scaled rung between its trusted neighbours', async () => {
    const pricer = stubPricer({
      markets: {
        'normal|Near Mint': market(10),
        'normal|Damaged': market(9), // a flat ladder
      },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    // NM × 0.85 = 8.5 would dip UNDER the trusted DM rung, so it is clamped up.
    expect(quotes.LP!.price).toBe(9);
    expect(quotes.HP!.price).toBe(9);
  });

  it('keeps a rung that has real solds of its own', async () => {
    const pricer = stubPricer({
      markets: { 'normal|Near Mint': market(10) },
      solds: { MP: [4, 4, 4] },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: 10, source: 'tcg_market' });
    expect(quotes.MP).toMatchObject({ price: 4, source: 'sales' });
    expect(quotes.LP).toMatchObject({ source: 'scaled' });
  });
});

describe('quoteAll — BinderPricer fallback ladder (no TCGplayer market)', () => {
  it('prices each condition off its own solds, then forces the order', async () => {
    const pricer = stubPricer({
      markets: null,
      solds: { NM: [0.39], LP: [0.25], MP: [0.08], HP: [0.23], DM: [0.27] },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(CODES.map((c) => quotes[c]!.price)).toEqual([0.39, 0.25, 0.19, 0.19, 0.19]);
    expect(quotes.NM!.source).toBe('sales');
  });

  it('scales conditions with no solds of their own from the ones that have them', async () => {
    const pricer = stubPricer({ markets: null, solds: { NM: [100] } });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: 100, source: 'sales' });
    expect(quotes.LP).toMatchObject({ price: 85, source: 'sales_adj', estimated: true });
    expect(quotes.DM).toMatchObject({ price: 40, source: 'sales_adj', estimated: true });
    expect(quotes.LP!.note).toContain('no recent LP solds');
  });

  it('returns a null price rather than inventing one', async () => {
    const pricer = stubPricer({ markets: null });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: null, source: 'none' });
  });
});
