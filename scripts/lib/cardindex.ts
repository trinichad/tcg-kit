// Incremental card-index updater: the engine behind `npm run update-index`
// and the weekly GitHub Action (.github/workflows/update-index.yml).
//
// The shipped index (data/cardindex/<game>.{bin,json}) is the resume point,
// so a fresh clone or a CI runner only ever fingerprints what TCGplayer has
// added since the last update. Each run:
//
//   1. crawls the tcgcsv catalogue (groups = sets, products = cards),
//   2. skips sets whose publish date is still in the future — TCGplayer lists
//      them weeks early with "image coming soon" art that would poison the
//      fingerprint table; they're picked up automatically after release,
//   3. downloads and fingerprints only the products not yet indexed,
//   4. drops any cluster of differently-named products sharing IDENTICAL image
//      bytes (the placeholder image again, inside a released set),
//   5. rewrites the index only when something changed, and records the run in
//      data/cardindex/manifest.json so the app can show counts and what was
//      added.
//
// A set whose product list can't be fetched keeps its existing cards — a
// flaky request must never look like a hundred delisted cards.

import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import {
  CARD_H,
  CARD_W,
  HASH_BYTES,
  MANIFEST_FILE,
  hashCard,
  resizeRgba,
  type CardIndexManifest,
  type GameManifest,
  type GameRunSummary,
  type Rgba,
} from '../../src/recognize';
import { CATEGORY_ID, INDEX_GAMES, baseCardName, type IndexGame } from '../../src/catalog';
import { createLimiter, fetchRetry, sleep } from './net';

/** tcgcsv serves JSON to anything that identifies itself and 403s a browser
 *  User-Agent, so this is not decoration — it is the price of entry. */
export const UA = 'HoloTcgKit/0.1 (+https://holohuntingtcg.com)';
const BASE = 'https://tcgcsv.com/tcgplayer';

// Only single cards are fingerprinted, and the collector number is the test:
// sealed products never carry one. A name-based "sealed word" filter used to
// sit on top of it and only ever cost real cards — 771 One Piece "(Dash
// Pack)" parallels, Pokémon "Tool Box"/"Iron Bundle", Lorcana "Pack Leader"s,
// a promo renamed "(Gift Box Promo)" — measured across 38k numbered products
// in Sept 2026: not one true sealed product among the exclusions.

/** Identical image bytes behind this many differently-named products is
 * TCGplayer's placeholder art, not a coincidence. Real reprints of one card
 * (basic energies, tokens) share a NAME, so they pass. */
export const PLACEHOLDER_MIN = 8;

export interface IndexRow {
  productId: number;
  groupId: number;
  name: string;
  number: string;
  hash: string; // hex, HASH_BYTES bytes
}

export interface GroupInfo {
  groupId: number;
  name: string;
  publishedOn?: string;
  modifiedOn?: string;
}

interface Single {
  productId: number;
  groupId: number;
  name: string;
  number: string;
  imageUrl: string;
}

export interface GameRun {
  game: string;
  before: number;
  after: number;
  added: number;
  removed: number;
  /** Images that couldn't be fetched/decoded — retried on the next run. */
  failed: number;
  placeholders: number;
  /** Sets that contributed cards for the first time. */
  newSets: string[];
  /** Sets whose product list failed to load; their existing cards were kept. */
  failedGroups: string[];
  upcoming: { name: string; publishedOn: string }[];
  changed: boolean;
  /** Set when the whole game had to be skipped (set list unreachable). */
  skipped?: string;
  sets: number;
  builtAt: string;
  knownGroups: number[];
}

export interface UpdateOptions {
  outDir: string;
  cacheDir?: string;
  limit?: number;
  dryRun?: boolean;
  now?: Date;
  log?: (line: string) => void;
  groupConcurrency?: number;
  imageConcurrency?: number;
}

export interface Shipped {
  rows: Map<number, IndexRow>;
  groups: Record<string, string>;
  builtAt: string;
}

// ── tcgcsv ──────────────────────────────────────────────────────────────────

async function getJson<T>(url: string): Promise<T> {
  const r = await fetchRetry(url, { headers: { 'user-agent': UA, accept: 'application/json' } }, 3);
  if (!r.ok) throw new Error(`tcgcsv ${r.status} for ${url}`);
  return r.json() as Promise<T>;
}

