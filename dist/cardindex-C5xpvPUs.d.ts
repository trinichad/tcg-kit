declare const MANIFEST_FILE = "manifest.json";
interface GameManifest {
    count: number;
    sets: number;
    /** YYYY-MM-DD of the last change to this catalogue's index files. */
    builtAt: string;
    /** Every tcgcsv group (set) the updater has crawled for this catalogue — so
     * "new set on TCGplayer?" is a diff, not a guess. */
    knownGroups: number[];
}
interface GameRunSummary {
    added: number;
    removed: number;
    failed: number;
    newSets: string[];
    skipped?: string;
}
interface CardIndexManifest {
    version: 1;
    updatedAt: string;
    total: number;
    games: Record<string, GameManifest>;
    lastRun: {
        at: string;
        added: number;
        removed: number;
        failed: number;
        placeholders: number;
        upcoming: {
            game: string;
            name: string;
            publishedOn: string;
        }[];
        byGame: Record<string, GameRunSummary>;
    } | null;
}
/** Cache-busting version for a catalogue's index files: changes whenever the
 * files do, so a phone that cached yesterday's index fetches today's. */
declare function indexVersion(manifest: CardIndexManifest | null, game: string): string;
/**
 * Where a catalogue's index file is served from. `base` is the public path the
 * consumer copied `data/cardindex/` to — BinderPricer serves it at
 * `/cardindex`, which stays the default.
 */
declare function indexUrl(game: string, ext: 'json' | 'bin', version: string, base?: string): string;
/**
 * What one catalogue's `<game>.json` holds, alongside its `<game>.bin` of
 * packed fingerprints. Row i of the .bin (HASH_BYTES each) is `cards[i]`.
 *
 * `cards` are compact tuples rather than objects — roughly a third the bytes
 * over a 27k-card catalogue, which is the difference between a phone
 * downloading the index once and giving up on it.
 */
interface GameIndexMeta {
    version: 1;
    game: string;
    /** tcgcsv category the rows were crawled from (3 = English Pokémon, …). */
    categoryId: number;
    /** Bytes per fingerprint — asserted against HASH_BYTES on load. */
    hashBytes: number;
    cardW: number;
    cardH: number;
    count: number;
    /** YYYY-MM-DD the files were last rewritten. */
    builtAt: string;
    /** groupId (as a string key) → set name. */
    groups: Record<string, string>;
    /** [productId, groupId, name, number], parallel to the .bin rows. */
    cards: [number, number, string, string][];
}

export { type CardIndexManifest as C, type GameIndexMeta as G, MANIFEST_FILE as M, type GameManifest as a, type GameRunSummary as b, indexVersion as c, indexUrl as i };
