#!/usr/bin/env tsx
// Origin: BinderPricer scripts/canary.ts @ e995c9e.
// Changed: it calls `createPricing()` directly instead of an HTTP server (so
// there is no CANARY_BASE and no /api/config probe — tokens come from env
// HERE, the only place in this package allowed to read env); `trustedSource`
// now also accepts `tcg_market`, because TCGplayer's own per-condition market
// is rung 0 of the quote chain and is MORE trustworthy than solds, not less.
// Fixtures, floors, ceilings and exit codes are unchanged.
//
// Correctness monitor. Unlike a reachability ping, this ASSERTS the invariants
// that mean "the data is still correct" and exits non-zero on any regression.
//
// What it catches:
//  - a card that used to resolve cleanly now resolving to the WRONG product
//    (mis-identification) or degrading to `uncertain`
//  - the PriceCharting HTML changing shape so the graded parser silently
//    returns nothing (price → null)
//  - a raw price quietly falling back to a market estimate when it should be
//    coming from real solds / TCGplayer's own market
//
// Run:  npx tsx scripts/canary.ts
// Exit code 0 = all good · 1 = at least one regression · 2 = upstreams down.
// Skips (e.g. sports without a PriceCharting token) never fail the run.

import { createPricing } from '../src/pricing/index';
import type { PriceQuote, ProductMatch, ResolveRequestCard } from '../src/pricing/index';

type Status = 'matched' | 'uncertain' | 'none';
const RANK: Record<Status, number> = { matched: 2, uncertain: 1, none: 0 };

// A raw-card expectation. `minStatus` is the WORST acceptable identification
// outcome — dropping below it (a clean match going uncertain/wrong) is a
// regression. `minPrice`/`maxPrice` are deliberately wide: they exist to catch
// a broken parser returning $0.01 or $999999, NOT to track normal market drift.
interface RawCase {
  label: string;
  card: ResolveRequestCard;
  name: string; // resolved product name must contain this
  number?: string; // resolved collector number must match this core
  minStatus: Status; // usually 'matched'; 'uncertain' blesses a known-imperfect case
  trustedSource?: boolean; // require a real lookup, not a market estimate (default true)
  minPrice?: number;
  maxPrice?: number;
}

interface GradedCase {
  label: string;
  q: { grader: string; grade: string; name: string; setName?: string; number?: string; variant?: string; game?: string };
  slug: string; // PriceCharting product slug must contain this
  minPrice?: number;
  maxPrice?: number;
  sports?: boolean; // skip (not fail) when no PriceCharting token is configured
}

// Collector-number core: numerator, zero-stripped, lowercased, with any
// trailing rarity tag dropped. "004/102" → "4", "FB01-003" → "fb01-003",
// "BT1-010 R" → "bt1-010".
const coreNum = (s: string) =>
  s.toLowerCase().trim().replace(/\s+[a-z]{1,3}$/, '').split('/')[0].replace(/\s+/g, '').replace(/^0+(?=\d)/, '');

