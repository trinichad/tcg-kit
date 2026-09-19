// Card-index updater regression check. tcgcsv and the TCGplayer image CDN are
// stubbed (globalThis.fetch is replaced), so this pins the update logic itself
// — offline, in about a second, against a synthetic catalogue it drives
// through every failure mode the real one has ever produced:
//
//   - a fresh build indexes only released sets' singles (sealed skipped),
//   - re-running with nothing new rewrites nothing,
//   - new cards and new sets are added and reported, delisted cards removed,
//   - a set whose product list fails keeps its existing cards,
//   - unreleased sets are skipped (reported as upcoming), placeholder art is
//     skipped, missing images are retried next run,
//   - the fingerprint written is bit-identical to the hashing pipeline,
//   - manifest / report / commit title carry the right numbers.
//
//   npx tsx scripts/index-check.ts        (or: npm run index-check)

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { HASH_BYTES, hashCard, indexUrl, indexVersion, type CardIndexManifest } from '../src/recognize';
import {
  commitTitle,
  decodeToCard,
  loadManifest,
  renderReport,
  updateGame,
  updateManifest,
  type GroupInfo,
  type GameRun,
} from './lib/cardindex';

// Not a vitest file on purpose: it replaces `globalThis.fetch` for the whole
// process, which would leak into any test sharing that worker.

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) {
    passed++;
    console.log(`PASS ${label}`);
  } else {
    failed++;
    console.log(`FAIL ${label}\n     got: ${JSON.stringify(detail)}`);
  }
}

// ── synthetic world ─────────────────────────────────────────────────────────

const CAT = 71; // lorcana
const NOW = new Date('2026-09-07T12:00:00Z');
const ROOT = join(import.meta.dirname, '..', '.tmp', 'index-test');
const OUT = join(ROOT, 'out');
const CACHE = join(ROOT, 'cache');

interface Product {
  productId: number;
  name: string;
  extendedData?: { name: string; value: string }[];
}
const world = {
  groups: [] as GroupInfo[],
  products: new Map<number, Product[]>(),
  failGroups: new Set<number>(),
  groupsFail: false,
  missingImages: new Set<number>(),
  placeholderIds: new Set<number>(),
  /** Products that share one (legitimate) image, keyed to a seed — basic energy reprints. */
  sharedImage: new Map<number, number>(),
  imageFetches: new Map<number, number>(),
};
const single = (productId: number, name: string, number: string): Product => ({
  productId,
  name,
  extendedData: [{ name: 'Number', value: number }],
});

/** A deterministic, visually distinct 200x280 card per product id. */
const imageCache = new Map<number, Buffer>();
function imageFor(id: number): Buffer {
  const cached = imageCache.get(id);
  if (cached) return cached;
  const w = 200;
  const h = 280;
  const data = new Uint8Array(w * h * 4);
  const seed = (id * 2654435761) >>> 0;
  const bg = [seed & 255, (seed >> 8) & 255, (seed >> 16) & 255];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const inArt = y > 40 && y < 160 && x > 20 && x < 180;
      const stripe = ((x >> 4) + (y >> 4) + (seed >> 24)) % 3 === 0;
      data[p] = inArt ? (stripe ? 255 - bg[0] : bg[1]) : bg[0];
      data[p + 1] = inArt ? (stripe ? bg[2] : 255 - bg[1]) : bg[1];
      data[p + 2] = inArt ? (stripe ? bg[0] : bg[2]) : bg[2];
      data[p + 3] = 255;
    }
  }
  const buf = Buffer.from(jpeg.encode({ data, width: w, height: h }, 85).data);
  imageCache.set(id, buf);
  return buf;
}
const PLACEHOLDER = imageFor(-1); // one fixed image for every placeholder product

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  let m: RegExpMatchArray | null;
  if (url.endsWith(`/tcgplayer/${CAT}/groups`)) {
    return world.groupsFail ? new Response('boom', { status: 500 }) : json({ results: world.groups });
  }
  if ((m = url.match(new RegExp(`/tcgplayer/${CAT}/(\\d+)/products$`)))) {
    const gid = Number(m[1]);
    if (world.failGroups.has(gid)) return new Response('boom', { status: 500 });
    return json({ results: world.products.get(gid) ?? [] });
  }
  if ((m = url.match(/\/product\/(\d+)_200w\.jpg$/))) {
    const id = Number(m[1]);
    world.imageFetches.set(id, (world.imageFetches.get(id) ?? 0) + 1);
    if (world.missingImages.has(id)) return new Response('nope', { status: 404 });
    const bytes = world.placeholderIds.has(id) ? PLACEHOLDER : imageFor(world.sharedImage.get(id) ?? id);
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'image/jpeg' } });
  }
  throw new Error(`unexpected fetch ${url}`);
}) as typeof fetch;