export async function fetchGroups(categoryId: number): Promise<GroupInfo[]> {
  const body = await getJson<{ results?: GroupInfo[] }>(`${BASE}/${categoryId}/groups`);
  return (body.results ?? []).map((g) => ({
    groupId: g.groupId,
    name: g.name,
    publishedOn: g.publishedOn,
    modifiedOn: g.modifiedOn,
  }));
}

/** Every product TCGplayer lists in the set (`listed`) and the subset we
 * fingerprint (`singles`). Delisting is judged against `listed`: a card that
 * merely stops passing the singles filter (its number got dropped in a data
 * fix) is still on sale and must stay indexed. */
async function fetchProducts(categoryId: number, groupId: number): Promise<{ listed: number[]; singles: Single[] }> {
  const body = await getJson<{
    results?: { productId: number; name: string; imageUrl?: string; extendedData?: { name: string; value: string }[] }[];
  }>(`${BASE}/${categoryId}/${groupId}/products`);
  const listed: number[] = [];
  const singles: Single[] = [];
  for (const p of body.results ?? []) {
    listed.push(p.productId);
    const number = p.extendedData?.find((e) => e.name === 'Number')?.value;
    if (!number) continue;
    singles.push({
      productId: p.productId,
      groupId,
      name: p.name,
      number,
      imageUrl: p.imageUrl ?? `https://tcgplayer-cdn.tcgplayer.com/product/${p.productId}_200w.jpg`,
    });
  }
  return { listed, singles };
}

/** Released = publish date today or earlier (or unknown). */
export function isReleased(g: GroupInfo, today: string): boolean {
  const d = g.publishedOn?.slice(0, 10);
  return !d || d <= today;
}

// ── images ──────────────────────────────────────────────────────────────────

/**
 * Decode a JPEG and resize it to the canonical card rectangle.
 *
 * `resizeRgba` is the recognizer's own resampler (src/recognize/resize.ts), not
 * a copy — the index side and the query side MUST agree bit-for-bit, and the
 * only way to guarantee that is to run the same function. Never swap in
 * sharp/canvas here: their resampling differs between platforms and every
 * fingerprint in the index would shift.
 */
export function decodeToCard(bytes: Buffer): Rgba {
  const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
  if (!raw.width || !raw.height) throw new Error('empty image');
  return resizeRgba({ data: raw.data, width: raw.width, height: raw.height }, CARD_W, CARD_H);
}

// ── shipped index + manifest ────────────────────────────────────────────────

interface ShippedMeta {
  count: number;
  builtAt: string;
  groups: Record<string, string>;
  cards: [number, number, string, string][];
}

export function loadShipped(outDir: string, game: string): Shipped | null {
  const jsonPath = join(outDir, `${game}.json`);
  const binPath = join(outDir, `${game}.bin`);
  if (!existsSync(jsonPath) || !existsSync(binPath)) return null;
  const meta = JSON.parse(readFileSync(jsonPath, 'utf8')) as ShippedMeta;
  const bin = readFileSync(binPath);
  if (bin.length !== meta.count * HASH_BYTES || meta.cards.length !== meta.count) {
    throw new Error(`${game} index is corrupt: ${meta.count} cards, ${bin.length} bytes`);
  }
  const rows = new Map<number, IndexRow>();
  meta.cards.forEach(([productId, groupId, name, number], i) => {
    rows.set(productId, {
      productId,
      groupId,
      name,
      number,
      hash: bin.subarray(i * HASH_BYTES, (i + 1) * HASH_BYTES).toString('hex'),
    });
  });
  return { rows, groups: meta.groups, builtAt: meta.builtAt };
}

export function loadManifest(outDir: string): CardIndexManifest | null {
  const p = join(outDir, MANIFEST_FILE);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as CardIndexManifest;
  } catch {
    return null;
  }
}