const RAW: RawCase[] = [
  { label: 'PKM vintage: Charizard Base Set 4/102 holo', name: 'Charizard', number: '4/102', minStatus: 'matched', minPrice: 150, card: { cell: 1, game: 'pokemon', name: 'Charizard', setName: 'Base Set', number: '4/102', printing: 'holofoil' } },
  { label: 'PKM chase: Umbreon VMAX Evolving Skies 215/203 alt', name: 'Umbreon VMAX', number: '215/203', minStatus: 'matched', minPrice: 500, card: { cell: 1, game: 'pokemon', name: 'Umbreon VMAX', setName: 'Evolving Skies', number: '215/203', printing: 'holofoil alternate art' } },
  { label: 'PKM modern: Iono Paldea Evolved 185/193 full art', name: 'Iono', number: '185/193', minStatus: 'matched', card: { cell: 1, game: 'pokemon', name: 'Iono', setName: 'Paldea Evolved', number: '185/193', printing: 'full art' } },
  // Japanese card (real: Koraidon ex 050/078 in SV1S Scarlet ex) — exercises
  // the pokemon-japan product line.
  { label: 'PKM JP: Koraidon ex 050/078 Scarlet ex', name: 'Koraidon', number: '050/078', minStatus: 'matched', card: { cell: 1, game: 'pokemon', name: 'Koraidon ex', setName: 'Scarlet ex', number: '050/078', printing: 'holofoil', language: 'Japanese' } },
  { label: 'OP: Monkey.D.Luffy OP01-003 alt-art leader', name: 'Luffy', number: 'OP01-003', minStatus: 'matched', minPrice: 200, card: { cell: 1, game: 'onepiece', name: 'Monkey.D.Luffy', setName: 'Romance Dawn', setCode: 'OP01', number: 'OP01-003', printing: 'foil alternate art' } },
  { label: 'OP: Shanks OP01-120 secret', name: 'Shanks', number: 'OP01-120', minStatus: 'matched', card: { cell: 1, game: 'onepiece', name: 'Shanks', setName: 'Romance Dawn', setCode: 'OP01', number: 'OP01-120', printing: 'foil' } },
  { label: 'OP: Zoro-Juurou OP05-067 SP', name: 'Zoro', number: 'OP05-067', minStatus: 'matched', minPrice: 100, card: { cell: 1, game: 'onepiece', name: 'Zoro-Juurou', setCode: 'OP09', number: 'OP05-067', printing: 'foil special alternate art' } },
  { label: 'YGO: Blue-Eyes White Dragon LOB-001', name: 'Blue-Eyes', number: 'LOB-001', minStatus: 'matched', card: { cell: 1, game: 'yugioh', name: 'Blue-Eyes White Dragon', setName: 'Legend of Blue Eyes White Dragon', setCode: 'LOB', number: 'LOB-001', printing: 'holofoil' } },
  { label: 'YGO: Ash Blossom RA01-EN008', name: 'Ash Blossom', number: 'RA01-EN008', minStatus: 'matched', card: { cell: 1, game: 'yugioh', name: 'Ash Blossom & Joyous Spring', setName: '25th Anniversary Rarity Collection', number: 'RA01-EN008', printing: 'holofoil' } },
  { label: 'MTG: Sol Ring Commander 2021', name: 'Sol Ring', number: '263', minStatus: 'matched', card: { cell: 1, game: 'magic', name: 'Sol Ring', setName: 'Commander 2021', number: '263', printing: 'normal' } },
  { label: 'MTG: Ragavan MH2 138', name: 'Ragavan', number: '138', minStatus: 'matched', card: { cell: 1, game: 'magic', name: 'Ragavan, Nimble Pilferer', setName: 'Modern Horizons 2', number: '138', printing: 'normal' } },
  // Thin-market card — legitimately flaps between real solds and the market
  // price as its sparse solds age out, so don't require a solds source.
  { label: 'LOR: Elsa - Spirit of Winter TFC 42/204', name: 'Elsa', number: '42/204', minStatus: 'matched', trustedSource: false, card: { cell: 1, game: 'lorcana', name: 'Elsa - Spirit of Winter', setName: 'The First Chapter', number: '42/204', printing: 'normal' } },
  { label: 'DBS FW: Son Goku FB01-001 Leader', name: 'Son Goku', number: 'FB01-001', minStatus: 'matched', trustedSource: false, card: { cell: 1, game: 'dragonball', name: 'Son Goku', setName: 'Awakened Pulse', number: 'FB01-001', printing: 'foil' } },
  { label: 'OTHER: Agumon BT1-010 (Digimon)', name: 'Agumon', number: 'BT1-010', minStatus: 'matched', card: { cell: 1, game: 'other', name: 'Agumon', setName: 'Release Special Booster', number: 'BT1-010', printing: 'normal' } },
];

