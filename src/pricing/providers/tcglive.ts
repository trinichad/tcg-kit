// Origin: BinderPricer server/core/tcglive.ts @ e995c9e.
// Changed: module-level UA / limiter / cache become `ctx` (factory
// `createTcgLive`); the per-SKU market endpoint moved to ./tcgplayer-sku.ts
// because it has its own, much stricter pacing. Request shapes untouched.
//
// Unofficial TCGplayer site endpoints (the same ones tcgplayer.com's own
// frontend calls). No auth, but not a published API — every call is guarded
// and returns null on failure so callers can fall back to tcgcsv data.

import type { PricingCtx } from '../context';
import type { Game, SaleSample } from '../types';

const MIN = 60_000;

export interface SearchHit {
  productId: number;
  productName: string;
  setName: string;
  setCode: string;
  setId: number | null;
  productLineName: string;
  rarityName: string;
  number: string;
  marketPrice: number | null;
  lowestPrice: number | null;
  sealed: boolean;
}

interface RawSearchHit {
  productId?: number;
  productName?: string;
  setName?: string;
  setCode?: string;
  setId?: number;
  productLineName?: string;
  rarityName?: string;
  marketPrice?: number;
  lowestPrice?: number;
  sealed?: boolean;
  customAttributes?: { number?: string | null } | null;
}

// productLineName values as used by tcgplayer's search filter. Multiple
// entries act as OR; unknown entries are ignored by the API, so the Dragon
// Ball list covers both spellings of each line to be safe.
const PRODUCT_LINE: Record<Game, string[]> = {
  pokemon: ['pokemon'],
  magic: ['magic'],
  yugioh: ['yugioh'],
  lorcana: ['disney lorcana'],
  onepiece: ['one piece card game'],
  dragonball: [
    'dragon ball super ccg',
    'dragon ball super: masters',
    'dragon ball super fusion world',
    'dragon ball super: fusion world',
    'dragon ball z tcg',
  ],
  sports: [], // not on TCGplayer — priced via sportscardspro.com instead
};

/** Search product-line filter for a game hint (language-aware). */
export function linesFor(game: Game | undefined, language?: string): string[] | undefined {
  if (!game) return undefined;
  const lines = [...(PRODUCT_LINE[game] ?? [])];
  if (game === 'pokemon' && language && /japan/i.test(language)) lines.push('pokemon japan');
  return lines.length ? lines : undefined;
}

export interface ListingRow {
  price: number;
  shipping: number | null;
  condition: string;
  variant: string;
  quantity: number;
  /** A custom (photo) listing: the seller's own title/description, which may not be the plain product. */
  custom: boolean;
  /** The seller's own words on a custom listing (title + description, tags stripped); '' otherwise. */
  title: string;
}

interface RawListing {
  price?: number;
  shippingPrice?: number;
  condition?: string;
  printing?: string;
  quantity?: number;
  /** 'standard' | 'custom' — a custom listing carries the seller's photos and text. */
  listingType?: string;
  customData?: { title?: string | null; description?: string | null } | null;
}

