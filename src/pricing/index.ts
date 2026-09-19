// @holo/tcg-kit/pricing — the public surface.
//
// Everything below is assembled from BinderPricer's server/core/* and api/* and
// PokedexDebut's execution/pricing/* (see each file's header for its origin).
// The only thing NEW here is the shape: one `createPricing(config)` instance
// owns its cache, its concurrency gates, its pacing state and its credentials,
// so nothing in this package reads `process.env` or shares module globals.

import { createContext } from './context';
import { createGradedPricer } from './graded';
import { imageUrl } from './helpers';
import { createMatch } from './match';
import { createPricer } from './pricing';
import { createCrossCheck } from './providers/crosscheck';
import { createEbay } from './providers/ebay';
import { createPriceCharting } from './providers/pricecharting';
import { createPsa } from './providers/psa';
import { createTcgCsv } from './providers/tcgcsv';
import { createTcgLive } from './providers/tcglive';
import { createSkuMarkets } from './providers/tcgplayer-sku';
import { pickSubType } from './subtype';
import type {
  ConditionCode,
  ConditionQuotes,
  CrossCheck,
  Game,
  GradedQuery,
  GroupPrice,
  HealthResult,
  PriceQuote,
  PriceRef,
  PricedCard,
  PricingConfig,
  ProductMatch,
  ResolveRequestCard,
  ResolveResult,
} from './types';
import { confidenceOf } from './helpers';
import { limitMap } from './util';

export interface TcgPricing {
  /** Free-text / TCGplayer-URL product search. */
  search(q: string, game?: Game): Promise<{ results: ProductMatch[]; note?: string }>;
  /** Identify one card (name / set / number / printing) → a TCGplayer product. */
  resolveCard(q: ResolveRequestCard): Promise<ResolveResult>;
  resolveMany(qs: ResolveRequestCard[], opts?: { concurrency?: number }): Promise<ResolveResult[]>;
  /** Add catalog data (printings, canonical number/rarity/image) to a match. */
  enrich(match: ProductMatch, setCode?: string): Promise<ProductMatch>;
  /** One product, one printing, one condition. */
  price(ref: PriceRef): Promise<PriceQuote>;
  /** All five conditions, cross-checked against each other. */
  priceAll(ref: Omit<PriceRef, 'condition'>): Promise<ConditionQuotes>;
  /** Many refs; respects provider pacing and never throws per item. */
  priceMany(refs: PriceRef[], opts?: { concurrency?: number }): Promise<(PriceQuote | null)[]>;
  /** A graded slab, or raw eBay comps with `grader: 'RAW'`. */
  priceGraded(q: GradedQuery): Promise<PriceQuote>;
  /** A second opinion from an independent per-game API (MTG/YGO only). */
  crossCheck(game: Game, name: string): Promise<CrossCheck | null>;
  /** Every product's prices for one set, in one call. */
  groupPrices(categoryId: number, groupId: number): Promise<GroupPrice[]>;
  /** resolve → pickSubType → priceAll, in one call. */
  lookupPrice(q: ResolveRequestCard & { condition?: ConditionCode }): Promise<PricedCard>;
  /** Are the upstreams answering? One cheap call each. */
  healthcheck(): Promise<HealthResult[]>;
}