const GRADED: GradedCase[] = [
  { label: 'PSA 10 Moonbreon', slug: 'umbreon-vmax', minPrice: 1500, q: { grader: 'PSA', grade: '10', name: 'Umbreon VMAX', setName: 'Evolving Skies', number: '215/203', variant: 'alternate art' } },
  { label: 'PSA 8 vintage Charizard', slug: 'charizard-4', minPrice: 400, q: { grader: 'PSA', grade: '8', name: 'Charizard', setName: 'Base Set', number: '4/102', variant: 'holo' } },
  { label: 'PSA 10 Blue-Eyes LOB', slug: 'blue-eyes', minPrice: 1000, q: { grader: 'PSA', grade: '10', name: 'Blue-Eyes White Dragon', setName: 'Legend of Blue Eyes White Dragon', number: 'LOB-001', variant: 'holofoil' } },
  { label: 'PSA 10 Elsa (Lorcana)', slug: 'elsa', minPrice: 5, q: { grader: 'PSA', grade: '10', name: 'Elsa - Spirit of Winter', setName: 'The First Chapter', number: '42/204', variant: '' } },
  { label: 'BGS 9.5 Charizard', slug: 'charizard-4', minPrice: 500, q: { grader: 'BGS', grade: '9.5', name: 'Charizard', setName: 'Base Set', number: '4/102', variant: 'holo' } },
  { label: 'BGS 10 Charizard', slug: 'charizard-4', minPrice: 1000, q: { grader: 'BGS', grade: '10', name: 'Charizard', setName: 'Base Set', number: '4/102', variant: 'holo' } },
  { label: 'CGC 9 Pikachu Jungle', slug: 'pikachu', minPrice: 5, q: { grader: 'CGC', grade: '9', name: 'Pikachu', setName: 'Jungle', number: '60/64', variant: '' } },
  { label: 'CGC 10 Moonbreon', slug: 'umbreon-vmax', minPrice: 1000, q: { grader: 'CGC', grade: '10', name: 'Umbreon VMAX', setName: 'Evolving Skies', number: '215/203', variant: 'alternate art' } },
  { label: 'SGC 10 Charizard', slug: 'charizard-4', minPrice: 1000, q: { grader: 'SGC', grade: '10', name: 'Charizard', setName: 'Base Set', number: '4/102', variant: 'holo' } },
  { label: 'PSA 10 Luffy OP01-003', slug: 'luffy', minPrice: 1000, q: { grader: 'PSA', grade: '10', name: 'Monkey.D.Luffy', setName: 'Romance Dawn', number: 'OP01-003', variant: 'alternate art parallel' } },
  { label: 'BGS 9.5 Ragavan MH2', slug: 'ragavan', minPrice: 10, q: { grader: 'BGS', grade: '9.5', name: 'Ragavan, Nimble Pilferer', setName: 'Modern Horizons 2', number: '138', variant: '' } },
  { label: 'RAW comps: Charizard Base Set', slug: 'charizard-4', minPrice: 100, q: { grader: 'RAW', grade: '', name: 'Charizard', setName: 'Base Set', number: '4/102', variant: 'holo' } },
  // Sports need a PriceCharting API token — skipped, not failed, when absent.
  { label: 'PSA 10 Doncic Prizm #280', slug: 'luka-doncic', sports: true, q: { grader: 'PSA', grade: '10', game: 'sports', name: 'Luka Doncic', setName: '2018 Panini Prizm', number: '280', variant: 'base' } },
  { label: 'PSA 9 Mike Trout 2011 Topps Update', slug: 'mike-trout', sports: true, q: { grader: 'PSA', grade: '9', game: 'sports', name: 'Mike Trout', setName: '2011 Topps Update', number: 'US175', variant: 'base' } },
];

interface Line { status: 'PASS' | 'FAIL' | 'SKIP'; label: string; detail: string; problems: string[] }

// scripts/ is the ONLY place in this package that reads process.env.
const pricing = createPricing({
  userAgent: process.env.TCG_KIT_USER_AGENT || undefined,
  tokens: {
    pricecharting: process.env.PRICECHARTING_API_TOKEN,
    psa: process.env.PSA_API_TOKEN,
    ebay:
      (process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID) &&
      (process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID)
        ? {
            clientId: (process.env.EBAY_CLIENT_ID || process.env.EBAY_APP_ID) as string,
            clientSecret: (process.env.EBAY_CLIENT_SECRET || process.env.EBAY_CERT_ID) as string,
          }
        : undefined,
  },
});

/** Sources that mean "a real lookup happened", not "we estimated". */
const REAL_SOURCES: PriceQuote['source'][] = ['tcg_market', 'sales', 'sales_adj'];

async function checkRaw(c: RawCase): Promise<Line> {
  const problems: string[] = [];
  const r = await pricing.resolveCard({ printing: '', language: 'English', ...c.card });

  if (!r.best) {
    return { status: 'FAIL', label: c.label, detail: `no match (${r.note ?? '-'})`, problems: ['no product matched'] };
  }
  if (RANK[r.status] < RANK[c.minStatus]) {
    problems.push(`identification ${r.status} < required ${c.minStatus} (→ ${r.best.name})`);
  }
  if (!r.best.name.toLowerCase().includes(c.name.toLowerCase())) {
    problems.push(`name "${r.best.name}" missing "${c.name}"`);
  }
  if (c.number && coreNum(r.best.number) !== coreNum(c.number)) {
    problems.push(`number "${r.best.number}" ≠ expected "${c.number}"`);
  }

  // Price it (every condition; NM is the assertion).
  const m: ProductMatch = r.best;
  const quotes = await pricing.priceAll({
    productId: m.productId,
    categoryId: m.categoryId,
    groupId: m.groupId,
    subType: m.subTypes[0]?.name ?? 'Market',
    salesCount: 5,
  });
  const nm = quotes.NM;
  const price = nm?.price ?? null;
  const source = nm?.source ?? 'none';

  if (price == null) problems.push('no NM price');
  else {
    if (price <= 0) problems.push(`nonsense price ${price}`);
    if (c.minPrice != null && price < c.minPrice) problems.push(`price $${price} < floor $${c.minPrice} (parser/pricing drift?)`);
    if (c.maxPrice != null && price > c.maxPrice) problems.push(`price $${price} > ceiling $${c.maxPrice}`);
  }
  if ((c.trustedSource ?? true) && !REAL_SOURCES.includes(source)) {
    problems.push(`price from "${source}", not a real lookup`);
  }

  const detail = `${r.status} → ${m.name} #${m.number} | $${price ?? 'null'} (${source})`;
  return { status: problems.length ? 'FAIL' : 'PASS', label: c.label, detail, problems };
}

