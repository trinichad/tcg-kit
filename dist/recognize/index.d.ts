import { C as CardIndexManifest } from '../cardindex-C5xpvPUs.js';
export { G as GameIndexMeta, a as GameManifest, b as GameRunSummary, M as MANIFEST_FILE, i as indexUrl, c as indexVersion } from '../cardindex-C5xpvPUs.js';
import { I as IndexGame } from '../catalogues-B2qHmLL2.js';

/** Canonical rectified card size everything is hashed at. */
declare const CARD_W = 200;
declare const CARD_H = 280;
/** Byte layout of one fingerprint. */
declare const PHASH_BYTES = 8;
declare const DHASH_BYTES = 8;
declare const AHASH_BYTES = 8;
declare const CHASH_BYTES = 5;
declare const HASH_BYTES: number;
/** Worst-case combined distance, used to normalise confidence to 0..1. */
declare const MAX_DISTANCE: number;
interface Rgba {
    data: Uint8ClampedArray | Uint8Array;
    width: number;
    height: number;
}
/**
 * Fingerprint one rectified card image. Input should already be warped to an
 * upright rectangle; CARD_W x CARD_H is expected but any size works.
 */
declare function hashCard(img: Rgba): Uint8Array;
/**
 * Weighted Hamming distance from one fingerprint to every row of a packed
 * index (a flat Uint8Array of rowCount * HASH_BYTES). Writes into `out` to
 * avoid allocating on every video frame.
 */
declare function distances(query: Uint8Array, index: Uint8Array, rowCount: number, out?: Float64Array): Float64Array;
interface Candidate {
    row: number;
    distance: number;
}
/** The `k` closest rows, nearest first. */
declare function topK(dist: Float64Array, rowCount: number, k?: number): Candidate[];
/**
 * How much to trust a match, 0..1. Built from the gap between the best and
 * runner-up rather than the raw distance: a card is identified when nothing
 * else is close, which is what actually separates a hit from a guess.
 */
declare function confidence(best: Candidate, runnerUp: Candidate | undefined): number;

interface Point {
    x: number;
    y: number;
}
/** Card corners in source-frame pixels, ordered TL, TR, BR, BL. */
type Quad = [Point, Point, Point, Point];
declare function polygonArea(poly: Point[]): number;
/** Order four corners as TL, TR, BR, BL regardless of winding. */
declare function orderCorners(quad: Point[]): Quad;
interface Detection {
    quad: Quad;
    /** Fraction of the frame the card covers — drives "move closer" hints. */
    areaFraction: number;
}
/** Why a frame produced no card, for the accuracy harness. */
interface DetectDebug {
    stage?: 'ok' | 'no-blob' | 'no-quad' | 'implausible';
    blobSize?: number;
    hullSize?: number;
    quad?: Quad;
    ratio?: number;
    areaFraction?: number;
    workW?: number;
    workH?: number;
}
/** Locate a single card in a camera frame. Returns null when none is found. */
declare function detectCard(img: Rgba, debug?: DetectDebug): Detection | null;
/**
 * The viewfinder rectangle: card-shaped, centred, covering `fill` of the frame.
 * The user lines a card up inside it.
 */
declare function guideQuad(w: number, h: number, fill?: number): Quad;
/**
 * Snap a roughly-placed quad onto the card's real edges.
 *
 * Finding a card anywhere in a cluttered frame is hard — measured 35-54% on
 * handheld shots. Finding an edge that we already know is within ~12% of a
 * given line is easy, because the search is one-dimensional and clutter far
 * from the guide can't win. Each edge is sampled at intervals, each sample
 * marches perpendicular for the strongest gradient, and a line is fitted
 * through the hits after discarding outliers — so a finger or a glare streak
 * covering part of an edge doesn't drag the fit.
 */
declare function refineQuad(img: Rgba, quad: Quad, searchFrac?: number): Quad;
/**
 * Warp the quad out of the frame into an upright CARD_W x CARD_H image,
 * sampling bilinearly. This is the input the fingerprint is computed on.
 */
declare function rectify(img: Rgba, quad: Quad, dw?: number, dh?: number): Rgba;

/** Area-average RGBA resize (the hash module's resize, applied to 4 channels). */
declare function resizeRgba(src: Rgba, dw: number, dh: number): Rgba;
/**
 * Resize an arbitrary RGBA image onto the canonical card rectangle.
 * Already-CARD_W x CARD_H input is returned untouched, so a caller that
 * rectified the frame itself pays nothing.
 */
declare function toCardRect(src: Rgba): Rgba;

/** Fraction of the frame the on-screen guide rectangle covers. Draw the same
 *  rectangle in the preview or the user has nothing to line the card up with. */