/** A custom listing's title + description as plain text (the description arrives HTML-escaped). */
export function sellerText(c: RawListing['customData']): string {
  return [c?.title, c?.description]
    .filter(Boolean)
    .join(' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

interface RawSale {
  condition?: string;
  variant?: string;
  language?: string;
  quantity?: number;
  purchasePrice?: number;
  orderDate?: string;
  /** 'ListingWithPhotos' (a custom listing) | 'ListingWithoutPhotos'. */
  listingType?: string;
  /** The seller's own title for a photo listing; the product name otherwise. */
  title?: string;
}

export type TcgLive = ReturnType<typeof createTcgLive>;

export function createTcgLive(ctx: PricingCtx) {
  /** Headers TCGplayer's own frontend sends — browser UA + tcgplayer origin. */
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    'user-agent': ctx.chromeUserAgent,
    accept: 'application/json',
    origin: 'https://www.tcgplayer.com',
    referer: 'https://www.tcgplayer.com/',
    ...extra,
  });

  async function postJson<T>(url: string, body: unknown): Promise<T | null> {
    return ctx.limitTcgLive(async () => {
      try {
        const r = await ctx.fetchRetry(url, {
          method: 'POST',
          headers: headers({ 'content-type': 'application/json' }),
          body: JSON.stringify(body),
        });
        if (!r.ok) {
          console.error(`[tcglive] ${r.status} from ${url}`);
          return null;
        }
        return (await r.json()) as T;
      } catch (err) {
        console.error(`[tcglive] request failed: ${url}`, err);
        return null;
      }
    });
  }

  // ── Search (mp-search-api) ────────────────────────────────────────────────

  async function rawSearch(
    q: string,
    lines: string[] | undefined,
    size: number,
  ): Promise<RawSearchHit[] | null> {
    const url = `https://mp-search-api.tcgplayer.com/v1/search/request?q=${encodeURIComponent(q)}&isList=false`;
    const filters: Record<string, unknown> = { term: {}, range: {}, match: {} };
    if (lines?.length) (filters.term as Record<string, unknown>).productLineName = lines;
    const body = {
      algorithm: 'revenue_synonym_v2',
      from: 0,
      size,
      filters,
      listingSearch: {
        context: { cart: {} },
        filters: {
          term: { sellerStatus: 'Live', channelId: 0 },
          range: { quantity: { gte: 1 } },
          exclude: { channelExclusion: 0 },
        },
      },
      context: { cart: {}, shippingCountry: 'US' },
      settings: { useFuzzySearch: true, didYouMean: {} },
      sort: {},
    };
    const resp = await postJson<{ results?: { results?: RawSearchHit[] }[] }>(url, body);
    if (!resp) return null;
    return resp.results?.[0]?.results ?? [];
  }

  /**
   * Search the TCGplayer catalog. Returns null when the endpoint is
   * unreachable (callers then fall back to tcgcsv catalog matching).
   */
  async function searchProducts(
    q: string,
    lines?: string[],
    size = 12,
  ): Promise<SearchHit[] | null> {
    const key = `search:${lines?.join('|') ?? 'all'}:${size}:${q.toLowerCase()}`;
    return ctx.cached(key, 5 * MIN, async () => {
      let raw = await rawSearch(q, lines, size);
      if (raw === null) return null;
      // A too-strict product-line filter can zero out results; retry unfiltered.
      if (raw.length === 0 && lines?.length) raw = (await rawSearch(q, undefined, size)) ?? [];
      return raw
        .filter((h) => typeof h.productId === 'number')
        .map((h) => ({
          productId: h.productId as number,
          productName: h.productName ?? '',
          setName: h.setName ?? '',
          setCode: h.setCode ?? '',
          setId: typeof h.setId === 'number' ? h.setId : null,
          productLineName: h.productLineName ?? '',
          rarityName: h.rarityName ?? '',
          number: h.customAttributes?.number ?? '',
          marketPrice: typeof h.marketPrice === 'number' ? h.marketPrice : null,
          lowestPrice: typeof h.lowestPrice === 'number' ? h.lowestPrice : null,
          sealed: h.sealed === true,
        }));
    });
  }

  // ── Current listings (mp-search-api) ──────────────────────────────────────

  /**
   * Live asks for a product, cheapest (price+shipping) first — one pool across
   * all conditions/printings; callers post-filter. Returns null when the
   * endpoint is unreachable.
   */
  async function currentListings(productId: number): Promise<ListingRow[] | null> {
    return ctx.cached(`listings:${productId}`, 10 * MIN, async () => {
      // The endpoint caps size at 50 (larger → 400); page twice for depth so
      // higher conditions still appear when cheap damaged copies fill page one.
      const page = (from: number) =>
        postJson<{ results?: { results?: RawListing[]; totalResults?: number }[] }>(
          `https://mp-search-api.tcgplayer.com/v1/product/${productId}/listings`,
          {
            filters: {
              term: { sellerStatus: 'Live', channelId: 0 },
              range: { quantity: { gte: 1 } },
              exclude: { channelExclusion: 0 },
            },
            from,
            size: 50,
            sort: { field: 'price+shipping', order: 'asc' },
            context: { shippingCountry: 'US', cart: {} },
          },
        );
      const first = await page(0);
      if (!first) return null;
      const head = first.results?.[0];
      let raw = head?.results ?? [];
      if (raw.length === 50 && (head?.totalResults ?? 0) > 50) {
        const second = await page(50);
        raw = raw.concat(second?.results?.[0]?.results ?? []);
      }
      return raw
        .filter((l) => typeof l.price === 'number')
        .map((l) => ({
          price: l.price as number,
          shipping: typeof l.shippingPrice === 'number' ? l.shippingPrice : null,
          condition: l.condition ?? '',
          variant: l.printing ?? '',
          quantity: l.quantity ?? 1,
          custom: l.listingType === 'custom',
          title: l.listingType === 'custom' ? sellerText(l.customData) : '',
        }));
    });
  }

  // ── Latest sales (mpapi) ──────────────────────────────────────────────────

  /**
   * Most recent sold listings for a product (newest first). Pass a TCGplayer
   * condition id (1 NM · 2 LP · 3 MP · 4 HP · 5 DM — verified live) to get the
   * last solds in that exact condition rather than a mixed pool.
   * Returns null when the endpoint is unreachable.
   */
  async function latestSales(
    productId: number,
    conditionId?: number,
  ): Promise<SaleSample[] | null> {
    return ctx.cached(`sales:${productId}:${conditionId ?? 'all'}`, 10 * MIN, async () => {
      const resp = await postJson<{ data?: RawSale[] }>(
        `https://mpapi.tcgplayer.com/v2/product/${productId}/latestsales?mpfev=3000`,
        {
          conditions: conditionId ? [conditionId] : [],
          languages: [],
          variants: [],
          listingType: 'All',
          offset: 0,
          limit: 25,
        },
      );
      if (!resp) return null;
      return (resp.data ?? [])
        .filter((s) => typeof s.purchasePrice === 'number')
        .map((s) => ({
          date: s.orderDate ?? '',
          price: s.purchasePrice as number,
          condition: s.condition ?? '',
          variant: s.variant ?? '',
          custom: s.listingType === 'ListingWithPhotos',
          title: s.listingType === 'ListingWithPhotos' ? (s.title ?? '').slice(0, 200) : '',
        }));
    });
  }

  return { headers, searchProducts, currentListings, latestSales };
}
