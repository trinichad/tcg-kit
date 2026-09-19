// Origin: BinderPricer server/core/tcgcsv.ts @ e995c9e.
// Changed: module-level UA + `cached` become `ctx` (factory `createTcgCsv`);
// pure helpers (saneMarketPrice, extValue, gameForProductLine, findGroup's
// normalisers) stay module-level. Algorithms untouched.
//
// tcgcsv.com — free daily mirror of the TCGplayer catalog and market prices.
// Docs: https://tcgcsv.com  (no auth required)

import type { PricingCtx } from '../context';
import type { Game, GroupPrice, SubTypePrice } from '../types';

const BASE = 'https://tcgcsv.com/tcgplayer';
const HOUR = 3600_000;

export interface CsvCategory {
  categoryId: number;
  name: string;
  displayName?: string;
}

export interface CsvGroup {
  groupId: number;
  name: string;
  abbreviation?: string;
  categoryId: number;
}

export interface CsvProduct {
  productId: number;
  name: string;
  cleanName?: string;
  imageUrl?: string;
  url?: string;
  groupId: number;
  categoryId: number;
  extendedData?: { name: string; value: string }[];
}

export interface CsvPrice {
  productId: number;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
  marketPrice: number | null;
  subTypeName: string;
}

// Verified against the live categories endpoint; used if the name lookup
// fails. (sports has no TCGplayer category — priced via sportscardspro.com.)
const FALLBACK_CATEGORY: Partial<Record<Game, number>> = {
  magic: 1,
  yugioh: 2,
  pokemon: 3,
  dragonball: 27, // Dragon Ball Super CCG (Masters); Fusion World=80, DBZ=23
  onepiece: 68,
  lorcana: 71,
};

const GAME_PATTERNS: Partial<Record<Game, RegExp>> = {
  pokemon: /^pokemon$/i,
  magic: /^magic/i,
  yugioh: /yugioh|yu-gi-oh/i,
  lorcana: /lorcana/i,
  onepiece: /one piece/i,
  dragonball: /^dragon ball super ccg$/i,
};

const normLine = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Map a TCGplayer product-line name (e.g. "Pokemon") back to our Game id. */
export function gameForProductLine(line: string): Game | null {
  for (const [game, re] of Object.entries(GAME_PATTERNS) as [Game, RegExp][]) {
    if (re.test(line)) return game;
  }
  return null;
}

export function extValue(product: CsvProduct, name: string): string {
  return product.extendedData?.find((d) => d.name === name)?.value ?? '';
}

