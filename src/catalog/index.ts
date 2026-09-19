// @holo/tcg-kit/catalog — the maps that say what a catalogue IS.
//
// Pure data and pure functions. No node builtins, no dependencies, no I/O —
// safe to import from a browser bundle, a Web Worker, a Node script or an edge
// function. The recognizer, the index updater and the pricing side all read
// these same tables, so "which games ship", "which tcgcsv category", "which
// market language" can never drift between them.

// ── which catalogues exist, and how they relate ────────────────────────────
export {
  INDEX_GAMES,
  CATEGORY_ID,
  LANGUAGE,
  FAMILY,
  OFF_LANGUAGE_PENALTY,
  languagePrior,
  gamesForHint,
  baseCardName,
  variantSuffix,
  type IndexGame,
} from './catalogues';

import { INDEX_GAMES, type IndexGame } from './catalogues';
import { MANIFEST_FILE, type CardIndexManifest } from '../recognize/cardindex';
import { ONEPIECE_PRINTINGS } from './printings/onepiece';
import { POKEMON_PRINTINGS } from './printings/pokemon';

// ── per-game printing vocabularies ─────────────────────────────────────────
// Namespaced rather than flattened: both modules export `resolvePrinting`, and
// merging them would silently pick one.
export * as pokemonPrintings from './printings/pokemon';
export * as onepiecePrintings from './printings/onepiece';

/**
 * Which games the pricing side is actually wired for.
 *
 * `enabled: false` means the printing vocabulary has been recorded from a real
 * tcgcsv sample but the rules that pick between printings have not been
 * written and measured — so pricing must refuse rather than guess. Recognition
 * is unaffected: every catalogue in `INDEX_GAMES` is fingerprinted and
 * scannable regardless of what is listed here.
 */
export const GAMES = {
  pokemon: { enabled: true, categoryId: 3, printings: POKEMON_PRINTINGS },
  onepiece: { enabled: false, categoryId: 68, printings: ONEPIECE_PRINTINGS },
} as const satisfies Record<string, { enabled: boolean; categoryId: number; printings: readonly string[] }>;

export type PricedGame = keyof typeof GAMES;

// ── shipping the index ─────────────────────────────────────────────────────

/**
 * Every file a consumer must copy out of `data/cardindex/` to run the scanner,
 * in load order: the manifest, then each catalogue's metadata + fingerprints.
 *
 * `scripts/copy-index.ts` does the copying; this is the list it works from, and
 * the answer to "what do I put in my public/ directory?".
 */
export const INDEX_FILES: readonly string[] = [
  MANIFEST_FILE,
  ...INDEX_GAMES.flatMap((g) => [`${g}.json`, `${g}.bin`]),
];

/** The files for a subset of catalogues — what `--games pokemon,onepiece` copies. */
export function indexFilesFor(games: readonly IndexGame[]): string[] {
  return [MANIFEST_FILE, ...games.flatMap((g) => [`${g}.json`, `${g}.bin`])];
}

/**
 * A manifest narrowed to the catalogues actually being shipped.
 *
 * Copying three of nine catalogues but the whole manifest leaves the scanner
 * asking for six files that aren't there — and a partial load is a hard error,
 * by design, because the alternative is quietly pricing Japanese cards in the
 * English market. Totals are recomputed so the count shown to a user matches
 * what was shipped.
 */
export function manifestFor(
  manifest: CardIndexManifest,
  games: readonly IndexGame[],
): CardIndexManifest {
  const keep = new Set<string>(games);
  const filtered: CardIndexManifest['games'] = {};
  for (const [game, entry] of Object.entries(manifest.games)) {
    if (keep.has(game)) filtered[game] = entry;
  }
  const lastRun = manifest.lastRun
    ? {
        ...manifest.lastRun,
        upcoming: manifest.lastRun.upcoming.filter((u) => keep.has(u.game)),
        byGame: Object.fromEntries(
          Object.entries(manifest.lastRun.byGame).filter(([g]) => keep.has(g)),
        ),
      }
    : null;
  return {
    ...manifest,
    total: Object.values(filtered).reduce((n, g) => n + g.count, 0),
    games: filtered,
    lastRun,
  };
}
