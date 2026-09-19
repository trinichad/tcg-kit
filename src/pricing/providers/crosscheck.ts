// Origin: BinderPricer server/core/crosscheck.ts @ e995c9e.
// Changed: module-level UA / cache become `ctx` (factory `createCrossCheck`).
// Sources, thresholds and the null-on-anything-else rule are untouched.
//
// Independent reference prices from free, server-reachable per-game JSON APIs —
// for cross-checking TCGplayer/PriceCharting (a "second opinion" / consensus)
// and as a raw-price fallback when the primary source has nothing.
//
// Why these and not 130point/eBay-scraping: 130point and sportscardspro sit
// behind a Cloudflare bot-challenge that 403s any server-side fetch (verified),
// and eBay's sold-listings API is partner-gated. Scryfall and YGOPRODeck are
// open JSON APIs with no auth and no Cloudflare — they actually work server-side.
//
//   MTG → Scryfall     USD / USD-foil / EUR      https://scryfall.com/docs/api
//   YGO → YGOPRODeck   TCGplayer / Cardmarket / eBay   db.ygoprodeck.com
//
// Pokémon / One Piece / Lorcana have no comparably-open free price API; their
// prices already come from tcgcsv, so cross-check returns null for them. Every
// call is guarded (null on failure) and cached, exactly like the other sources.

import type { PricingCtx } from '../context';
import { nameSim } from '../match';
import type { CrossCheck, CrossPrice, Game } from '../types';

const HOUR = 3600_000;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? parseFloat(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

interface ScryCard {
  name?: string;
  set_name?: string;
  scryfall_uri?: string;
  prices?: { usd?: string | null; usd_foil?: string | null; eur?: string | null };
}

interface YgoCard {
  name?: string;
  card_prices?: {
    tcgplayer_price?: string;
    cardmarket_price?: string;
    ebay_price?: string;
  }[];
}

export type CrossChecker = ReturnType<typeof createCrossCheck>;

export function createCrossCheck(ctx: PricingCtx) {
  const headers = { 'user-agent': ctx.userAgent, accept: 'application/json' };

  async function scryfall(name: string): Promise<CrossCheck | null> {
    return ctx.cached(`xcheck:scry:${name.toLowerCase()}`, 6 * HOUR, async () => {
      try {
        // Fuzzy name match returns the most relevant printing. Good enough for
        // a reference value; matchedName lets callers see which printing.
        const r = await ctx.fetchRetry(
          `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
          { headers },
        );
        if (!r.ok) return null;
        const c = (await r.json()) as ScryCard;
        if (!c.name || nameSim(name, c.name) < 0.5) return null;
        const prices: CrossPrice[] = [];
        const usd = num(c.prices?.usd);
        const usdFoil = num(c.prices?.usd_foil);
        const eur = num(c.prices?.eur);
        if (usd) prices.push({ currency: 'USD', price: usd, label: 'market' });
        if (usdFoil) prices.push({ currency: 'USD', price: usdFoil, label: 'foil' });
        if (eur) prices.push({ currency: 'EUR', price: eur, label: 'Cardmarket' });
        if (!prices.length) return null;
        return {
          source: 'Scryfall',
          matchedName: `${c.name}${c.set_name ? ` · ${c.set_name}` : ''}`,
          prices,
          url: c.scryfall_uri,
        };
      } catch (err) {
        console.error('[crosscheck] scryfall failed', err);
        return null;
      }
    });
  }

  async function ygoprodeck(name: string): Promise<CrossCheck | null> {
    return ctx.cached(`xcheck:ygo:${name.toLowerCase()}`, 6 * HOUR, async () => {
      try {
        const r = await ctx.fetchRetry(
          `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`,
          { headers },
        );
        // 400 = no exact card by that name; try a fuzzy search fallback.
        let card: YgoCard | undefined;
        if (r.ok) card = ((await r.json()) as { data?: YgoCard[] }).data?.[0];
        if (!card) {
          const fr = await ctx.fetchRetry(
            `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`,
            { headers },
          );
          if (!fr.ok) return null;
          const list = ((await fr.json()) as { data?: YgoCard[] }).data ?? [];
          card = list.find((c) => c.name && nameSim(name, c.name) >= 0.6) ?? list[0];
        }
        if (!card?.name || nameSim(name, card.name) < 0.5) return null;
        const p = card.card_prices?.[0];
        const prices: CrossPrice[] = [];
        const tcg = num(p?.tcgplayer_price);
        const cm = num(p?.cardmarket_price);
        const ebay = num(p?.ebay_price);
        if (tcg) prices.push({ currency: 'USD', price: tcg, label: 'TCGplayer' });
        if (ebay) prices.push({ currency: 'USD', price: ebay, label: 'eBay' });
        if (cm) prices.push({ currency: 'EUR', price: cm, label: 'Cardmarket' });
        if (!prices.length) return null;
        return {
          source: 'YGOPRODeck',
          matchedName: card.name,
          prices,
          url: `https://ygoprodeck.com/card/?search=${encodeURIComponent(card.name)}`,
        };
      } catch (err) {
        console.error('[crosscheck] ygoprodeck failed', err);
        return null;
      }
    });
  }

  /**
   * Independent reference prices for a card from a free per-game API, or null
   * when the game has no such source (Pokémon / One Piece / Lorcana) or the
   * lookup fails. Never throws.
   */
  async function crossCheck(game: Game | 'other', name: string): Promise<CrossCheck | null> {
    if (!name?.trim()) return null;
    if (game === 'magic') return scryfall(name);
    if (game === 'yugioh') return ygoprodeck(name);
    return null;
  }

  return { crossCheck };
}