function normSet(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** TCGplayer fills low/mid/high (and sometimes market) with a 100000
 * placeholder when a printing has no real listings. Never surface it. */
const real = (n: number | null): number | null => (n != null && n > 0 && n !== 100000 ? n : null);

/**
 * TCGplayer's published market price can be stale nonsense on thin vintage
 * printings (e.g. 1st Ed Shadowless Venusaur: market $72.87 while the
 * CHEAPEST live listing is $825). When market is below half the lowest
 * listing, fall back to the mid/low listing price instead.
 */
export function saneMarketPrice(row: CsvPrice): { price: number | null; adjusted: boolean } {
  // TCGplayer fills low/mid/high (and sometimes market) with a 100000
  // placeholder when a printing has no real listings — e.g. 1st-Ed Base
  // Charizard: market $250 but low/mid/high all $100000. Never surface that
  // value, and never fall back TO it.
  const market = real(row.marketPrice);
  const low = real(row.lowPrice);
  const mid = real(row.midPrice);
  // No usable market but real listings exist → price off the listings.
  if (market == null) {
    return low != null || mid != null
      ? { price: mid ?? low, adjusted: true }
      : { price: null, adjusted: false };
  }
  // Market far below the cheapest REAL listing → stale market; use mid/low
  // instead (e.g. 1st-Ed Shadowless Venusaur: market $73 vs $825 listings).
  if (low != null && market < low * 0.5) {
    return { price: mid ?? low, adjusted: true };
  }
  return { price: market, adjusted: false };
}

export type TcgCsv = ReturnType<typeof createTcgCsv>;

export function createTcgCsv(ctx: PricingCtx) {
  async function getJson<T>(url: string): Promise<T> {
    const r = await ctx.fetch(url, {
      headers: { 'user-agent': ctx.userAgent, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) throw new Error(`tcgcsv ${r.status} for ${url}`);
    return r.json() as Promise<T>;
  }

  async function getResults<T>(url: string): Promise<T[]> {
    const body = await getJson<{ results?: T[] }>(url);
    return body.results ?? [];
  }

  const categories = (): Promise<CsvCategory[]> =>
    ctx.cached('csv:categories', 24 * HOUR, () => getResults<CsvCategory>(`${BASE}/categories`));

  const groups = (categoryId: number): Promise<CsvGroup[]> =>
    ctx.cached(`csv:groups:${categoryId}`, 12 * HOUR, () =>
      getResults<CsvGroup>(`${BASE}/${categoryId}/groups`),
    );

  const products = (categoryId: number, groupId: number): Promise<CsvProduct[]> =>
    ctx.cached(`csv:products:${categoryId}:${groupId}`, 24 * HOUR, () =>
      getResults<CsvProduct>(`${BASE}/${categoryId}/${groupId}/products`),
    );

  const prices = (categoryId: number, groupId: number): Promise<CsvPrice[]> =>
    ctx.cached(`csv:prices:${categoryId}:${groupId}`, 4 * HOUR, () =>
      getResults<CsvPrice>(`${BASE}/${categoryId}/${groupId}/prices`),
    );

  async function categoryIdForGame(game: Game): Promise<number> {
    const pattern = GAME_PATTERNS[game];
    if (pattern) {
      try {
        const cats = await categories();
        const hit = cats.find((c) => pattern.test(c.name) || pattern.test(c.displayName ?? ''));
        if (hit) return hit.categoryId;
      } catch {
        // fall through to the static map
      }
    }
    return FALLBACK_CATEGORY[game] ?? 0;
  }

  /**
   * Category id for a search hit's product line ("Pokemon Japan", "Dragon Ball
   * Super: Masters", …) — matches EVERY TCGplayer category dynamically, so
   * games outside the built-in enum still get catalog enrichment and prices.
   */
  async function categoryIdForLine(line: string): Promise<number | null> {
    const want = normLine(line);
    if (!want) return null;
    try {
      const cats = await categories();
      const hit =
        cats.find((c) => normLine(c.name) === want || normLine(c.displayName ?? '') === want) ??
        cats.find(
          (c) => normLine(c.displayName ?? '').includes(want) || want.includes(normLine(c.name)),
        );
      return hit?.categoryId ?? null;
    } catch {
      return null;
    }
  }

  /** Find a set (group) by name and/or abbreviation, tolerating loose input. */
  async function findGroup(
    categoryId: number,
    setName?: string,
    setCode?: string,
  ): Promise<CsvGroup | null> {
    const all = await groups(categoryId);
    const code = (setCode ?? '').trim().toLowerCase();
    if (code) {
      const byCode = all.find((g) => (g.abbreviation ?? '').toLowerCase() === code);
      if (byCode) return byCode;
    }
    const name = normSet(setName ?? '');
    if (!name) return null;
    const exact = all.find((g) => normSet(g.name) === name);
    if (exact) return exact;
    // Loose match: one contains the other; prefer the shortest group name so
    // "Base Set" beats "Base Set 2".
    const loose = all
      .filter((g) => {
        const gn = normSet(g.name);
        return gn.includes(name) || name.includes(gn);
      })
      .sort((a, b) => a.name.length - b.name.length);
    return loose[0] ?? null;
  }

  /** Printing variants + market prices for one product. */
  async function subTypesFor(
    categoryId: number,
    groupId: number,
    productId: number,
  ): Promise<SubTypePrice[]> {
    const rows = await prices(categoryId, groupId);
    return rows
      .filter((r) => r.productId === productId)
      .map((r) => ({ name: r.subTypeName, marketPrice: saneMarketPrice(r).price }));
  }

  async function productRow(
    categoryId: number,
    groupId: number,
    productId: number,
  ): Promise<CsvProduct | null> {
    const rows = await products(categoryId, groupId);
    return rows.find((p) => p.productId === productId) ?? null;
  }

  /**
   * NEW: every product's prices for a whole set in ONE call — the cheap way to
   * value a box of singles. Same sanitising as everywhere else.
   */
  async function groupPrices(categoryId: number, groupId: number): Promise<GroupPrice[]> {
    const rows = await prices(categoryId, groupId);
    return rows.map((r) => {
      const sane = saneMarketPrice(r);
      return {
        productId: r.productId,
        subType: r.subTypeName,
        market: sane.price,
        low: real(r.lowPrice),
        mid: real(r.midPrice),
        high: real(r.highPrice),
        adjusted: sane.adjusted,
      };
    });
  }

  return {
    categories,
    groups,
    products,
    prices,
    categoryIdForGame,
    categoryIdForLine,
    findGroup,
    subTypesFor,
    productRow,
    groupPrices,
  };
}