const run = (now = NOW, extra: Partial<Parameters<typeof updateGame>[1]> = {}) =>
  updateGame('lorcana', { outDir: OUT, cacheDir: CACHE, now, imageConcurrency: 4, ...extra });
const shippedCount = () => (JSON.parse(readFileSync(join(OUT, 'lorcana.json'), 'utf8')) as { count: number }).count;
const shippedIds = () => (JSON.parse(readFileSync(join(OUT, 'lorcana.json'), 'utf8')) as { cards: [number][] }).cards.map((c) => c[0]);

async function main() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  // ── 1. fresh build ──
  const G1 = 22937;
  const G2 = 30001;
  const G3 = 23234;
  world.groups = [
    { groupId: G1, name: 'The First Chapter', publishedOn: '2023-08-18T00:00:00' },
    { groupId: G2, name: 'Hyperia City', publishedOn: '2026-10-16T00:00:00' },
    { groupId: G3, name: 'Disney Lorcana Promo Cards' },
  ];
  world.products.set(G1, [single(101, 'Elsa - Snow Queen', '4/204'), single(102, 'Mickey Mouse - Brave Little Tailor', '115/204'), single(103, 'Stitch - Rock Star', '125/204'), { productId: 104, name: 'The First Chapter Booster Box' }]);
  world.products.set(G2, [single(201, 'Future Card', '1/204'), single(202, 'Future Card 2', '2/204')]);
  world.products.set(G3, [single(301, 'Elsa - Spirit of Winter', '1/P1')]);

  let r = await run();
  check('fresh build indexes released singles only (3 + 1 promo; booster box and unreleased set skipped)', r.before === 0 && r.after === 4 && r.added === 4 && r.changed, r);
  check('new sets reported', JSON.stringify(r.newSets) === JSON.stringify(['Disney Lorcana Promo Cards', 'The First Chapter']), r.newSets);
  check('unreleased set listed as upcoming, not indexed', r.upcoming.length === 1 && r.upcoming[0].name === 'Hyperia City' && r.upcoming[0].publishedOn === '2026-10-16', r.upcoming);
  check('known groups = crawled released sets', JSON.stringify(r.knownGroups) === JSON.stringify([G1, G3]), r.knownGroups);
  check('bin is 29 bytes per card, rows sorted by productId', statSync(join(OUT, 'lorcana.bin')).size === 4 * HASH_BYTES && JSON.stringify(shippedIds()) === JSON.stringify([101, 102, 103, 301]), shippedIds());
  const bin = readFileSync(join(OUT, 'lorcana.bin'));
  const direct = Buffer.from(hashCard(decodeToCard(imageFor(102)))).toString('hex');
  check('stored fingerprint is bit-identical to hashCard(decodeToCard(image))', bin.subarray(HASH_BYTES, 2 * HASH_BYTES).toString('hex') === direct);
  let manifest = updateManifest(OUT, [r], NOW);
  check('manifest: total, per-game count/sets/builtAt, lastRun.added', manifest.total === 4 && manifest.games.lorcana.count === 4 && manifest.games.lorcana.sets === 2 && manifest.games.lorcana.builtAt === '2026-09-07' && manifest.lastRun?.added === 4, manifest);
  check('manifest written to disk', existsSync(join(OUT, 'manifest.json')) && loadManifest(OUT)?.total === 4);

  // ── 2. nothing new ──
  const before2 = readFileSync(join(OUT, 'lorcana.json'), 'utf8');
  const fetchesBefore = [...world.imageFetches.values()].reduce((a, b) => a + b, 0);
  r = await run(new Date('2026-09-08T12:00:00Z'));
  check('re-run with nothing new: +0 −0, unchanged, no image fetched', !r.changed && r.added === 0 && r.removed === 0 && [...world.imageFetches.values()].reduce((a, b) => a + b, 0) === fetchesBefore, r);
  check('…index file untouched (builtAt stays)', readFileSync(join(OUT, 'lorcana.json'), 'utf8') === before2 && r.builtAt === '2026-09-07');
  const manifestBefore2 = readFileSync(join(OUT, 'manifest.json'), 'utf8');
  updateManifest(OUT, [r], new Date('2026-09-08T12:00:00Z'));
  check('…and the manifest is byte-identical too (no no-op commit/redeploy)', readFileSync(join(OUT, 'manifest.json'), 'utf8') === manifestBefore2);
  check('commit title for a no-op run', commitTitle([r]) === 'Card index: no new cards', commitTitle([r]));

  // ── 3. new card in a known set + a brand-new released set ──
  const G4 = 30002;
  world.products.get(G1)!.push(single(105, 'Maui - Demigod', '184/204'));
  world.groups.push({ groupId: G4, name: 'Rise of the Floodborn', publishedOn: '2026-09-01T00:00:00' });
  world.products.set(G4, [single(401, 'Belle - Hidden Archer', '4/204'), single(402, 'Beast - Forbidding Recluse', '5/204')]);
  r = await run(new Date('2026-09-08T12:00:00Z'));
  check('adds the new card and the new set (3 cards)', r.added === 3 && r.after === 7 && r.changed && r.builtAt === '2026-09-08', r);
  check('only the brand-new set is a "new set" (the known set with one more card is not)', JSON.stringify(r.newSets) === JSON.stringify(['Rise of the Floodborn']), r.newSets);
  check('commit title names the catalogue and count', commitTitle([r]) === 'Card index: +3 cards (lorcana +3)', commitTitle([r]));

  // ── 4. delisted card vs a set that failed to load ──
  world.products.set(G1, world.products.get(G1)!.filter((p) => p.productId !== 101));
  world.products.set(G3, []); // promo delisted on TCGplayer…
  world.failGroups.add(G3); // …but its product list can't be fetched this run
  r = await run(new Date('2026-09-09T12:00:00Z'));
  check('delisted card removed from a set that loaded', r.removed === 1 && !shippedIds().includes(101), r);
  check('card in a set that FAILED to load is kept (not counted as removed)', shippedIds().includes(301) && r.failedGroups.length === 1 && r.failedGroups[0] === 'Disney Lorcana Promo Cards', r);
  check('failed set stays known', r.knownGroups.includes(G3), r.knownGroups);
  world.failGroups.clear();
  r = await run(new Date('2026-09-10T12:00:00Z'));
  check('once the set loads again, its delisted card is removed', r.removed === 1 && !shippedIds().includes(301) && shippedCount() === 5, r);

  // ── 4b. still listed, just not a "single" any more / moved to an unreleased set ──
  const mickey = world.products.get(G1)!.find((p) => p.productId === 102)!;
  mickey.name = 'Mickey Mouse - Brave Little Tailor (Gift Box Promo)';
  mickey.extendedData = []; // number dropped in a TCGplayer data fix — still listed
  world.products.get(G1)!.splice(world.products.get(G1)!.findIndex((p) => p.productId === 103), 1);
  world.products.get(G2)!.push(single(103, 'Stitch - Rock Star', '125/204')); // moved into the unreleased set
  r = await run(new Date('2026-09-10T13:00:00Z'));
  check('a listed card that no longer passes the singles filter is kept (not "delisted")', r.removed === 0 && shippedIds().includes(102), r);
  check('a card moved into an unreleased set is still listed → kept, not fingerprinted again', shippedIds().includes(103) && r.added === 0, r);
  mickey.extendedData = [{ name: 'Number', value: '115/204' }];
  world.products.get(G2)!.pop();
  world.products.get(G1)!.push(single(103, 'Stitch - Rock Star', '125/204'));
  const sealedLike = single(106, 'Card Soldiers - Full Deck', '105/204');
  world.products.get(G1)!.push(sealedLike);
  r = await run(new Date('2026-09-10T14:00:00Z'));
  check('a numbered card with a sealed-sounding name ("Full Deck") IS indexed', r.added === 1 && shippedIds().includes(106), r);

  // ── 5. placeholder art vs legitimate identical reprints ──
  const G5 = 30003;
  const G6 = 30004;
  world.groups.push({ groupId: G5, name: 'Placeholder Set', publishedOn: '2026-09-05T00:00:00' });
  world.groups.push({ groupId: G6, name: 'Energy Reprints', publishedOn: '2026-09-05T00:00:00' });
  world.products.set(G5, Array.from({ length: 9 }, (_, i) => single(500 + i, `Different Card ${i}`, `${i}/204`)));
  world.products.set(G6, Array.from({ length: 9 }, (_, i) => single(600 + i, `Fire Energy (#${i})`, `${i}/204`)));
  for (let i = 0; i < 9; i++) {
    world.placeholderIds.add(500 + i);
    world.sharedImage.set(600 + i, -2); // one real image shared by same-name reprints → legit
  }
  r = await run(new Date('2026-09-11T12:00:00Z'));
  check('9 differently-named products sharing one image = placeholders, skipped', r.placeholders === 9 && !shippedIds().includes(500), r);
  check('9 same-name reprints sharing one image are indexed (basic energy case)', r.added === 9 && shippedIds().includes(608), r);
  check('placeholder set is NOT reported as a new set (nothing indexed from it)', !r.newSets.includes('Placeholder Set') && r.newSets.includes('Energy Reprints'), r.newSets);
  const cacheLines = readFileSync(join(CACHE, 'index-lorcana.jsonl'), 'utf8').split('\n').filter(Boolean);
  check('placeholders purged from the resume cache (so real art gets fetched later)', !cacheLines.some((l) => /"productId":50\d,/.test(l)), cacheLines.length);
  for (let i = 0; i < 9; i++) world.placeholderIds.delete(500 + i);
  r = await run(new Date('2026-09-12T12:00:00Z'));
  check('once real art exists, the former placeholders are fetched and indexed', r.added === 9 && r.placeholders === 0 && shippedIds().includes(500) && r.newSets.includes('Placeholder Set'), r);

  // ── 6. missing image: retried next run ──
  world.products.get(G1)!.push(single(900, 'Ariel - On Human Legs', '1/204'));
  world.missingImages.add(900);
  r = await run(new Date('2026-09-13T12:00:00Z'));
  check('unfetchable image: counted as failed, not indexed, index otherwise untouched', r.failed === 1 && r.added === 0 && !r.changed, r);
  world.missingImages.delete(900);
  r = await run(new Date('2026-09-14T12:00:00Z'));
  check('…and picked up on the next run', r.added === 1 && shippedIds().includes(900), r);

  // ── 7. dry run ──
  world.products.get(G1)!.push(single(901, 'Ursula - Power Hungry', '2/204'));
  const countBefore = shippedCount();
  const fetchesBefore7 = [...world.imageFetches.values()].reduce((a, b) => a + b, 0);
  r = await run(new Date('2026-09-15T12:00:00Z'), { dryRun: true });
  check('dry run reports what WOULD be added but downloads and writes nothing', r.added === 0 && !r.changed && shippedCount() === countBefore && [...world.imageFetches.values()].reduce((a, b) => a + b, 0) === fetchesBefore7, r);
  const manifestBefore = readFileSync(join(OUT, 'manifest.json'), 'utf8');
  updateManifest(OUT, [r], new Date('2026-09-15T12:00:00Z'), true);
  check('dry run leaves the manifest untouched', readFileSync(join(OUT, 'manifest.json'), 'utf8') === manifestBefore);

  // ── 8. resume from the cache without refetching ──
  const cachedRow = { productId: 901, groupId: G1, name: 'Ursula - Power Hungry', number: '2/204', hash: 'ab'.repeat(HASH_BYTES) };
  writeFileSync(join(CACHE, 'index-lorcana.jsonl'), readFileSync(join(CACHE, 'index-lorcana.jsonl'), 'utf8') + JSON.stringify(cachedRow) + '\n');
  r = await run(new Date('2026-09-16T12:00:00Z'));
  check('a row an interrupted run left in the cache is used without re-downloading', r.added === 1 && (world.imageFetches.get(901) ?? 0) === 0 && shippedIds().includes(901), r);

  // ── 9. set list unreachable → whole catalogue skipped, nothing lost ──
  world.groupsFail = true;
  const prevManifest = loadManifest(OUT)!;
  r = await run(new Date('2026-09-17T12:00:00Z'));
  check('tcgcsv down: game skipped with reason, counts unchanged', !!r.skipped && r.after === r.before && !r.changed, r);
  const manifestBefore9 = readFileSync(join(OUT, 'manifest.json'), 'utf8');
  manifest = updateManifest(OUT, [r], new Date('2026-09-17T12:00:00Z'));
  check('a fully skipped run keeps the previous manifest, untouched on disk', manifest.games.lorcana.count === prevManifest.games.lorcana.count && readFileSync(join(OUT, 'manifest.json'), 'utf8') === manifestBefore9, manifest.games.lorcana);
  world.groupsFail = false;

  // ── 10. report + helpers ──
  const runs: GameRun[] = [
    { ...r, skipped: undefined, before: 100, after: 112, added: 12, removed: 0, failed: 1, placeholders: 0, newSets: ['Hyperia City'], failedGroups: [], upcoming: [{ name: 'Later Set', publishedOn: '2026-12-01' }], changed: true },
  ];
  const report = renderReport(runs, manifest, NOW);
  check('report table row carries the numbers', /\| lorcana \| 100 \| 112 \| \+12 \| 0 \| 1 \| Hyperia City \|/.test(report), report);
  check('report lists upcoming sets with dates', /Not released yet.*Later Set \(lorcana, Dec 1\)/.test(report), report);
  check('report mentions failed images', /1 card image could not be fetched/.test(report), report);
  const m: CardIndexManifest = { version: 1, updatedAt: 'x', total: 1, games: { pokemon: { count: 27084, sets: 213, builtAt: '2026-09-07', knownGroups: [] } }, lastRun: null };
  check('indexVersion changes with count/date; url carries it', indexVersion(m, 'pokemon') === '2026-09-07-27084' && indexUrl('pokemon', 'bin', indexVersion(m, 'pokemon')) === '/cardindex/pokemon.bin?v=2026-09-07-27084' && indexUrl('magic', 'json', '') === '/cardindex/magic.json');

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
