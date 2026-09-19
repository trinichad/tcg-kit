#!/usr/bin/env tsx
// Phase L probes — ported from PokedexDebut execution/probe_tcgcsv.mjs and
// execution/probe_tcglive.mjs.
// Changed: .mjs → .ts, the UA comes from TCG_KIT_USER_AGENT (or the package
// default), and a final pass runs the library's own `healthcheck()` so a green
// endpoint AND a green code path are both proven. The raw fetches stay raw on
// purpose: a probe must fail because the ENDPOINT changed, not because our
// wrapper did.
//
//   npx tsx scripts/probes.ts      exit 0 = links green, exit 1 = broken link

import { createPricing, DEFAULT_CHROME_USER_AGENT, DEFAULT_USER_AGENT } from '../src/pricing/index';

const UA = process.env.TCG_KIT_USER_AGENT || DEFAULT_USER_AGENT;
const CHROME_UA = DEFAULT_CHROME_USER_AGENT;
const BASE = 'https://tcgcsv.com/tcgplayer';
const POKEMON = 3; // TCGplayer category: Pokémon (English)
const BULBASAUR = 42387; // Base Set 44/102 — the reference product for every probe
const NM = 1; // TCGplayer condition ids: 1 NM · 2 LP · 3 MP · 4 HP · 5 DM

let broken = 0;
const fail = (msg: string) => {
  console.error(`✗ ${msg}`);
  broken++;
  throw new ProbeFailure(msg);
};
class ProbeFailure extends Error {}

const LIVE_HEADERS = {
  'user-agent': CHROME_UA,
  accept: 'application/json',
  'content-type': 'application/json',
  origin: 'https://www.tcgplayer.com',
  referer: 'https://www.tcgplayer.com/',
};

// ── Probe 1: tcgcsv ─────────────────────────────────────────────────────────
// The free daily mirror of TCGplayer's catalog and market prices. Proves the
// endpoints answer with the identifying User-Agent (tcgcsv BLOCKS
// browser-impersonating UAs) and that the fields the engine depends on exist.

