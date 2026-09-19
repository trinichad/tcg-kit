// Origin: BinderPricer server/core/ebay.ts @ e995c9e.
// Changed: the EBAY_CLIENT_ID / EBAY_CLIENT_SECRET env reads become
// `config.tokens.ebay`; module-level cache/fetch become `ctx`; `Buffer` gave
// way to `btoa` so the bundle stays platform-neutral. Query sanitising,
// filters and the low/median maths are untouched.
//
// eBay Browse API — current LIVE listings (asking prices) for any card or slab
// by keyword. A universal fallback for when TCGplayer/PriceCharting have no
// match at all (e.g. graded cards PriceCharting doesn't carry: Ash Blossom,
// Accesscode Talker, thinly-graded MTG).
//
// IMPORTANT: Browse returns active ASKS, not sold prices. eBay's sold data
// (Marketplace Insights API) is gated to approved partners, so this is "what
// it's currently listed for", not "what it sold for" — label it as such so the
// number is never mistaken for a realized sale.
//
// Auth: OAuth2 client-credentials. Create a free eBay developer app keyset at
// https://developer.ebay.com and pass the *Production* client id/secret as
// `tokens.ebay`. With no credentials every call returns null and the fallback
// is simply off.

import type { PricingCtx } from '../context';

const TOKEN_URL = 'https://api.ebay.com/identity/v1/oauth2/token';
const SEARCH_URL = 'https://api.ebay.com/buy/browse/v1/item_summary/search';
const SCOPE = 'https://api.ebay.com/oauth/api_scope';
const MIN = 60_000;

interface RawItem {
  title?: string;
  price?: { value?: string };
  shippingOptions?: { shippingCost?: { value?: string } }[];
  condition?: string;
  itemWebUrl?: string;
}

export interface EbayListing {
  title: string;
  price: number;
  shipping: number | null;
  condition: string;
  url: string;
}

export interface EbayAsks {
  count: number;
  low: number;
  median: number;
  items: EbayListing[]; // cheapest few, for display
  url: string; // eBay search page for the same query
}

function toListing(it: RawItem): EbayListing | null {
  const price = it.price?.value ? parseFloat(it.price.value) : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;
  const shipRaw = it.shippingOptions?.[0]?.shippingCost?.value;
  const shipping = shipRaw != null ? parseFloat(shipRaw) : null;
  return {
    title: it.title ?? '',
    price,
    shipping: Number.isFinite(shipping as number) ? (shipping as number) : null,
    condition: it.condition ?? '',
    url: it.itemWebUrl ?? '',
  };
}

const basicAuth = (id: string, secret: string): string => btoa(`${id}:${secret}`);

export type Ebay = ReturnType<typeof createEbay>;

export function createEbay(ctx: PricingCtx) {
  function creds(): { id: string; secret: string } | null {
    // eBay's portal labels the client id "App ID (Client ID)" and the secret
    // "Cert ID (Client Secret)".
    const id = (ctx.tokens.ebay?.clientId ?? '').trim();
    const secret = (ctx.tokens.ebay?.clientSecret ?? '').trim();
    return id && secret ? { id, secret } : null;
  }

  /** True when eBay Browse credentials are configured. */
  function ebayConfigured(): boolean {
    return creds() != null;
  }

  async function token(): Promise<string | null> {
    const c = creds();
    if (!c) return null;
    // App tokens last ~2h; cache 90m. Keyed on the id so rotated creds re-fetch.
    return ctx.cached(`ebay:token:${c.id}`, 90 * MIN, async () => {
      try {
        const r = await ctx.fetchRetry(TOKEN_URL, {
          method: 'POST',
          headers: {
            authorization: `Basic ${basicAuth(c.id, c.secret)}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`,
        });
        if (!r.ok) {
          console.error(`[ebay] token ${r.status}`);
          return null;
        }
        const j = (await r.json()) as { access_token?: string };
        return j.access_token ?? null;
      } catch (err) {
        console.error('[ebay] token failed', err);
        return null;
      }
    });
  }

  /**
   * Current eBay asks for a free-text query (cheapest first), or null when
   * eBay isn't configured / unreachable / has no fixed-price listings.
   * `median` and `low` include shipping.
   */
  async function ebayAsks(query: string, limit = 25): Promise<EbayAsks | null> {
    // eBay's search treats "&" and other punctuation as operators/noise — an
    // unsanitised "Ash Blossom & Joyous Spring" returns zero hits. Strip to
    // plain words + the chars that matter in card numbers (. - /).
    const q = query.replace(/&/g, ' ').replace(/[^\w\s.\-/]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!q) return null;
    const t = await token();
    if (!t) return null;
    return ctx.cached(`ebay:search:${q.toLowerCase()}`, 15 * MIN, async () => {
      try {
        // Buy-It-Now + best-offer listings are usable "asks" (auctions mid-bid
        // aren't); sort by price so `low` is the cheapest.
        const url =
          `${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${limit}` +
          `&filter=${encodeURIComponent('buyingOptions:{FIXED_PRICE|BEST_OFFER}')}&sort=price`;
        const r = await ctx.fetchRetry(url, {
          headers: {
            authorization: `Bearer ${t}`,
            'content-type': 'application/json',
            'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
          },
        });
        if (!r.ok) {
          console.error(`[ebay] search ${r.status}`);
          return null;
        }
        const j = (await r.json()) as { itemSummaries?: RawItem[] };
        const items = (j.itemSummaries ?? [])
          .map(toListing)
          .filter((x): x is EbayListing => x != null);
        if (!items.length) return null;
        const totals = items.map((i) => i.price + (i.shipping ?? 0)).sort((a, b) => a - b);
        return {
          count: items.length,
          low: Math.round(totals[0] * 100) / 100,
          median: Math.round(totals[Math.floor(totals.length / 2)] * 100) / 100,
          items: items.slice(0, 5),
          url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sop=15`,
        };
      } catch (err) {
        console.error('[ebay] search failed', err);
        return null;
      }
    });
  }

  return { ebayAsks, ebayConfigured };
}
