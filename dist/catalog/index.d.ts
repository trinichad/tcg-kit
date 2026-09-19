import { I as IndexGame } from '../catalogues-B2qHmLL2.js';
export { C as CATEGORY_ID, F as FAMILY, a as INDEX_GAMES, L as LANGUAGE, O as OFF_LANGUAGE_PENALTY, b as baseCardName, g as gamesForHint, l as languagePrior, v as variantSuffix } from '../catalogues-B2qHmLL2.js';
import { C as CardIndexManifest } from '../cardindex-C5xpvPUs.js';

/**
 * Every subTypeName TCGplayer uses for a Pokémon single.
 *
 * Three eras, and a product carries the vocabulary of exactly one of them:
 *   modern  — Normal / Holofoil / Reverse Holofoil
 *   WOTC    — 1st Edition / 1st Edition Holofoil / Unlimited / Unlimited Holofoil
 *   Base Set shadowed (group 604) — Normal / Holofoil, like a modern set
 *
 * "Shadowless" is NOT a subTypeName. It is a separate TCGplayer group
 * ("Base Set (Shadowless)", 1663) holding its own products, which then carry
 * the WOTC subTypes above. See `wantsShadowlessGroup`.
 */
declare const POKEMON_PRINTINGS: readonly ["Normal", "Holofoil", "Reverse Holofoil", "1st Edition", "1st Edition Holofoil", "Unlimited", "Unlimited Holofoil"];
type PokemonPrinting = (typeof POKEMON_PRINTINGS)[number];
/** Base Set, shadowed. The ordinary Base Set products live here. */
declare const BASE_SET_GROUP_ID = 604;
/** "Base Set (Shadowless)" — its own group, its own products, WOTC subTypes. */
declare const BASE_SET_SHADOWLESS_GROUP_ID = 1663;
/** Edition tags a user can append to a card number. */
declare const EDITIONS: readonly ["1st Edition", "Shadowless", "Unlimited"];
type PokemonEdition = (typeof EDITIONS)[number] | '';
/**
 * Finish tags, **compound names first** so "Holo" never matches inside
 * "Reverse Holo" — the first match wins and the order is the rule.
 *
 * Rainbow Rare / Full Art / Gold describe a different card NUMBER, not a
 * printing of this one, so they are parsed (to be stripped out of the number)
 * and then ignored by the printing rules.
 */
declare const FINISHES: readonly ["Reverse Holo", "Rainbow Rare", "Full Art", "Gold", "Holo"];
type PokemonFinish = (typeof FINISHES)[number] | '';
/** "044/102" ≡ "44/102"; "TG18/TG30" keeps its letters; "" / "Unknown" → "". */
declare function normNum(s: unknown): string;
/**
 * An index number field may list several cards ("53/111, 54/111", "AR1, AR2 …",
 * "18/106 19/106"): each is its own TCGplayer product. Normalised,
 * de-duplicated, in the order written.
 */
declare function numberTokens(field: unknown): string[];
/** Same card number, allowing a bare numerator ("44") against "44/102". */
declare function numMatch(a: unknown, b: unknown): boolean;
interface OwnedTags {
    /** The card number with every tag stripped out; '' when there wasn't one. */
    number: string;
    edition: PokemonEdition;
    finish: PokemonFinish;
}
/**
 * Split "44/102 Unlimited Holo" into { number, edition, finish }.
 *
 * Editions are scanned without breaking, so the LAST one written wins;
 * finishes break on the first hit, and FINISHES is ordered compound-first so
 * "Reverse Holo" can never be read as "Holo".
 */
declare function parseOwned(ownedCardNumber: unknown): OwnedTags;
/** A product is WOTC-era when its own subTypes say so. */
declare function isWotcProduct(subTypes: readonly string[]): boolean;
/** Does this product offer a 1st Edition printing of its own? */
declare function hasFirstEdition(subTypes: readonly string[]): boolean;
/**
 * Should a copy tagged `edition` be priced against the **Base Set
 * (Shadowless)** group's product instead of the shadowed one?
 *
 * Shadowless copies live there, and so do 1st Edition copies — which are
 * shadowless for every Base Set card but one. The exception is why the second
 * clause exists: Machamp's stamped copy IS shadowed and TCGplayer files it as
 * its own product (42425) with a `1st Edition…` printing, so when the plain
 * product already offers 1st Edition, the copy stays there.
 */
