// Ladder maths, offline. Every provider here is a stub — nothing in this file
// touches the network. The clock is frozen so recency weights are exact.
//
// The metric under test (Chad, 2026-09-22): a sale from months ago must not
// set the price, the live listings must be considered, and a price can never
// sit above the cheapest copy a customer could buy right now.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASK_DISCOUNT,
  askFloorOf,
  createPricer,
  enforceMonotonic,
  ladderFromEvidence,
  priceFromEvidence,
  recencyWeight,
  weightedMedian,
  withoutOutliers,
  type Priced,
  type QuoteEvidence,
} from '../../src/pricing/pricing';
import { CONDITION_NAME } from '../../src/pricing/index';
import { skuMarketFor, type SkuMarket, type SkuMarkets } from '../../src/pricing/providers/tcgplayer-sku';
import type { PricingCtx } from '../../src/pricing/context';
import type { CsvPrice, TcgCsv } from '../../src/pricing/providers/tcgcsv';
import type { ListingRow, TcgLive } from '../../src/pricing/providers/tcglive';
import type { TcgPlayerSku } from '../../src/pricing/providers/tcgplayer-sku';
import type { ConditionCode, ConditionQuotes, PriceQuote, SaleSample } from '../../src/pricing/index';

const CODES: ConditionCode[] = ['NM', 'LP', 'MP', 'HP', 'DM'];
const DAY = 86_400_000;
/** The frozen clock: the day BinderPricer's fixture was captured. */
const NOW = Date.parse('2026-09-23T00:53:17.957Z');
const daysAgo = (d: number) => new Date(NOW - d * DAY).toISOString();

const sale = (price: number, ageDays: number, condition = 'Near Mint', variant = 'Normal'): SaleSample => ({
  date: daysAgo(ageDays),
  price,
  condition,
  variant,
});
const ask = (price: number, condition = 'Near Mint', shipping = 0, variant = 'Normal'): ListingRow => ({
  price,
  shipping,
  condition,
  variant,
  quantity: 1,
});
const row = (marketPrice: number | null, subTypeName = 'Normal'): CsvPrice => ({
  productId: 1,
  lowPrice: null,
  midPrice: null,
  highPrice: null,
  marketPrice,
  subTypeName,
});
/** A TCGplayer SKU market; `soldDaysAgo` lists the days copies sold in the month window. */
const market = (m: number, soldDaysAgo: number[] = [1]): SkuMarket => ({
  market: m,
  sold: soldDaysAgo.length,
  asOf: daysAgo(0).slice(0, 10),
  sales: soldDaysAgo.map((d) => ({ date: daysAgo(d).slice(0, 10), quantity: 1 })),
});

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
const priced = (condition: ConditionCode, p: Partial<PriceQuote>, weight = 1): Priced => ({
  quote: quote(condition, p),
  weight,
  anchor: true,
});

const monotone = (l: ConditionQuotes) =>
  CODES.every((c, i) => i === 0 || (l[c]?.price ?? 0) <= (l[CODES[i - 1]]?.price ?? 0) + 0.005);

/** A pricer whose only data is what the test hands it. */
function stubPricer(opts: {
  markets?: SkuMarkets | null;
  /** condition code → solds in that exact condition */
  solds?: Partial<Record<ConditionCode, SaleSample[]>>;
  listings?: ListingRow[];
  rows?: CsvPrice[];
}) {
  const csv = { prices: async () => opts.rows ?? [] } as unknown as TcgCsv;
  const live = {
    currentListings: async () => opts.listings ?? [],
    latestSales: async (_productId: number, conditionId?: number): Promise<SaleSample[]> => {
      if (!conditionId) return [];
      const code = CODES[conditionId - 1];
      return opts.solds?.[code] ?? [];
    },
  } as unknown as TcgLive;
  const sku = {
    skuMarkets: async () => opts.markets ?? null,
    skuMarketFor,
  } as unknown as TcgPlayerSku;
  return createPricer({ now: () => NOW } as PricingCtx, { csv, live, sku });
}

function evidence(per: Partial<Record<ConditionCode, Partial<QuoteEvidence>>>, shared: Partial<QuoteEvidence> = {}) {
  return Object.fromEntries(
    CODES.map((c) => [
      c,
      { market: null, exact: [], mixed: [], listings: [], rows: [], now: NOW, ...shared, ...(per[c] ?? {}) } satisfies QuoteEvidence,
    ]),
  ) as Record<ConditionCode, QuoteEvidence>;
}
const one = (condition: ConditionCode, ev: Partial<QuoteEvidence>, salesCount = 3) =>
  priceFromEvidence({ productId: 1, categoryId: 3, groupId: 1, subType: 'Normal', condition, salesCount }, {
    market: null,
    exact: [],
    mixed: [],
    listings: [],
    rows: [],
    now: NOW,
    ...ev,
  });
