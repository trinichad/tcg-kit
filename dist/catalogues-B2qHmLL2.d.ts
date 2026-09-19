/** Index files under public/cardindex/, in load order. */
declare const INDEX_GAMES: readonly ["pokemon", "pokemon-japan", "onepiece", "dragonball", "dragonball-fusion", "dragonball-z", "magic", "yugioh", "lorcana"];
type IndexGame = (typeof INDEX_GAMES)[number];
/** tcgcsv category id per catalogue — what the index builder crawls and what
 * the scan worker's `preferCategory` refers to. Single source of truth. */
declare const CATEGORY_ID: Record<IndexGame, number>;
/** TCGplayer category id → market language. Steers graded lookups and lets
 *  the UI say which market a price came from. */
declare const LANGUAGE: Record<number, string>;
/**
 * Catalogues that print the SAME artwork in different languages. The language
 * prior only ever needs to arbitrate within a family — a Pokémon frame never
 * near-ties a One Piece or Dragon Ball card (disjoint art), so unrelated games
 * carry no penalty and scanning them needs no settings change. The three
 * Dragon Ball games are separate eras with separate layouts, so each is its
 * own family too.
 */
declare const FAMILY: Record<number, string>;
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
declare const OFF_LANGUAGE_PENALTY = 8;
/** The prior a given row carries when the user prefers `preferCategory`. */
declare function languagePrior(categoryId: number, preferCategory: number): number;
/**
 * Which index files the scanner loads for a given "Card game" setting.
 *
 * 'auto' scans everything at once. A specific game loads only its own
 * catalogues — structurally impossible to mis-identify across games, and a
 * smaller index means fewer near-neighbours and faster frames. Games with no
 * fingerprint catalogue (sports, other) return [] — the scanner runs AI-only
 * and skips the pointless fingerprint wait.
 */
declare function gamesForHint(hint: string): readonly string[];
/**
 * A card's name with TCGplayer's variant decorations stripped: parentheticals,
 * bracket tags, and trailing " - …" segments — "Spandam (Online Regional 2023)
 * [Winner]" → "spandam". Identical-artwork reprints (event stamps, promo
 * re-releases, WC decks) differ ONLY in these decorations, and they may sit in
 * the same set or different ones, so this — not exact-name-plus-different-set —
 * is the test for "same card, different product".
 */
declare function baseCardName(name: string): string;
/** The decoration `baseCardName` strips — what actually distinguishes twin
 *  products, for picker labels. Empty when the name carries none. */
declare function variantSuffix(name: string): string;

export { CATEGORY_ID as C, FAMILY as F, type IndexGame as I, LANGUAGE as L, OFF_LANGUAGE_PENALTY as O, INDEX_GAMES as a, baseCardName as b, gamesForHint as g, languagePrior as l, variantSuffix as v };