declare function wantsShadowlessGroup(edition: PokemonEdition, plainProductSubTypes: readonly string[]): boolean;
interface WantOptions {
    /** True for a WOTC-era product, or any product in the Shadowless group. */
    wotc: boolean;
    edition: PokemonEdition;
    /** The copy is a holo print — the number matched the card's Holo number, or
     *  the user tagged it "Holo". */
    isHolo: boolean;
    finish: PokemonFinish;
}
/** The printing a copy *wants*, before checking the product actually has it. */
declare function wantedPrinting({ wotc, edition, isHolo, finish }: WantOptions): PokemonPrinting;
/**
 * Fallback order when the wanted printing is not one the product offers:
 * wanted → its non-holo twin (`… Holofoil` → `…`) → `Normal` → the product's
 * first printing.
 */
declare function fallbackChain(want: string, subTypes: readonly string[]): string[];
interface PrintingChoice {
    /** The subTypeName to price against. */
    printing: string;
    /**
     * True when the chain had to fall back. Never hidden: the client shows the
     * same number, the job logs the substitution — a silent fallback is how a
     * Reverse Holo quietly gets a Normal's price.
     */
    fallback: boolean;
}
/**
 * Resolve `subTypes` + what the user typed into one printing. Returns null
 * only when the product has no printings at all.
 */
declare function resolvePrinting$1(subTypes: readonly string[], opts: WantOptions): PrintingChoice | null;
/** The printing an unowned / untagged copy is priced at: `Normal` when the
 *  product has one, else its first printing (a holo rare or promo → Holofoil). */
declare function defaultPrinting(subTypes: readonly string[]): PrintingChoice | null;

declare const pokemon_BASE_SET_GROUP_ID: typeof BASE_SET_GROUP_ID;
declare const pokemon_BASE_SET_SHADOWLESS_GROUP_ID: typeof BASE_SET_SHADOWLESS_GROUP_ID;
declare const pokemon_EDITIONS: typeof EDITIONS;
declare const pokemon_FINISHES: typeof FINISHES;
type pokemon_OwnedTags = OwnedTags;
declare const pokemon_POKEMON_PRINTINGS: typeof POKEMON_PRINTINGS;
type pokemon_PokemonEdition = PokemonEdition;
type pokemon_PokemonFinish = PokemonFinish;
type pokemon_PokemonPrinting = PokemonPrinting;
type pokemon_PrintingChoice = PrintingChoice;
type pokemon_WantOptions = WantOptions;
declare const pokemon_defaultPrinting: typeof defaultPrinting;
declare const pokemon_fallbackChain: typeof fallbackChain;
declare const pokemon_hasFirstEdition: typeof hasFirstEdition;
declare const pokemon_isWotcProduct: typeof isWotcProduct;
declare const pokemon_normNum: typeof normNum;
declare const pokemon_numMatch: typeof numMatch;
declare const pokemon_numberTokens: typeof numberTokens;
declare const pokemon_parseOwned: typeof parseOwned;
declare const pokemon_wantedPrinting: typeof wantedPrinting;
declare const pokemon_wantsShadowlessGroup: typeof wantsShadowlessGroup;
declare namespace pokemon {
  export { pokemon_BASE_SET_GROUP_ID as BASE_SET_GROUP_ID, pokemon_BASE_SET_SHADOWLESS_GROUP_ID as BASE_SET_SHADOWLESS_GROUP_ID, pokemon_EDITIONS as EDITIONS, pokemon_FINISHES as FINISHES, type pokemon_OwnedTags as OwnedTags, pokemon_POKEMON_PRINTINGS as POKEMON_PRINTINGS, type pokemon_PokemonEdition as PokemonEdition, type pokemon_PokemonFinish as PokemonFinish, type pokemon_PokemonPrinting as PokemonPrinting, type pokemon_PrintingChoice as PrintingChoice, type pokemon_WantOptions as WantOptions, pokemon_defaultPrinting as defaultPrinting, pokemon_fallbackChain as fallbackChain, pokemon_hasFirstEdition as hasFirstEdition, pokemon_isWotcProduct as isWotcProduct, pokemon_normNum as normNum, pokemon_numMatch as numMatch, pokemon_numberTokens as numberTokens, pokemon_parseOwned as parseOwned, resolvePrinting$1 as resolvePrinting, pokemon_wantedPrinting as wantedPrinting, pokemon_wantsShadowlessGroup as wantsShadowlessGroup };
}

/** Every subTypeName observed on One Piece singles. */
declare const ONEPIECE_PRINTINGS: readonly ["Normal", "Foil"];
type OnePiecePrinting = (typeof ONEPIECE_PRINTINGS)[number];
/** Rarity codes carried in `extendedData.Rarity` on a One Piece single. */
declare const ONEPIECE_RARITIES: readonly ["L", "C", "UC", "R", "SR", "SEC", "DON!!"];
type OnePieceRarity = (typeof ONEPIECE_RARITIES)[number];
/**
 * Rarities that are only ever sold foil, from the sample above. A product of
 * one of these rarities with no price row is missing data, not a Normal.
 */