function writeIndex(outDir: string, game: string, rows: IndexRow[], groupNames: Map<number, string>, builtAt: string) {
  const bin = Buffer.alloc(rows.length * HASH_BYTES);
  rows.forEach((r, i) => bin.write(r.hash, i * HASH_BYTES, 'hex'));
  const groups: Record<number, string> = {};
  for (const r of rows) if (!(r.groupId in groups)) groups[r.groupId] = groupNames.get(r.groupId) ?? '';
  const meta = {
    version: 1,
    game,
    categoryId: CATEGORY_ID[game as IndexGame],
    hashBytes: HASH_BYTES,
    cardW: CARD_W,
    cardH: CARD_H,
    count: rows.length,
    builtAt,
    groups,
    // Compact tuples rather than objects — roughly a third the bytes.
    cards: rows.map((r) => [r.productId, r.groupId, r.name, r.number]),
  };
  writeFileSync(join(outDir, `${game}.bin`), bin);
  writeFileSync(join(outDir, `${game}.json`), JSON.stringify(meta));
  return Object.keys(groups).length;
}

// ── the update ──────────────────────────────────────────────────────────────

export async function updateGame(game: string, opts: UpdateOptions): Promise<GameRun> {
  const categoryId = CATEGORY_ID[game as IndexGame];
  if (!categoryId) throw new Error(`unknown game "${game}" — expected one of ${INDEX_GAMES.join(', ')}`);
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const today = now.toISOString().slice(0, 10);
  mkdirSync(opts.outDir, { recursive: true });
  if (opts.cacheDir) mkdirSync(opts.cacheDir, { recursive: true });

  const shipped = loadShipped(opts.outDir, game);
  const before = shipped?.rows.size ?? 0;
  const prevManifest = loadManifest(opts.outDir)?.games[game];
  const prevKnown = new Set<number>(prevManifest?.knownGroups ?? Object.keys(shipped?.groups ?? {}).map(Number));
  const base: GameRun = {
    game,
    before,
    after: before,
    added: 0,
    removed: 0,
    failed: 0,
    placeholders: 0,
    newSets: [],
    failedGroups: [],
    upcoming: [],
    changed: false,
    sets: Object.keys(shipped?.groups ?? {}).length,
    builtAt: shipped?.builtAt ?? today,
    knownGroups: [...prevKnown].sort((a, b) => a - b),
  };

  // Everything fingerprinted before: the shipped index, plus whatever an
  // interrupted earlier run left in the cache.
  const done = new Map<number, IndexRow>(shipped?.rows ?? []);
  const cacheFile = opts.cacheDir ? join(opts.cacheDir, `index-${game}.jsonl`) : null;
  if (cacheFile && existsSync(cacheFile)) {
    for (const line of readFileSync(cacheFile, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as IndexRow;
        if (!done.has(row.productId)) done.set(row.productId, row);
      } catch {
        /* torn line from an interrupted run */
      }
    }
  }

  log(`${game}: fetching sets…`);
  let groups: GroupInfo[];
  try {
    groups = await fetchGroups(categoryId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log(`${game}: set list unreachable — skipped (${msg})`);
    return { ...base, skipped: msg };
  }
  const released = groups.filter((g) => isReleased(g, today));
  const upcoming = groups
    .filter((g) => !isReleased(g, today))
    .map((g) => ({ name: g.name, publishedOn: (g.publishedOn ?? '').slice(0, 10) }))
    .sort((a, b) => a.publishedOn.localeCompare(b.publishedOn));
  log(`${game}: ${groups.length} sets (${upcoming.length} not released yet)`);

  // Product lists for EVERY set, released or not: unreleased sets aren't
  // fingerprinted, but a card TCGplayer moved into one is still listed and
  // must not read as delisted.
  const catalog = new Map<number, Single>();
  const listedIds = new Set<number>();
  const fetchedOk = new Set<number>();
  const failedGroups: string[] = [];
  const releasedIds = new Set(released.map((g) => g.groupId));
  const groupLimit = createLimiter(opts.groupConcurrency ?? 6);
  let scanned = 0;
  await Promise.all(
    groups.map((g) =>
      groupLimit(async () => {
        try {
          const { listed, singles } = await fetchProducts(categoryId, g.groupId);
          for (const id of listed) listedIds.add(id);
          if (releasedIds.has(g.groupId)) for (const s of singles) catalog.set(s.productId, s);
          fetchedOk.add(g.groupId);
        } catch (err) {
          failedGroups.push(g.name);
          log(`  set ${g.groupId} (${g.name}) failed: ${(err as Error).message}`);
        }
        if (++scanned % 50 === 0) log(`  scanned ${scanned}/${groups.length} sets…`);
      }),
    ),
  );

  let target = [...catalog.values()].sort((a, b) => a.productId - b.productId);
  if (opts.limit) target = target.slice(0, opts.limit);
  const todo = target.filter((s) => !done.has(s.productId));
  log(`${game}: catalog ${catalog.size} singles, ${todo.length} not yet fingerprinted`);

  // Delisted: no longer listed ANYWHERE on TCGplayer, judged only when its own
  // set loaded (or no longer exists) — a failed request must never look like
  // a delisting. (Never computed for a --limit build, which truncates the
  // catalog.)
  const liveGroupIds = new Set(groups.map((g) => g.groupId));
  const removedRows = opts.limit
    ? []
    : [...(shipped?.rows.values() ?? [])].filter(
        (r) => !listedIds.has(r.productId) && (fetchedOk.has(r.groupId) || !liveGroupIds.has(r.groupId)),
      );

  // Fingerprint the new ones.
  const fresh: IndexRow[] = [];
  const clusters = new Map<string, { names: Set<string>; ids: number[] }>();
  let failed = 0;
  if (!opts.dryRun && todo.length) {
    const imageLimit = createLimiter(opts.imageConcurrency ?? 12);
    let ok = 0;
    let batch: string[] = [];
    const flush = () => {
      if (batch.length && cacheFile) appendFileSync(cacheFile, batch.join(''));
      batch = [];
    };
    await Promise.all(
      todo.map((s) =>
        imageLimit(async () => {
          try {
            const r = await fetchRetry(s.imageUrl, { headers: { 'user-agent': UA } }, 2);
            if (!r.ok) throw new Error(`http ${r.status}`);
            const buf = Buffer.from(await r.arrayBuffer());
            const row: IndexRow = {
              productId: s.productId,
              groupId: s.groupId,
              name: s.name,
              number: s.number,
              hash: Buffer.from(hashCard(decodeToCard(buf))).toString('hex'),
            };
            const sig = createHash('sha1').update(buf).digest('hex');
            const c = clusters.get(sig) ?? { names: new Set<string>(), ids: [] };
            c.names.add(baseCardName(s.name));
            c.ids.push(s.productId);
            clusters.set(sig, c);
            fresh.push(row);
            batch.push(JSON.stringify(row) + '\n');
            if (batch.length >= 200) flush();
            if (++ok % 500 === 0) {
              log(`  ${ok}/${todo.length} fingerprinted (${failed} failed)`);
              await sleep(50); // let the CDN breathe
            }
          } catch (err) {
            failed++;
            if (failed <= 10) log(`  ${s.productId} ${s.name}: ${(err as Error).message}`);
          }
        }),
      ),
    );
    flush();
  }

  const placeholderIds = new Set<number>();
  for (const c of clusters.values()) {
    if (c.ids.length >= PLACEHOLDER_MIN && c.names.size >= 2) for (const id of c.ids) placeholderIds.add(id);
  }
  if (placeholderIds.size && cacheFile && existsSync(cacheFile)) {
    // Never resume a placeholder from the cache — it must be re-fetched once
    // the real art exists.
    const kept = readFileSync(cacheFile, 'utf8')
      .split('\n')
      .filter((line) => {
        if (!line.trim()) return false;
        try {
          return !placeholderIds.has((JSON.parse(line) as IndexRow).productId);
        } catch {
          return false;
        }
      });
    writeFileSync(cacheFile, kept.length ? kept.join('\n') + '\n' : '');
  }

  // Assemble: kept shipped rows + fresh rows + cache-resumed rows, all
  // restricted to what the catalogue still lists.
  const removedIds = new Set(removedRows.map((r) => r.productId));
  const rowsMap = new Map<number, IndexRow>();
  for (const r of shipped?.rows.values() ?? []) if (!removedIds.has(r.productId)) rowsMap.set(r.productId, r);
  for (const r of fresh) if (!placeholderIds.has(r.productId) && catalog.has(r.productId)) rowsMap.set(r.productId, r);
  for (const s of target) {
    if (!rowsMap.has(s.productId) && done.has(s.productId) && !shipped?.rows.has(s.productId)) {
      rowsMap.set(s.productId, done.get(s.productId)!);
    }
  }
  const rows = [...rowsMap.values()].sort((a, b) => a.productId - b.productId);
  const added = rows.filter((r) => !shipped?.rows.has(r.productId)).length;
  const removed = removedRows.length;
  const changed = added > 0 || removed > 0;

  const groupNames = new Map(groups.map((g) => [g.groupId, g.name]));
  const newSetIds = new Set(rows.filter((r) => !shipped?.rows.has(r.productId) && !prevKnown.has(r.groupId)).map((r) => r.groupId));
  const newSets = [...newSetIds].map((id) => groupNames.get(id) ?? String(id)).sort();
  const knownGroups = [
    ...new Set([...[...prevKnown].filter((id) => liveGroupIds.has(id)), ...[...fetchedOk].filter((id) => releasedIds.has(id))]),
  ].sort((a, b) => a - b);

  let sets = base.sets;
  let builtAt = base.builtAt;
  if (changed && !opts.dryRun) {
    builtAt = today;
    sets = writeIndex(opts.outDir, game, rows, groupNames, builtAt);
    log(`${game}: wrote ${rows.length} cards (+${added} −${removed})`);
  } else {
    log(`${game}: ${changed ? 'dry run — ' : ''}${added ? `+${added} ` : ''}${removed ? `−${removed} ` : ''}${changed ? '' : 'no changes'}`);
  }

  return {
    ...base,
    after: rows.length,
    added,
    removed,
    failed,
    placeholders: placeholderIds.size,
    newSets,
    failedGroups: failedGroups.sort(),
    upcoming,
    changed,
    sets,
    builtAt,
    knownGroups,
  };
}

/** Rebuild the manifest from this run's results + whatever else is on disk.
 * A run that changed nothing leaves the file byte-for-byte alone — otherwise
 * every weekly no-op would commit a fresh timestamp and redeploy the app. */
export function updateManifest(outDir: string, runs: GameRun[], now: Date, dryRun = false): CardIndexManifest {
  const prev = loadManifest(outDir);
  const games: Record<string, GameManifest> = {};
  for (const game of INDEX_GAMES) {
    const run = runs.find((r) => r.game === game && !r.skipped);
    if (run) {
      games[game] = { count: run.after, sets: run.sets, builtAt: run.builtAt, knownGroups: run.knownGroups };
      continue;
    }
    if (prev?.games[game]) {
      games[game] = prev.games[game];
      continue;
    }
    const shipped = loadShipped(outDir, game);
    if (shipped) {
      const groups = Object.keys(shipped.groups).map(Number);
      games[game] = { count: shipped.rows.size, sets: groups.length, builtAt: shipped.builtAt, knownGroups: groups.sort((a, b) => a - b) };
    }
  }
  const byGame: Record<string, GameRunSummary> = {};
  for (const r of runs) {
    byGame[r.game] = {
      added: r.added,
      removed: r.removed,
      failed: r.failed,
      newSets: r.newSets,
      skipped: r.skipped,
    };
  }
  const sameGames = !!prev && JSON.stringify(prev.games) === JSON.stringify(games);
  if (prev && sameGames && !runs.some((r) => r.changed)) return prev;
  const manifest: CardIndexManifest = {
    version: 1,
    updatedAt: now.toISOString(),
    total: Object.values(games).reduce((n, g) => n + g.count, 0),
    games,
    lastRun: {
      at: now.toISOString(),
      added: runs.reduce((n, r) => n + r.added, 0),
      removed: runs.reduce((n, r) => n + r.removed, 0),
      failed: runs.reduce((n, r) => n + r.failed, 0),
      placeholders: runs.reduce((n, r) => n + r.placeholders, 0),
      upcoming: runs.flatMap((r) => r.upcoming.map((u) => ({ game: r.game, ...u }))).sort((a, b) => a.publishedOn.localeCompare(b.publishedOn)),
      byGame,
    },
  };
  if (!dryRun) writeFileSync(join(outDir, MANIFEST_FILE), JSON.stringify(manifest));
  return manifest;
}

// ── reporting ───────────────────────────────────────────────────────────────

const n = (v: number) => v.toLocaleString('en-US');
const signed = (v: number) => (v > 0 ? `+${n(v)}` : v < 0 ? `−${n(-v)}` : '0');
const fmtDay = (iso: string) => {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

/** One-line commit title, e.g. "Card index: +725 cards (pokemon +312, onepiece +140)". */
export function commitTitle(runs: GameRun[]): string {
  const added = runs.reduce((s, r) => s + r.added, 0);
  const removed = runs.reduce((s, r) => s + r.removed, 0);
  if (!added && !removed) return 'Card index: no new cards';
  const parts = runs
    .filter((r) => r.added || r.removed)
    .sort((a, b) => b.added - a.added)
    .map((r) => `${r.game} ${signed(r.added)}${r.removed ? `/−${r.removed}` : ''}`);
  return `Card index: ${signed(added)} cards${removed ? `, −${removed} delisted` : ''} (${parts.join(', ')})`;
}

/** Markdown report: the numbers a person wants after "fetch new cards". */
export function renderReport(runs: GameRun[], manifest: CardIndexManifest, now: Date): string {
  const lines: string[] = [];
  const added = runs.reduce((s, r) => s + r.added, 0);
  const removed = runs.reduce((s, r) => s + r.removed, 0);
  const before = runs.reduce((s, r) => s + r.before, 0);
  const after = runs.reduce((s, r) => s + r.after, 0);
  lines.push(`## Card index update — ${now.toISOString().slice(0, 10)}`);
  lines.push('');
  lines.push(
    added || removed
      ? `**${signed(added)} cards**${removed ? ` (${removed} delisted)` : ''} — index now holds **${n(manifest.total)}** cards across ${Object.keys(manifest.games).length} catalogues.`
      : `**No new cards.** Index holds **${n(manifest.total)}** cards across ${Object.keys(manifest.games).length} catalogues.`,
  );
  lines.push('');
  lines.push('| Catalogue | Before | After | Added | Removed | Failed | New sets |');
  lines.push('| --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const r of runs) {
    const note = r.skipped ? `_skipped: ${r.skipped}_` : r.newSets.join(', ');
    lines.push(`| ${r.game} | ${n(r.before)} | ${n(r.after)} | ${signed(r.added)} | ${r.removed ? n(r.removed) : '0'} | ${r.failed ? n(r.failed) : '0'} | ${note} |`);
  }
  if (runs.length > 1) {
    const failed = runs.reduce((s, r) => s + r.failed, 0);
    lines.push(`| **total** | **${n(before)}** | **${n(after)}** | **${signed(added)}** | **${removed}** | **${failed}** | |`);
  }
  const upcoming = runs.flatMap((r) => r.upcoming.map((u) => ({ game: r.game, ...u })));
  if (upcoming.length) {
    lines.push('');
    lines.push(
      `**Not released yet** (listed on TCGplayer; indexed automatically once out): ${upcoming
        .sort((a, b) => a.publishedOn.localeCompare(b.publishedOn))
        .map((u) => `${u.name} (${u.game}, ${fmtDay(u.publishedOn)})`)
        .join('; ')}`,
    );
  }
  const failedGroups = runs.flatMap((r) => r.failedGroups.map((g) => `${g} (${r.game})`));
  if (failedGroups.length) {
    lines.push('');
    lines.push(`**Sets that failed to load** (existing cards kept, retried next run): ${failedGroups.join('; ')}`);
  }
  const placeholders = runs.reduce((s, r) => s + r.placeholders, 0);
  const failed = runs.reduce((s, r) => s + r.failed, 0);
  if (placeholders || failed) {
    lines.push('');
    lines.push(
      `${failed ? `${n(failed)} card image${failed === 1 ? '' : 's'} could not be fetched` : ''}${failed && placeholders ? '; ' : ''}${placeholders ? `${n(placeholders)} placeholder image${placeholders === 1 ? '' : 's'} skipped` : ''} — retried on the next run.`,
    );
  }
  return lines.join('\n') + '\n';
}
