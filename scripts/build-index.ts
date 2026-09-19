// Build or update the offline card-fingerprint index the scanner matches
// against (data/cardindex/). Incremental: resumes from the shipped index and
// only fingerprints what TCGplayer added since.
//
//   npm run update-index                       # every catalogue, only what's new
//   npm run build-index -- --game magic        # one catalogue
//   npm run build-index -- --game pokemon --limit 2000
//   npm run update-index -- --dry-run          # crawl + report, download nothing
//   npm run update-index -- --report-dir .tmp/index-report   # report.md + title.txt for CI
//
// Output: data/cardindex/<game>.bin (29-byte fingerprints, row i <-> cards[i]),
// <game>.json ({ groups, cards: [productId, groupId, name, number] }) and
// manifest.json (counts, dates, what the last run added). The engine lives in
// scripts/lib/cardindex.ts; this file is the command line.
//
// The index is DATA, not build output: it is committed, and consumers copy it
// into their own public directory with scripts/copy-index.ts. `npm run build`
// (tsup) never touches it.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { INDEX_GAMES } from '../src/catalog';
import { commitTitle, renderReport, updateGame, updateManifest, type GameRun } from './lib/cardindex';

const ROOT = join(import.meta.dirname, '..');
const OUT_DIR = process.env.CARDINDEX_DIR ?? join(ROOT, 'data', 'cardindex');
const CACHE_DIR = process.env.CARDINDEX_CACHE_DIR ?? join(ROOT, '.cache');

const args = process.argv.slice(2);
const flag = (name: string, fallback?: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] ?? '') : fallback;
};
const has = (name: string) => args.includes(`--${name}`);

const gameArg = flag('game', 'all') as string;
const games = gameArg === 'all' ? [...INDEX_GAMES] : gameArg.split(',');
const limit = Number(flag('limit', '0')) || 0;
const dryRun = has('dry-run');
const reportDir = flag('report-dir');

for (const g of games) {
  if (!(INDEX_GAMES as readonly string[]).includes(g)) {
    console.error(`unknown game "${g}" — expected one of ${INDEX_GAMES.join(', ')} (or all)`);
    process.exit(1);
  }
}

async function main() {
  const now = new Date();
  const runs: GameRun[] = [];
  for (const game of games) {
    runs.push(await updateGame(game, { outDir: OUT_DIR, cacheDir: CACHE_DIR, limit, dryRun, now, log: console.log }));
  }
  const manifest = updateManifest(OUT_DIR, runs, now, dryRun);
  const report = renderReport(runs, manifest, now);
  console.log('\n' + report);
  if (reportDir) {
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'report.md'), report);
    writeFileSync(join(reportDir, 'title.txt'), commitTitle(runs) + '\n');
  }
  if (runs.every((r) => r.skipped)) {
    console.error('every catalogue was skipped — is tcgcsv.com reachable?');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
