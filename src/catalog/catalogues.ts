// Which fingerprint catalogues the scanner ships, and how they relate.
//
// Single source of truth for the scan worker AND the accuracy harnesses
// (scan-accuracy, lang-check, synth-check) — if these tables drift apart, the
// harnesses measure a scanner that doesn't ship.

/** Index files under public/cardindex/, in load order. */
export const INDEX_GAMES = [
  'pokemon',
  'pokemon-japan',
  'onepiece',
  'dragonball', // Dragon Ball Super CCG (2017+, Masters era)
  'dragonball-fusion', // Fusion World (current)
  'dragonball-z', // Panini DBZ TCG (2014–17)
  'magic',
  'yugioh',
  'lorcana',
] as const;

export type IndexGame = (typeof INDEX_GAMES)[number];

/** tcgcsv category id per catalogue — what the index builder crawls and what
 * the scan worker's `preferCategory` refers to. Single source of truth. */
export const CATEGORY_ID: Record<IndexGame, number> = {
  pokemon: 3,
  'pokemon-japan': 85,
  onepiece: 68,
  dragonball: 27,
  'dragonball-fusion': 80,
  'dragonball-z': 23,
  magic: 1,
  yugioh: 2,
  lorcana: 71,
};

/** TCGplayer category id → market language. Steers graded lookups and lets
 *  the UI say which market a price came from. */
export const LANGUAGE: Record<number, string> = {
  3: 'English',
  85: 'Japanese',
  68: 'English',
  27: 'English',
  80: 'English',
  23: 'English',
  1: 'English',
  2: 'English',
  71: 'English',
};

/**
 * Catalogues that print the SAME artwork in different languages. The language
 * prior only ever needs to arbitrate within a family — a Pokémon frame never
 * near-ties a One Piece or Dragon Ball card (disjoint art), so unrelated games
 * carry no penalty and scanning them needs no settings change. The three
 * Dragon Ball games are separate eras with separate layouts, so each is its
 * own family too.
 */
export const FAMILY: Record<number, string> = {
  3: 'pokemon',
  85: 'pokemon',
  68: 'onepiece',
  27: 'dragonball',
  80: 'dragonball-fusion',
  23: 'dragonball-z',
  1: 'magic',
  2: 'yugioh',
  71: 'lorcana',
};

/**
 * Distance added to a preferred catalogue's other-language twin, in per-frame
 * Hamming units (the full scale is 292).
 *
 * Holding both Pokémon catalogues fixed Japanese cards being priced as English
 * ones, but created the mirror problem: English cards started matching their
 * Japanese twin, which dropped English accuracy from 96.7% to 85%. Seven of
 * the nine misses were the same card in the other market — the prints share
 * artwork, so on a degraded camera frame the two are nearly indistinguishable.
 *
 * This is a prior, not a filter. It settles near-ties toward the market the
 * user actually collects in, while a genuinely Japanese card — which matches
 * its own reference image far more closely than the English one — still wins
 * comfortably.
 */
export const OFF_LANGUAGE_PENALTY = 8;

/** The prior a given row carries when the user prefers `preferCategory`. */
export function languagePrior(categoryId: number, preferCategory: number): number {
  return categoryId !== preferCategory && FAMILY[categoryId] === FAMILY[preferCategory]
    ? OFF_LANGUAGE_PENALTY
    : 0;
}

/**
 * Which index files the scanner loads for a given "Card game" setting.
 *
 * 'auto' scans everything at once. A specific game loads only its own
 * catalogues — structurally impossible to mis-identify across games, and a
 * smaller index means fewer near-neighbours and faster frames. Games with no
 * fingerprint catalogue (sports, other) return [] — the scanner runs AI-only
 * and skips the pointless fingerprint wait.
 */
export function gamesForHint(hint: string): readonly string[] {
  switch (hint) {
    case 'auto':
      return INDEX_GAMES;
    case 'pokemon':
      return ['pokemon', 'pokemon-japan'];
    case 'dragonball':
      return ['dragonball', 'dragonball-fusion', 'dragonball-z'];
    case 'onepiece':
    case 'magic':
    case 'yugioh':
    case 'lorcana':
      return [hint];
    default:
      return [];
  }
}

/**
 * A card's name with TCGplayer's variant decorations stripped: parentheticals,
 * bracket tags, and trailing " - …" segments — "Spandam (Online Regional 2023)
 * [Winner]" → "spandam". Identical-artwork reprints (event stamps, promo
 * re-releases, WC decks) differ ONLY in these decorations, and they may sit in
 * the same set or different ones, so this — not exact-name-plus-different-set —
 * is the test for "same card, different product".
 */
export function baseCardName(name: string): string {
  const base = name
    .replace(/\s*[([].*?[)\]]\s*/g, ' ')
    .replace(/\s+-\s+.*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return base || name.trim().toLowerCase();
}

/** The decoration `baseCardName` strips — what actually distinguishes twin
 *  products, for picker labels. Empty when the name carries none. */
export function variantSuffix(name: string): string {
  const m = name.match(/[([]|\s+-\s+/);
  return m ? name.slice(m.index!).trim() : '';
}