async function probeTcgCsv(): Promise<void> {
  const get = async (path: string) => {
    const t0 = Date.now();
    const r = await fetch(`${BASE}${path}`, {
      headers: { 'user-agent': UA, accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) fail(`HTTP ${r.status} for ${path}`);
    const body = (await r.json()) as { results?: Record<string, unknown>[] };
    return { results: body.results ?? [], ms: Date.now() - t0 };
  };

  const groups = await get(`/${POKEMON}/groups`);
  console.log(`✓ groups: ${groups.results.length} Pokémon sets (${groups.ms} ms)`);

  const base = groups.results.find((g) => g.name === 'Base Set') as
    | { groupId: number }
    | undefined;
  if (!base) fail('"Base Set" group not found in the groups list');

  const products = await get(`/${POKEMON}/${base!.groupId}/products`);
  const prices = await get(`/${POKEMON}/${base!.groupId}/prices`);
  console.log(
    `✓ Base Set (groupId ${base!.groupId}): ${products.results.length} products, ${prices.results.length} price rows (${products.ms + prices.ms} ms)`,
  );

  const bulba = products.results.find((p) => p.productId === BULBASAUR) as
    | { name: string; extendedData?: { name: string; value: string }[] }
    | undefined;
  if (!bulba) fail(`productId ${BULBASAUR} (Bulbasaur) missing from Base Set products`);
  const number = bulba!.extendedData?.find((d) => d.name === 'Number')?.value;
  if (!number) fail('product has no "Number" in extendedData — index mapping depends on it');

  const row = prices.results.find((p) => p.productId === BULBASAUR) as
    | { subTypeName: string; marketPrice: number; lowPrice: number; midPrice: number; highPrice: number }
    | undefined;
  if (!row || typeof row.marketPrice !== 'number') {
    fail(`no market price row for productId ${BULBASAUR}`);
  }
  console.log(
    `✓ ${bulba!.name} #${number}: ${row!.subTypeName} market $${row!.marketPrice} (low $${row!.lowPrice}, mid $${row!.midPrice}, high $${row!.highPrice})`,
  );
  console.log('LINK GREEN: tcgcsv');
}

// ── Probe 2: TCGplayer's unofficial site endpoints ──────────────────────────
// Proves per-condition solds come back AND the condition filter is honoured,
// and that live listings come back. Request shapes are BinderPricer's.

async function probeTcgLive(): Promise<void> {
  const post = async (url: string, body: unknown) => {
    const t0 = Date.now();
    const r = await fetch(url, {
      method: 'POST',
      headers: LIVE_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) fail(`HTTP ${r.status} for ${url}`);
    return { body: (await r.json()) as Record<string, any>, ms: Date.now() - t0 };
  };

  const sales = await post(
    `https://mpapi.tcgplayer.com/v2/product/${BULBASAUR}/latestsales?mpfev=3000`,
    { conditions: [NM], languages: [], variants: [], listingType: 'All', offset: 0, limit: 25 },
  );
  const solds = ((sales.body.data ?? []) as { purchasePrice?: number; condition?: string; orderDate?: string }[]).filter(
    (s) => typeof s.purchasePrice === 'number',
  );
  if (!solds.length) fail('latestsales returned no NM solds for Bulbasaur');
  const offGrade = solds.filter((s) => s.condition !== 'Near Mint');
  if (offGrade.length) {
    fail(`condition filter not honoured: ${offGrade.length} non-NM solds in an NM query`);
  }
  console.log(
    `✓ latestsales: ${solds.length} NM solds (${sales.ms} ms) — newest: ` +
      solds
        .slice(0, 3)
        .map((s) => `$${s.purchasePrice} on ${(s.orderDate ?? '').slice(0, 10)}`)
        .join(', '),
  );

  const listings = await post(
    `https://mp-search-api.tcgplayer.com/v1/product/${BULBASAUR}/listings`,
    {
      filters: {
        term: { sellerStatus: 'Live', channelId: 0 },
        range: { quantity: { gte: 1 } },
        exclude: { channelExclusion: 0 },
      },
      from: 0,
      size: 5,
      sort: { field: 'price+shipping', order: 'asc' },
      context: { shippingCountry: 'US', cart: {} },
    },
  );
  const rows = (listings.body.results?.[0]?.results ?? []) as { price: number; condition: string }[];
  if (!rows.length) fail('listings returned no rows');
  console.log(
    `✓ listings: ${rows.length} live asks (${listings.ms} ms) — cheapest $${rows[0].price} ${rows[0].condition}`,
  );
  console.log('LINK GREEN: tcgplayer site endpoints');
}

// ── Probe 3: per-condition market (infinite-api price history) ──────────────
// The PRIMARY price source. WAF-guarded — one call here, nothing more.

async function probeSkuHistory(): Promise<void> {
  const t0 = Date.now();
  const r = await fetch(
    `https://infinite-api.tcgplayer.com/price/history/${BULBASAUR}/detailed?range=month`,
    {
      headers: {
        'user-agent': CHROME_UA,
        accept: 'application/json',
        origin: 'https://www.tcgplayer.com',
        referer: 'https://www.tcgplayer.com/',
      },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!r.ok) fail(`HTTP ${r.status} from price/history`);
  const body = (await r.json()) as {
    result?: { variant?: string; condition?: string; language?: string; buckets?: { marketPrice?: number | string }[] }[];
  };
  const ms = Date.now() - t0;
  const skus = (body.result ?? []).filter((s) => (s.language ?? 'English') === 'English');
  const nm = skus.find((s) => s.variant === 'Normal' && s.condition === 'Near Mint');
  const nmMarket = Number(nm?.buckets?.find((b) => Number(b.marketPrice) > 0)?.marketPrice);
  if (!(nmMarket > 0)) fail('price/history returned no Near Mint market for Bulbasaur Normal');
  console.log(
    `✓ price/history: ${skus.length} SKUs (${ms} ms) — Normal · Near Mint market $${nmMarket}; conditions: ${skus
      .filter((s) => s.variant === 'Normal')
      .map((s) => s.condition)
      .join(', ')}`,
  );
  console.log('LINK GREEN: tcgplayer price/history');
}

// ── The library's own healthcheck ───────────────────────────────────────────

async function probeHealthcheck(): Promise<void> {
  const pricing = createPricing({
    userAgent: UA,
    tokens: { pricecharting: process.env.PRICECHARTING_API_TOKEN },
  });
  const results = await pricing.healthcheck();
  for (const h of results) {
    console.log(`${h.ok ? '✓' : '✗'} healthcheck ${h.name}: ${h.ms} ms — ${h.note ?? ''}`);
    if (!h.ok) broken++;
  }
}

(async () => {
  for (const probe of [probeTcgCsv, probeTcgLive, probeSkuHistory]) {
    try {
      await probe();
    } catch (err) {
      if (!(err instanceof ProbeFailure)) {
        console.error(`✗ ${probe.name} threw:`, err);
        broken++;
      }
    }
  }
  console.log('\n— library healthcheck —');
  await probeHealthcheck();
  console.log(broken ? `\n${broken} BROKEN LINK(S)` : '\nALL LINKS GREEN');
  process.exit(broken ? 1 : 0);
})();