async function checkGraded(c: GradedCase, hasPcToken: boolean): Promise<Line> {
  if (c.sports && !hasPcToken) {
    return { status: 'SKIP', label: c.label, detail: 'sports — no PriceCharting token configured', problems: [] };
  }
  const problems: string[] = [];
  const j = await pricing.priceGraded(c.q);
  const slug = (j.sourceUrl || j.url || '').split('/').pop() || '-';
  const price = j.price ?? null;

  if (!slug.includes(c.slug)) problems.push(`slug "${slug}" missing "${c.slug}" (wrong product)`);
  if (price == null) problems.push('graded price null — parser may have broken');
  else {
    if (price <= 0) problems.push(`nonsense price ${price}`);
    if (c.minPrice != null && price < c.minPrice) problems.push(`price $${price} < floor $${c.minPrice} (parse drift?)`);
    if (c.maxPrice != null && price > c.maxPrice) problems.push(`price $${price} > ceiling $${c.maxPrice}`);
  }
  if (price != null && !j.gradeLabel) problems.push('price present but no gradeLabel');

  const detail = `$${price ?? 'null'} | ${j.gradeLabel ?? '-'} | ${slug}`;
  return { status: problems.length ? 'FAIL' : 'PASS', label: c.label, detail, problems };
}

(async () => {
  const hasPcToken = Boolean((process.env.PRICECHARTING_API_TOKEN ?? '').trim());

  // Upstreams reachable at all? (Replaces the old /api/config server ping.)
  const health = await pricing.healthcheck();
  const csvOk = health.find((h) => h.name === 'tcgcsv')?.ok;
  const searchOk = health.find((h) => h.name === 'tcglive search')?.ok;
  if (!csvOk && !searchOk) {
    console.error('Cannot reach tcgcsv OR TCGplayer search — upstreams are down, not the code.');
    for (const h of health) console.error(`  ${h.ok ? 'ok ' : 'DOWN'} ${h.name}: ${h.note}`);
    process.exit(2);
  }
  for (const h of health) console.log(`  ${h.ok ? 'ok  ' : 'DOWN'} ${h.name} (${h.ms} ms)`);
  console.log(`\nCanary against live upstreams  (sports ${hasPcToken ? 'enabled' : 'skipped — no PC token'})\n`);

  const lines: Line[] = [];
  for (const c of RAW) {
    lines.push(
      await checkRaw(c).catch((e) => ({ status: 'FAIL' as const, label: c.label, detail: `threw: ${e}`, problems: [String(e)] })),
    );
  }
  for (const c of GRADED) {
    lines.push(
      await checkGraded(c, hasPcToken).catch((e) => ({ status: 'FAIL' as const, label: c.label, detail: `threw: ${e}`, problems: [String(e)] })),
    );
  }

  for (const l of lines) {
    console.log(`${l.status.padEnd(4)} ${l.label}\n     ${l.detail}`);
    for (const p of l.problems) console.log(`       ✗ ${p}`);
  }

  const pass = lines.filter((l) => l.status === 'PASS').length;
  const fail = lines.filter((l) => l.status === 'FAIL').length;
  const skip = lines.filter((l) => l.status === 'SKIP').length;
  console.log(`\n=== canary: ${pass} pass / ${fail} FAIL / ${skip} skip of ${lines.length} ===`);
  // One machine-readable line for CI/log scraping.
  console.log(`CANARY_RESULT ${JSON.stringify({ pass, fail, skip })}`);
  process.exit(fail ? 1 : 0);
})();
