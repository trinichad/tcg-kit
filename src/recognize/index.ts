// @holo/tcg-kit/recognize — offline TCG card recognition.
//
// Isomorphic by construction: no node builtins, no dependencies, nothing that
// touches the DOM. The same code runs in a browser Web Worker (matching camera
// frames against the shipped index) and in Node (building that index, and the
// tests that prove the two agree byte-for-byte).
//
//   import { createScanner } from '@holo/tcg-kit/recognize';
//   const scanner = await createScanner({ load, games: ['pokemon'] });
//   const { detected, quad, matches } = await scanner.matchFrame(rgba, w, h);
//
// See `scanner.ts`'s header for a complete Web Worker, and /catalog for
// `gamesForHint()` (which catalogues a "Card game" setting should load) and
// `INDEX_FILES` (what to copy out of data/cardindex/).

// ── the pipeline, stage by stage ───────────────────────────────────────────
// Camera frame → detectCard/guideQuad/refineQuad → rectify → hashCard →
// distances → topK → confidence.
export {
  detectCard,
  guideQuad,
  refineQuad,
  rectify,
  orderCorners,
  polygonArea,
  type Detection,
  type DetectDebug,
  type Point,
  type Quad,
} from './carddetect';

export {
  hashCard,
  distances,
  topK,
  confidence,
  CARD_W,
  CARD_H,
  HASH_BYTES,
  PHASH_BYTES,
  DHASH_BYTES,
  AHASH_BYTES,
  CHASH_BYTES,
  MAX_DISTANCE,
  type Candidate,
  type Rgba,
} from './cardhash';

/** The resampler both sides of a match must share — see resize.ts. */
export { resizeRgba, toCardRect } from './resize';

// ── the shipped index: manifest, versioning, file layout ───────────────────
export {
  MANIFEST_FILE,
  indexVersion,
  indexUrl,
  type CardIndexManifest,
  type GameManifest,
  type GameRunSummary,
  type GameIndexMeta,
} from './cardindex';

// ── the facade ─────────────────────────────────────────────────────────────
export {
  createScanner,
  GUIDE_FILL,
  type Scanner,
  type ScannerOptions,
  type ScanResult,
  type Match,
  type MatchOptions,
} from './scanner';

/** Re-exported so a caller can type `games` without also importing /catalog. */
export type { IndexGame } from '../catalog/catalogues';
