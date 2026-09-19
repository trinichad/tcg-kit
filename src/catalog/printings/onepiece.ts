// One Piece Card Game: the TCGplayer printing (subTypeName) vocabulary.
//
// NOT enabled (see GAMES in ../index.ts) — the table below is recorded from a
// real tcgcsv sample so that the day One Piece pricing is switched on, nobody
// has to guess what the strings are. What is missing is the *rule* half: which
// printing a given user's copy is. Pokémon needs a rule because one product
// sells as several printings; One Piece barely does (3 products out of 163 in
// the sample), so the interesting work there is product selection, not
// printing selection, and that is a pricing decision to make with real orders
// in front of you.
//
// ── Sampled 2026-09-18 ──────────────────────────────────────────────────────
//   category 68 (One Piece Card Game), group 3188 — "Romance Dawn" (OP01),
//   published 2022-12-02; 87 groups exist in the category.
//   GET https://tcgcsv.com/tcgplayer/68/3188/products  → 163 products
//   GET https://tcgcsv.com/tcgplayer/68/3188/prices    → 166 price rows
//   (tcgcsv 403s a browser User-Agent; send an identifying one — see UA in
//   scripts/lib/cardindex.ts.)
//
// Observed `subTypeName` values: exactly two.
//
//   Normal   94 products
//   Foil     72 products
//   both      3 products (Uta OP01-005, Gecko Moria OP01-068, Overheat OP01-086
//             — all rarity R, sold in each finish)
//
// By rarity, in that group:
//
//   rarity     Normal   Foil   both     what it is
//   L               8      8      0     Leader
//   C              45      4      0     Common
//   UC             30      2      0     Uncommon
//   R               0     29      3     Rare
//   SR              0     20      0     Super Rare
//   SEC             0      5      0     Secret Rare
//   DON!!           1      1      0     the DON!! card
//   (sealed)        7      0      0     packs/boxes — no Number, not indexed
//
// The thing to notice: **alternate art is a separate PRODUCT, not a printing.**
// The variant lives in the product name, and every one of them is sold only as
// Foil. In this group: "(Parallel)" ×27, "(Box Topper)" ×6, "(Alternate Art)",
// "(Manga)", character-name tags for the Baroque Works agents
// ("(Zala)", "(Daz.Bonez)", "(Bentham)", "(Galdino)"), and bare numeric
// disambiguators like "(024)" that TCGplayer adds when two products share a
// name. `baseCardName()` in ../catalogues.ts is what strips these, and it is
// the right test for "same card, different product".
//
// So a One Piece printing table is trivial, and the real work at enable time
// is: given a scan hit (one productId) and a user who says "I have the
// parallel", pick the right *sibling product*. That is the same twin-picker
// problem the recognizer already surfaces.

/** Every subTypeName observed on One Piece singles. */
export const ONEPIECE_PRINTINGS = ['Normal', 'Foil'] as const;

export type OnePiecePrinting = (typeof ONEPIECE_PRINTINGS)[number];

/** Rarity codes carried in `extendedData.Rarity` on a One Piece single. */
export const ONEPIECE_RARITIES = ['L', 'C', 'UC', 'R', 'SR', 'SEC', 'DON!!'] as const;

export type OnePieceRarity = (typeof ONEPIECE_RARITIES)[number];

/**
 * Rarities that are only ever sold foil, from the sample above. A product of
 * one of these rarities with no price row is missing data, not a Normal.
 */
export const FOIL_ONLY_RARITIES: readonly OnePieceRarity[] = ['SR', 'SEC'];

/**
 * Name decorations TCGplayer uses for alternate-art siblings. These identify a
 * DIFFERENT product with the same card name — not a printing of this one.
 * (Bare numeric tags like "(024)" are disambiguators; see `baseCardName`.)
 */
export const VARIANT_TAGS = ['Parallel', 'Box Topper', 'Alternate Art', 'Manga'] as const;

/** The group this table was recorded from, so a re-check is one fetch away. */
export const SAMPLED = {
  categoryId: 68,
  groupId: 3188,
  groupName: 'Romance Dawn',
  abbreviation: 'OP01',
  publishedOn: '2022-12-02',
  sampledOn: '2026-09-18',
  products: 163,
  priceRows: 166,
} as const;

/**
 * Pick a printing for a One Piece product. With a two-value vocabulary there
 * is no chain worth the name: honour `want` when the product has it, else take
 * the product's only printing, and say so.
 */
export function resolvePrinting(
  subTypes: readonly string[],
  want: string = 'Normal',
): { printing: string; fallback: boolean } | null {
  if (!subTypes.length) return null;
  if (subTypes.includes(want)) return { printing: want, fallback: false };
  return { printing: subTypes[0], fallback: true };
}
