// Ship the fingerprint index into a consumer's public directory.
//
//   tsx scripts/copy-index.ts <destDir>
//   tsx scripts/copy-index.ts <destDir> --games pokemon,onepiece
//   tsx scripts/copy-index.ts ../my-app/public/cardindex --games pokemon --dry-run
//
// Copies each selected catalogue's <game>.json + <game>.bin verbatim, plus a
// manifest.json NARROWED to those catalogues. The narrowing matters: the
// scanner treats a catalogue it was asked for but could not load as a hard
// error (a partial load is how Japanese cards quietly get English prices), so
// a manifest advertising nine catalogues next to three files is a broken app,
// not a smaller one.
//
// Run it from a consumer's postinstall or build step — the files are data and
// change only when the weekly updater commits new cards.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_GAMES, manifestFor, type IndexGame } from '../src/catalog';
import { MANIFEST_FILE, type CardIndexManifest } from '../src/recognize';

const ROOT = join(import.meta.dirname, '..');
const SRC_DIR = process.env.CARDINDEX_DIR ?? join(ROOT, 'data', 'cardindex');

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

/** First bare argument, skipping flags and the value each valued flag takes. */
const VALUED_FLAGS = new Set(['--games']);
let destDir: string | undefined;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--')) {
    if (VALUED_FLAGS.has(a)) i++;
    continue;
  }
  destDir = a;
  break;
}
const dryRun = has('dry-run');

if (!destDir) {
  console.error('usage: tsx scripts/copy-index.ts <destDir> [--games pokemon,onepiece] [--dry-run]');
  console.error(`       catalogues: ${INDEX_GAMES.join(', ')}`);
  process.exit(1);
}

const gamesArg = flag('games', 'all') as string;
const games = (gamesArg === 'all' ? [...INDEX_GAMES] : gamesArg.split(',').map((g) => g.trim()).filter(Boolean)) as IndexGame[];
for (const g of games) {
  if (!(INDEX_GAMES as readonly string[]).includes(g)) {
    console.error(`unknown catalogue "${g}" — expected one of ${INDEX_GAMES.join(', ')} (or all)`);
    process.exit(1);
  }
}

const files = games.flatMap((g) => [`${g}.json`, `${g}.bin`]);
const missing = files.filter((f) => !existsSync(join(SRC_DIR, f)));
if (missing.length) {
  console.error(`${SRC_DIR} is missing ${missing.join(', ')} — run \`npm run build-index\` first`);
  process.exit(1);
}

const manifestPath = join(SRC_DIR, MANIFEST_FILE);
if (!existsSync(manifestPath)) {
  console.error(`${manifestPath} not found — the scanner needs it for cache-busting`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as CardIndexManifest;
const narrowed = manifestFor(manifest, games);

if (!dryRun) mkdirSync(destDir, { recursive: true });
let bytes = 0;
for (const f of files) {
  const from = join(SRC_DIR, f);
  bytes += statSync(from).size;
  if (!dryRun) copyFileSync(from, join(destDir, f));
}
const manifestJson = JSON.stringify(narrowed);
bytes += Buffer.byteLength(manifestJson);
if (!dryRun) writeFileSync(join(destDir, MANIFEST_FILE), manifestJson);

const mb = (bytes / 1e6).toFixed(1);
console.log(
  `${dryRun ? 'would copy' : 'copied'} ${files.length + 1} files (${mb} MB, ${narrowed.total.toLocaleString('en-US')} cards) → ${destDir}`,
);
for (const g of games) {
  const m = narrowed.games[g];
  console.log(`  ${g.padEnd(18)} ${m ? `${m.count.toLocaleString('en-US')} cards, ${m.sets} sets, built ${m.builtAt}` : 'not in manifest'}`);
}