declare const FOIL_ONLY_RARITIES: readonly OnePieceRarity[];
/**
 * Name decorations TCGplayer uses for alternate-art siblings. These identify a
 * DIFFERENT product with the same card name — not a printing of this one.
 * (Bare numeric tags like "(024)" are disambiguators; see `baseCardName`.)
 */
declare const VARIANT_TAGS: readonly ["Parallel", "Box Topper", "Alternate Art", "Manga"];
/** The group this table was recorded from, so a re-check is one fetch away. */
declare const SAMPLED: {
    readonly categoryId: 68;
    readonly groupId: 3188;
    readonly groupName: "Romance Dawn";
    readonly abbreviation: "OP01";
    readonly publishedOn: "2022-12-02";
    readonly sampledOn: "2026-09-18";
    readonly products: 163;
    readonly priceRows: 166;
};
/**
 * Pick a printing for a One Piece product. With a two-value vocabulary there
 * is no chain worth the name: honour `want` when the product has it, else take
 * the product's only printing, and say so.
 */
declare function resolvePrinting(subTypes: readonly string[], want?: string): {
    printing: string;
    fallback: boolean;
} | null;

declare const onepiece_FOIL_ONLY_RARITIES: typeof FOIL_ONLY_RARITIES;
declare const onepiece_ONEPIECE_PRINTINGS: typeof ONEPIECE_PRINTINGS;
declare const onepiece_ONEPIECE_RARITIES: typeof ONEPIECE_RARITIES;
type onepiece_OnePiecePrinting = OnePiecePrinting;
type onepiece_OnePieceRarity = OnePieceRarity;
declare const onepiece_SAMPLED: typeof SAMPLED;
declare const onepiece_VARIANT_TAGS: typeof VARIANT_TAGS;
declare const onepiece_resolvePrinting: typeof resolvePrinting;
declare namespace onepiece {
  export { onepiece_FOIL_ONLY_RARITIES as FOIL_ONLY_RARITIES, onepiece_ONEPIECE_PRINTINGS as ONEPIECE_PRINTINGS, onepiece_ONEPIECE_RARITIES as ONEPIECE_RARITIES, type onepiece_OnePiecePrinting as OnePiecePrinting, type onepiece_OnePieceRarity as OnePieceRarity, onepiece_SAMPLED as SAMPLED, onepiece_VARIANT_TAGS as VARIANT_TAGS, onepiece_resolvePrinting as resolvePrinting };
}

/**
 * Which games the pricing side is actually wired for.
 *
 * `enabled: false` means the printing vocabulary has been recorded from a real
 * tcgcsv sample but the rules that pick between printings have not been
 * written and measured — so pricing must refuse rather than guess. Recognition
 * is unaffected: every catalogue in `INDEX_GAMES` is fingerprinted and
 * scannable regardless of what is listed here.
 */
declare const GAMES: {
    readonly pokemon: {
        readonly enabled: true;
        readonly categoryId: 3;
        readonly printings: readonly ["Normal", "Holofoil", "Reverse Holofoil", "1st Edition", "1st Edition Holofoil", "Unlimited", "Unlimited Holofoil"];
    };
    readonly onepiece: {
        readonly enabled: false;
        readonly categoryId: 68;
        readonly printings: readonly ["Normal", "Foil"];
    };
};
type PricedGame = keyof typeof GAMES;
/**
 * Every file a consumer must copy out of `data/cardindex/` to run the scanner,
 * in load order: the manifest, then each catalogue's metadata + fingerprints.
 *
 * `scripts/copy-index.ts` does the copying; this is the list it works from, and
 * the answer to "what do I put in my public/ directory?".
 */
declare const INDEX_FILES: readonly string[];
/** The files for a subset of catalogues — what `--games pokemon,onepiece` copies. */
declare function indexFilesFor(games: readonly IndexGame[]): string[];
/**
 * A manifest narrowed to the catalogues actually being shipped.
 *
 * Copying three of nine catalogues but the whole manifest leaves the scanner
 * asking for six files that aren't there — and a partial load is a hard error,
 * by design, because the alternative is quietly pricing Japanese cards in the
 * English market. Totals are recomputed so the count shown to a user matches
 * what was shipped.
 */
declare function manifestFor(manifest: CardIndexManifest, games: readonly IndexGame[]): CardIndexManifest;

export { GAMES, INDEX_FILES, IndexGame, type PricedGame, indexFilesFor, manifestFor, onepiece as onepiecePrintings, pokemon as pokemonPrintings };