export function createPricing(config: PricingConfig = {}): TcgPricing {
  const ctx = createContext(config);
  const csv = createTcgCsv(ctx);
  const live = createTcgLive(ctx);
  const sku = createSkuMarkets(ctx);
  const pc = createPriceCharting(ctx);
  const psa = createPsa(ctx);
  const ebay = createEbay(ctx);
  const xcheck = createCrossCheck(ctx);
  const matcher = createMatch(ctx, { csv, live });
  const pricer = createPricer(ctx, { csv, live, sku });
  const graded = createGradedPricer(ctx, { pc, psa, ebay });

  async function timed(name: string, fn: () => Promise<string | null>): Promise<HealthResult> {
    const t0 = Date.now();
    try {
      const note = await fn();
      return { name, ok: note !== null, ms: Date.now() - t0, note: note ?? 'no data' };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - t0, note: String((err as Error)?.message ?? err) };
    }
  }

  return {
    search: (q, game) => matcher.manualSearch(q, game),
    resolveCard: (q) => matcher.resolveCard(q),

    async resolveMany(qs, opts) {
      const out = await limitMap(qs, opts?.concurrency ?? 4, (q) => matcher.resolveCard(q));
      return out.map(
        (r, i) =>
          r ?? {
            cell: qs[i]?.cell ?? 0,
            status: 'none' as const,
            best: null,
            candidates: [],
            note: 'resolve failed',
          },
      );
    },

    enrich: (match, setCode) => matcher.enrichMatch(match, setCode),
    price: (ref) => pricer.quote(ref),
    priceAll: (ref) => pricer.quoteAll(ref),

    /**
     * Bounded-concurrency pricing. The per-SKU market endpoint paces itself
     * (one request at a time, ≥1.2s apart) regardless of what is passed here,
     * so a big batch is rate-limited by that, not by this number. Per-item
     * failures become `null` rather than rejecting the batch.
     */
    priceMany: (refs, opts) => limitMap(refs, opts?.concurrency ?? 4, (ref) => pricer.quote(ref)),

    priceGraded: (q) => graded.priceGraded(q),
    crossCheck: (game, name) => xcheck.crossCheck(game, name),
    groupPrices: (categoryId, groupId) => csv.groupPrices(categoryId, groupId),

    async lookupPrice(q): Promise<PricedCard> {
      const condition = q.condition ?? 'NM';
      const resolved = await matcher.resolveCard(q);
      if (!resolved.best) {
        return {
          match: null,
          quotes: {},
          confidence: null,
          subType: '',
          condition,
          status: resolved.status,
          note: resolved.note,
        };
      }
      const subType = pickSubType(q.printing ?? '', resolved.best.subTypes);
      const quotes = await pricer.quoteAll({
        productId: resolved.best.productId,
        categoryId: resolved.best.categoryId,
        groupId: resolved.best.groupId,
        subType,
      });
      const picked = quotes[condition];
      return {
        match: resolved.best,
        quotes,
        confidence: picked ? confidenceOf(picked) : null,
        subType,
        condition,
        status: resolved.status,
        note: resolved.note ?? picked?.note,
      };
    },

    /**
     * Ported from PokéDebut's Phase-L probes (execution/probe_tcgcsv.mjs and
     * probe_tcglive.mjs): the same reference product (Base Set Bulbasaur,
     * 42387) and the same "is the field we depend on actually there" checks.
     */
    healthcheck(): Promise<HealthResult[]> {
      const POKEMON = 3;
      const BULBASAUR = 42387; // Base Set 44/102 — the reference product
      return Promise.all([
        timed('tcgcsv', async () => {
          const gs = await csv.groups(POKEMON);
          const base = gs.find((g) => g.name === 'Base Set');
          if (!base) return null;
          const rows = await csv.prices(POKEMON, base.groupId);
          const row = rows.find((r) => r.productId === BULBASAUR);
          if (!row || typeof row.marketPrice !== 'number') return null;
          return `${gs.length} Pokémon sets; Bulbasaur ${row.subTypeName} market $${row.marketPrice}`;
        }),
        timed('tcglive search', async () => {
          const hits = await live.searchProducts('Charizard Base Set', ['pokemon'], 5);
          if (!hits?.length) return null;
          return `${hits.length} hits; top ${hits[0].productName}`;
        }),
        timed('tcgplayer-sku', async () => {
          const markets = await sku.skuMarkets(BULBASAUR);
          if (!markets) return null;
          const nm = sku.skuMarketFor(markets, 'Normal', 'Near Mint');
          if (!nm) return null;
          return `${Object.keys(markets).length} SKUs; Normal · Near Mint $${nm.market} (${nm.asOf})`;
        }),
        timed('pricecharting', async () => {
          const hits = await pc.pcSearch('Charizard Base Set');
          if (!hits?.length) return null;
          return `${hits.length} hits; top /${hits[0].setSlug}/${hits[0].productSlug}`;
        }),
      ]);
    },
  };
}

// ── Pure exports (no instance needed) ───────────────────────────────────────

export { assignTier, confidenceOf, fromCents, imageUrl, toCents, withBuffer } from './helpers';
export {
  currentEdition,
  editionKey,
  mergedEditions,
  pickSubType,
  type MergedEdition,
} from './subtype';
export {
  nameSim,
  normNum,
  normNumber,
  normText,
  numMatch,
  numberScore,
  numberTokens,
  numberTotal,
  numberingOk,
  splitProductName,
} from './match';
export {
  ALL_CONDITIONS,
  CONDITION_ID,
  CONDITION_NAME,
  FACTOR,
  enforceMonotonic,
  withoutOutliers,
} from './pricing';
export { saneMarketPrice, extValue, gameForProductLine } from './providers/tcgcsv';
export { gradeLabelFor, scorePcHit } from './providers/pricecharting';
export { createMemoryCache } from './cache';
export { median, round2 } from './util';
export { CATEGORY_ID, INDEX_GAMES, type IndexGame } from './catalogues-lite';
export {
  DEFAULT_CHROME_USER_AGENT,
  DEFAULT_USER_AGENT,
  SKU_DEFAULT_COOLDOWN_MS,
  SKU_DEFAULT_MIN_INTERVAL_MS,
} from './context';

export type {
  CacheStore,
  ConditionCode,
  ConditionQuotes,
  CrossCheck,
  CrossPrice,
  Game,
  GradedInfo,
  GradedQuery,
  GroupPrice,
  HealthResult,
  ListingSample,
  PriceConfidence,
  PriceQuote,
  PriceRef,
  PricedCard,
  PricingConfig,
  ProductMatch,
  PsaLookupError,
  PsaVerify,
  ResolveRequestCard,
  ResolveResult,
  SaleSample,
  SubTypePrice,
  TierRule,
} from './types';
export { CONDITIONS, GRADERS, GRADES } from './types';
export type { CsvCategory, CsvGroup, CsvPrice, CsvProduct } from './providers/tcgcsv';
export type { SearchHit, ListingRow } from './providers/tcglive';
export type { SkuMarket, SkuMarkets, SkuState } from './providers/tcgplayer-sku';
export type { PcCardQuery, PcData, PcHost, PcSale, PcSearchHit } from './providers/pricecharting';
export type { EbayAsks, EbayListing } from './providers/ebay';
export type { PsaLookup } from './providers/psa';