const ladder = (per: Parameters<typeof evidence>[0], shared?: Partial<QuoteEvidence>) =>
  ladderFromEvidence({ productId: 1, categoryId: 3, groupId: 1, subType: 'Normal', salesCount: 3 }, evidence(per, shared));

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

describe('recency, medians and floors', () => {
  it('a sale today is a full vote, two weeks old half, a month a quarter', () => {
    expect(recencyWeight(0)).toBeCloseTo(1, 9);
    expect(recencyWeight(14)).toBeCloseTo(0.5, 9);
    expect(recencyWeight(28)).toBeCloseTo(0.25, 9);
    expect(recencyWeight(56)).toBeCloseTo(0.0625, 9);
  });

  it('weightedMedian is the plain median with equal weights and lets the fresher sale win otherwise', () => {
    expect(weightedMedian([250, 299.97].map((value) => ({ value, weight: 1 })))).toBe(274.985);
    expect(weightedMedian([3, 1, 2].map((value) => ({ value, weight: 1 })))).toBe(2);
    expect(weightedMedian([{ value: 250, weight: 0.51 }, { value: 299.97, weight: 0.79 }])).toBe(299.97);
    // one fresh lowball among fresh sales does not set the price
    expect(weightedMedian([{ value: 100, weight: 0.98 }, { value: 40, weight: 0.89 }, { value: 100, weight: 0.79 }])).toBe(100);
  });

  it('askFloor is the cheapest item price and skips only a lone ask under a tenth of the next', () => {
    expect(askFloorOf([{ price: 2 }, { price: 1.99 }, { price: 5 }])).toBe(1.99);
    expect(askFloorOf([{ price: 1 }, { price: 50 }, { price: 52 }])).toBe(50);
    expect(askFloorOf([{ price: 185 }, { price: 399 }, { price: 445 }])).toBe(185);
    expect(askFloorOf([{ price: 199.99 }, { price: 600 }])).toBe(199.99);
  });
});

describe('enforceMonotonic', () => {
  it('leaves an already-ordered ladder completely untouched', () => {
    const rungs = [10, 8, 5, 3, 1].map((price, i) => priced(CODES[i], { price }));
    enforceMonotonic(rungs);
    expect(rungs.map((p) => p.quote.price)).toEqual([10, 8, 5, 3, 1]);
    expect(rungs.every((p) => p.quote.note === undefined)).toBe(true);
  });

  it('pools the documented Type: Null ladder (.39/.25/.08/.23/.27) into order', () => {
    const rungs = [0.39, 0.25, 0.08, 0.23, 0.27].map((price, i) => priced(CODES[i], { price }));
    enforceMonotonic(rungs);
    // MP/HP/DM contradicted each other, so they pool to their weighted mean
    // ((0.08+0.23+0.27)/3 = 0.19). NM and LP were never in violation.
    expect(rungs.map((p) => p.quote.price)).toEqual([0.39, 0.25, 0.19, 0.19, 0.19]);
    expect(rungs[0].quote.note).toBeUndefined();
    expect(rungs[2].quote.note).toMatch(/levelled with neighbouring conditions/);
  });

  it('weights rungs by their evidence — a thin rung bends, a well-backed one leads', () => {
    const rungs = [priced('NM', { price: 1 }, 1), priced('LP', { price: 5 }, 9)];
    enforceMonotonic(rungs);
    // (1*1 + 5*9)/10 = 4.6, pulled hard toward the nine-vote rung
    expect(rungs.map((p) => p.quote.price)).toEqual([4.6, 4.6]);
  });

  it('skips rungs with no price', () => {
    const rungs = [priced('NM', { price: null }), priced('LP', { price: 3 })];
    enforceMonotonic(rungs);
    expect(rungs.map((p) => p.quote.price)).toEqual([null, 3]);
  });
});