declare const GUIDE_FILL = 0.92;
/** One ranked index hit. */
interface Match {
    productId: number;
    /** TCGplayer group (set) id — lets a price lookup skip fuzzy set matching. */
    groupId: number;
    /** Which catalogue the row came from; `CATEGORY_ID[game]` is its tcgcsv
     *  category, `LANGUAGE[CATEGORY_ID[game]]` its market language. */
    game: IndexGame;
    name: string;
    number: string;
    /** Weighted Hamming distance, 0..MAX_DISTANCE (292). Lower is better. */
    distance: number;
    /** 0..1 — see `confidence()`. Built from the gap to the NEXT match, so
     *  `matches[0].confidence` is the number BinderPricer gates its lock on. */
    confidence: number;
    /** Set name, when the catalogue knew it. */
    set: string;
}
interface ScanResult {
    /** True when `detectCard` found a card outline in the frame. Matches are
     *  returned either way — the fixed guide rectangle is scored even when
     *  auto-detection fails, which is the case that carries cluttered frames. */
    detected: boolean;
    /** The detected outline in source-frame pixels, TL/TR/BR/BL. */
    quad?: Point[];
    matches: Match[];
}
interface MatchOptions {
    /** How many ranked hits to return. Default 5. */
    k?: number;
}
interface ScannerOptions {
    /**
     * Fetch one index file, relative to wherever `data/cardindex/` was copied.
     *
     * Called with `'manifest.json'` first, then `'<game>.json'` and
     * `'<game>.bin'` for each catalogue — the game files carrying the
     * `?v=<indexVersion>` suffix `indexUrl()` builds, so a phone that cached
     * yesterday's index fetches today's. A `fetch`-based loader passes the
     * string through unchanged; a filesystem loader strips the query with
     * `file.split('?')[0]`.
     *
     * Return a string or an ArrayBuffer — either is accepted for either kind of
     * file. Throw or return a rejected promise when a file is missing.
     */
    load: (file: string) => Promise<ArrayBuffer | string>;
    /** Catalogues to load. Default: every one in `INDEX_GAMES`. `[]` loads
     *  nothing and every match returns empty — a deliberate "no fingerprint
     *  catalogue for this game" mode, not an error. */
    games?: readonly IndexGame[];
    /**
     * The catalogue the user mostly collects; near-ties resolve here.
     *
     * Pokémon prints the same artwork in English and Japanese, so on a degraded
     * frame the two are nearly indistinguishable and half a Japanese sample can
     * match English rows (and get priced in the wrong market). Setting this adds
     * `OFF_LANGUAGE_PENALTY` to the other-language twin WITHIN the same family —
     * a prior, not a filter: a genuinely Japanese card still wins outright.
     *
     * Unset (the default here) means no prior at all. BinderPricer ships
     * `preferCategory: 3`; a consumer loading both Pokémon catalogues should set
     * `preferGame: 'pokemon'` (or `'pokemon-japan'`) to get that behaviour.
     */
    preferGame?: IndexGame;
}
interface Scanner {
    /** Catalogues actually loaded, in load order. */
    games(): IndexGame[];
    /** Total rows across every loaded catalogue. */
    readonly count: number;
    /** The manifest the index was loaded under, when one was served. */
    readonly manifest: CardIndexManifest | null;
    /**
     * Identify a card in a full camera frame: detect the outline, rectify,
     * fingerprint, rank. Async so a future implementation can move the work
     * without changing callers; today it resolves synchronously.
     */
    matchFrame(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, opts?: MatchOptions): Promise<ScanResult>;
    /** Identify an already-cropped card image — a gallery photo, a scan, a
     *  catalog render. Any size; resized to CARD_W x CARD_H internally. */
    matchCard(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, opts?: MatchOptions): Promise<Match[]>;
    /** The 29 fingerprint bytes of an already-cropped card, for callers that
     *  want to cache or ship them. Same resize as `matchCard`. */
    hash(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array;
}
declare function createScanner(opts: ScannerOptions): Promise<Scanner>;

export { AHASH_BYTES, CARD_H, CARD_W, CHASH_BYTES, type Candidate, CardIndexManifest, DHASH_BYTES, type DetectDebug, type Detection, GUIDE_FILL, HASH_BYTES, IndexGame, MAX_DISTANCE, type Match, type MatchOptions, PHASH_BYTES, type Point, type Quad, type Rgba, type ScanResult, type Scanner, type ScannerOptions, confidence, createScanner, detectCard, distances, guideQuad, hashCard, orderCorners, polygonArea, rectify, refineQuad, resizeRgba, toCardRect, topK };