describe("TCGplayer's own market as the sold level", () => {
  it('a fresh market that the asks agree with is shown exactly', () => {
    const p = one('NM', { market: market(139.99, [10]), listings: [ask(140), ask(159.99), ask(1212.88)] });
    expect(p.quote).toMatchObject({ price: 139.99, source: 'tcg_market', estimated: false });
    expect(p.quote.basis?.newestSaleDays).toBe(10);
  });

  it('a market with no sale in the month yields to the live asks (Zapdos LP: market $115.61, asks from $254.49)', () => {
    const p = one('LP', {
      market: market(115.61, []),
      listings: [ask(254.49, 'Lightly Played', 1.49), ask(266.66, 'Lightly Played')],
    });
    expect(p.quote.source).toBe('ask');
    expect(p.quote.estimated).toBe(true);
    expect(p.quote.price).toBeGreaterThanOrEqual(160);
    expect(p.quote.price).toBeLessThanOrEqual(254.49);
    expect(p.quote.note).toMatch(/no sale in the last month/);
  });

  it('is never above the cheapest delivered listing (Mewtwo DM: market $23.99, a $21.95 copy for sale)', () => {
    const p = one('DM', {
      market: market(23.99, [17, 20, 34]),
      listings: [ask(21.95, 'Damaged'), ask(23.97, 'Damaged'), ask(23.98, 'Damaged')],
    });
    expect(p.quote).toMatchObject({ price: 21.95, source: 'tcg_market', estimated: false });
    expect(p.quote.note).toMatch(/held at that ask/);
  });

  it('the cap is the delivered price, and sub-$2 listings never cap or pull a bulk common', () => {
    const shipped = one('NM', { market: market(3.2, [1]), listings: [ask(2.5, 'Near Mint', 0.99), ask(3.6), ask(3.7)] });
    expect(shipped.quote.basis?.askCap).toBe(3.49);
    expect(shipped.quote.price).toBeLessThanOrEqual(3.49);
    const bede = one('NM', {
      exact: [sale(0.18, 1), sale(0.2, 3), sale(0.18, 5)],
      listings: [ask(0.02, 'Near Mint', 1.31), ask(0.03, 'Near Mint', 1.31), ask(0.05)],
    });
    expect(bede.quote.price).toBeGreaterThanOrEqual(0.17);
    expect(bede.quote.basis?.askCap).toBeNull();
    expect(bede.quote.basis?.askWeight ?? 1).toBeLessThan(0.05);
  });
});

describe('solds ladder (no TCGplayer market)', () => {
  it('a liquid card is priced at its fresh solds — the blend is a no-op', () => {
    const p = one('NM', { exact: [sale(2, 0), sale(2, 1), sale(2, 2)], listings: [ask(2.1), ask(2.15), ask(2.25, 'Near Mint', 1.31)] });
    expect(p.quote.source).toBe('sales');
    expect(p.quote.note).toBeUndefined();
    expect(p.quote.price).toBeGreaterThanOrEqual(1.94);
    expect(p.quote.price).toBeLessThanOrEqual(2.06);
  });

  it('a stale lone sale yields to the asks; the same sale yesterday keeps the say', () => {
    const asks = [ask(30, 'Lightly Played'), ask(32, 'Lightly Played'), ask(35, 'Lightly Played')];
    const stale = one('LP', { exact: [sale(10, 90, 'Lightly Played')], listings: asks });
    expect(stale.quote.source).toBe('ask');
    expect(stale.quote.price).toBeGreaterThanOrEqual(23);
    expect(stale.quote.note).toMatch(/90 days ago/);
    const fresh = one('LP', { exact: [sale(10, 1, 'Lightly Played')], listings: asks });
    expect(fresh.quote.source).toBe('sales');
    expect(fresh.quote.price).toBeLessThan(20);
  });

  it('the bad-data tripwire discards a bogus sale — but only when the market price agrees it is absurd', () => {
    const bogus = one('NM', { exact: [sale(250, 1)], listings: [ask(4300), ask(4350), ask(4400)] });
    expect(bogus.quote).toMatchObject({ price: Math.round(4300 * ASK_DISCOUNT * 100) / 100, source: 'ask' });
    expect(bogus.quote.note).toMatch(/ignored a lone \$250/);
    const real = one('LP', { exact: [sale(125, 1, 'Lightly Played')], listings: [ask(858, 'Lightly Played'), ask(860, 'Lightly Played')], rows: [row(115)] });
    expect(real.quote.source).toBe('sales');
    expect(real.quote.price).toBeLessThan(200);
  });

  it('falls back to the product market only when there are neither solds nor asks', () => {
    expect(one('NM', { rows: [row(40)] }).quote).toMatchObject({ price: 40, source: 'market' });
    expect(one('LP', { rows: [row(40)] }).quote).toMatchObject({ price: 34, source: 'market_adj', estimated: true });
    expect(one('NM', { rows: [row(40)], listings: [ask(60), ask(61)] }).quote).toMatchObject({ price: 54, source: 'ask' });
  });

  it('prices each condition off its own solds, then forces the order', async () => {
    const pricer = stubPricer({
      markets: null,
      solds: {
        NM: [sale(0.39, 21)],
        LP: [sale(0.25, 21, 'Lightly Played')],
        MP: [sale(0.08, 21, 'Moderately Played')],
        HP: [sale(0.23, 21, 'Heavily Played')],
        DM: [sale(0.27, 21, 'Damaged')],
      },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(CODES.map((c) => quotes[c]!.price)).toEqual([0.39, 0.25, 0.19, 0.19, 0.19]);
    expect(quotes.NM!.source).toBe('sales');
  });

  it('scales conditions with no solds of their own from the nearest one that has them', async () => {
    const pricer = stubPricer({ markets: null, solds: { NM: [sale(100, 1)] } });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: 100, source: 'sales' });
    expect(quotes.LP).toMatchObject({ price: 85, source: 'sales_adj', estimated: true });
    expect(quotes.DM).toMatchObject({ price: 40, source: 'sales_adj', estimated: true });
    expect(quotes.LP!.note).toContain('no recent LP solds');
  });

  it('never overwrites a rung that has its own solds when NM leans on the asks (Mewtwo LV.X)', () => {
    const l = ladder(
      {
        NM: { exact: [sale(150, 92)] },
        LP: { exact: [sale(105, 1, 'Lightly Played'), sale(81, 43, 'Lightly Played'), sale(80, 47, 'Lightly Played')] },
        MP: { exact: [sale(46, 2, 'Moderately Played'), sale(48, 4, 'Moderately Played')] },
      },
      {
        listings: [ask(400), ask(410), ask(420), ask(105, 'Lightly Played'), ask(110, 'Lightly Played'), ask(45, 'Moderately Played')],
        rows: [row(110)],
      },
    );
    expect(l.NM!.source).toBe('ask');
    expect(l.NM!.price).toBeLessThanOrEqual(400);
    expect(l.LP).toMatchObject({ source: 'sales', price: 105 });
    expect(l.MP).toMatchObject({ source: 'sales', price: 45 });
    expect(l.HP!.source).toBe('sales_adj');
    expect(monotone(l)).toBe(true);
  });

  it('the other conditions expose a bogus NM sale the market price was fooled by (1st-Ed Charizard)', () => {
    const l = ladder(
      {
        NM: { exact: [sale(250, 1)] },
        LP: { exact: [sale(3000, 2, 'Lightly Played'), sale(3100, 9, 'Lightly Played')] },
      },
      { listings: [ask(4300), ask(4350), ask(4400), ask(3500, 'Lightly Played')], rows: [row(250)] },
    );
    expect(l.NM).toMatchObject({ source: 'ask', price: 3870 });
    expect(l.LP!.source).toBe('sales');
    expect(l.LP!.price).toBeLessThanOrEqual(3500);
  });

  it('a lone ask far above what the other conditions sell for is ignored (Tyrogue HP $4,321)', () => {
    const l = ladder(
      {
        NM: { exact: [sale(19.99, 1), sale(17, 3)] },
        LP: { exact: [sale(10.42, 3, 'Lightly Played'), sale(12, 5, 'Lightly Played')] },
        MP: { exact: [sale(13.98, 39, 'Moderately Played')] },
        HP: { exact: [sale(10, 39, 'Heavily Played')] },
        DM: { exact: [sale(9.99, 18, 'Damaged'), sale(4.5, 20, 'Damaged')] },
      },
      { listings: [ask(17), ask(18), ask(12, 'Lightly Played'), ask(12.01, 'Moderately Played'), ask(4321, 'Heavily Played'), ask(4.5, 'Damaged')], rows: [row(15)] },
    );
    expect(l.HP!.basis?.askWeight).toBe(0);
    expect(l.HP!.price).toBeLessThan(15);
    expect(monotone(l)).toBe(true);
  });

  it('returns a null price rather than inventing one', async () => {
    const pricer = stubPricer({ markets: null });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: null, source: 'none' });
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
      solds: { MP: [sale(4, 1, 'Moderately Played'), sale(4, 2, 'Moderately Played'), sale(4, 3, 'Moderately Played')] },
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM).toMatchObject({ price: 10, source: 'tcg_market' });
    expect(quotes.MP).toMatchObject({ price: 4, source: 'sales' });
    expect(quotes.LP).toMatchObject({ source: 'scaled' });
  });

  it("a cleaner grade's listing bounds the grades below it, and a rung of ours can't sit above a TCGplayer grade", async () => {
    const pricer = stubPricer({
      markets: { 'normal|Near Mint': market(100), 'normal|Lightly Played': market(110, [1, 2]) },
      solds: { MP: [sale(120, 1, 'Moderately Played'), sale(118, 2, 'Moderately Played')] },
      listings: [ask(100), ask(101), ask(102)],
    });
    const quotes = await pricer.quoteAll({ productId: 1, subType: 'Normal' });
    expect(quotes.NM!.price).toBe(100);
    // TCGplayer's LP $110 is not corrected as a number — but nobody pays it
    // when a Near Mint copy is listed at $100.
    expect(quotes.LP!.price).toBe(100);
    expect(quotes.LP!.note).toMatch(/cleaner copy can be bought/);
    // Our MP solds at $120 can't sit above TCGplayer's cleaner grades either.
    expect(quotes.MP!.price).toBeLessThanOrEqual(100);
  });
});

describe('replay of the six cards from BinderPricer (same engine, same answers)', () => {
  interface FixtureCard {
    name: string;
    productId: number;
    groupId: number;
    rows: CsvPrice[];
    salesByCond: Record<ConditionCode, SaleSample[] | null>;
    mixed: SaleSample[] | null;
    listings: ListingRow[] | null;
  }
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'binderpricer-cases.json'), 'utf8')) as {
    capturedAt: string;
    cards: Record<string, FixtureCard>;
  };
  const at = Date.parse(fixture.capturedAt);
  const replay = (productId: number, subType: string) => {
    const card = fixture.cards[String(productId)];
    const ev = Object.fromEntries(
      CODES.map((c) => [
        c,
        {
          market: null,
          exact: card.salesByCond[c] ?? [],
          mixed: card.mixed ?? [],
          listings: card.listings ?? [],
          rows: card.rows,
          now: at,
        } satisfies QuoteEvidence,
      ]),
    ) as Record<ConditionCode, QuoteEvidence>;
    return ladderFromEvidence({ productId, categoryId: 3, groupId: card.groupId, subType, salesCount: 3 }, ev);
  };

  it('Mewtwo LV.X: LP keeps its real solds (~$100), DM is held at the $21.95 listing, nothing is scaled from the NM ask', () => {
    const l = replay(87434, 'Holofoil');
    expect(l.LP!.source).toBe('sales');
    expect(l.LP!.price).toBeGreaterThanOrEqual(90);
    expect(l.LP!.price).toBeLessThanOrEqual(115);
    expect(l.DM!.price).toBe(21.95);
    expect(l.NM!.price).toBeGreaterThanOrEqual(150);
    expect(l.NM!.price).toBeLessThanOrEqual(190);
    expect(monotone(l)).toBe(true);
  });

  it('Zapdos Rumble: LP is no longer set by two-month-old solds', () => {
    const l = replay(90720, 'Normal');
    expect(l.LP!.source).toBe('ask');
    expect(l.LP!.price).toBeGreaterThanOrEqual(160);
    expect(l.LP!.price).toBeLessThanOrEqual(254.49);
    expect(l.NM!.price).toBeGreaterThanOrEqual(260);
    expect(monotone(l)).toBe(true);
  });

  it('Ho-Oh HGSS01: the played grades stay at their own solds and asks instead of NM × factor', () => {
    const l = replay(86125, 'Holofoil');
    expect(l.LP!.price).toBeGreaterThanOrEqual(28);
    expect(l.LP!.price).toBeLessThanOrEqual(45);
    expect(l.DM!.price).toBeGreaterThanOrEqual(9);
    expect(l.DM!.price).toBeLessThanOrEqual(12);
    expect(monotone(l)).toBe(true);
  });

  it('Tyranitar Expedition: a liquid ladder is left where its solds are', () => {
    const l = replay(90118, 'Normal');
    expect(l.NM!.price).toBeGreaterThanOrEqual(138);
    expect(l.NM!.price).toBeLessThanOrEqual(142);
    expect(l.DM!.price).toBeGreaterThanOrEqual(16);
    expect(l.DM!.price).toBeLessThanOrEqual(18);
    expect(monotone(l)).toBe(true);
  });
});
