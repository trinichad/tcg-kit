// The scanner facade: load the shipped fingerprint catalogues once, then turn
// camera frames (or already-cropped card photos) into ranked TCGplayer
// products.
//
// This is BinderPricer's `src/scan/worker.ts` with the messaging, the
// multi-frame vote and the app's session state taken out — the kit ships the
// per-frame pipeline and the row→match mapping, and leaves voting, locking and
// the twin picker to the app, which is where those thresholds were measured.
//
// ── Running it inside a Web Worker ──────────────────────────────────────────
//
// Nothing here touches the DOM, `window` or any node builtin, so the whole
// module loads in a Worker. The worker owns the index (tens of MB of typed
// arrays) and does all per-frame work off the main thread, so the camera
// preview never stutters. A complete worker:
//
//   // scan.worker.ts
//   import { createScanner, type Scanner } from '@holo/tcg-kit/recognize';
//   const BASE = '/cardindex';                       // where you copied data/cardindex
//   let scanner: Scanner;
//   self.onmessage = async (e) => {
//     const m = e.data;
//     if (m.type === 'init') {
//       // `file` arrives as 'manifest.json' or '<game>.bin?v=<indexVersion>' —
//       // the `?v=` is what stops a phone matching against yesterday's index,
//       // so pass the string straight through to fetch(). (A filesystem
//       // `load` strips it: file.split('?')[0].)
//       scanner = await createScanner({
//         load: async (file) => {
//           const r = await fetch(`${BASE}/${file}`, {
//             cache: file.startsWith('manifest') ? 'no-cache' : 'default',
//           });
//           if (!r.ok) throw new Error(`${file}: http ${r.status}`);
//           return file.endsWith('.json') || file.startsWith('manifest')
//             ? r.text()
//             : r.arrayBuffer();
//         },
//         games: m.games,              // e.g. gamesForHint('pokemon') from /catalog
//       });
//       self.postMessage({ type: 'ready', count: scanner.count });
//     } else if (m.type === 'frame') {
//       // Transfer the frame's buffer from the main thread (no copy):
//       //   worker.postMessage({ type:'frame', buffer, width, height }, [buffer])
//       const rgba = new Uint8ClampedArray(m.buffer);
//       self.postMessage(await scanner.matchFrame(rgba, m.width, m.height));
//     }
//   };
//
// Main thread: `ctx.drawImage(video, …)` into a small canvas (BinderPricer
// uses 320px wide), `getImageData(...).data.buffer`, post it, and draw
// `result.quad` back over the preview. Send one frame at a time — wait for the
// reply before grabbing the next, or the queue outruns the matcher.

import {
  detectCard,
  guideQuad,
  refineQuad,
  rectify,
  type Point,
  type Quad,
} from './carddetect';
import {
  HASH_BYTES,
  confidence,
  distances,
  hashCard,
  topK,
  type Candidate,
  type Rgba,
} from './cardhash';
import {
  MANIFEST_FILE,
  indexVersion,
  type CardIndexManifest,
  type GameIndexMeta,
} from './cardindex';
import {
  CATEGORY_ID,
  INDEX_GAMES,
  languagePrior,
  type IndexGame,
} from '../catalog/catalogues';
import { toCardRect } from './resize';

/** Fraction of the frame the on-screen guide rectangle covers. Draw the same
 *  rectangle in the preview or the user has nothing to line the card up with. */
export const GUIDE_FILL = 0.92;

/** One ranked index hit. */
export interface Match {
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

export interface ScanResult {
  /** True when `detectCard` found a card outline in the frame. Matches are
   *  returned either way — the fixed guide rectangle is scored even when
   *  auto-detection fails, which is the case that carries cluttered frames. */
  detected: boolean;
  /** The detected outline in source-frame pixels, TL/TR/BR/BL. */
  quad?: Point[];
  matches: Match[];
}

export interface MatchOptions {
  /** How many ranked hits to return. Default 5. */
  k?: number;
}

export interface ScannerOptions {
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

export interface Scanner {
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
  matchFrame(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    opts?: MatchOptions,
  ): Promise<ScanResult>;
  /** Identify an already-cropped card image — a gallery photo, a scan, a
   *  catalog render. Any size; resized to CARD_W x CARD_H internally. */
  matchCard(
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
    opts?: MatchOptions,
  ): Promise<Match[]>;
  /** The 29 fingerprint bytes of an already-cropped card, for callers that
   *  want to cache or ship them. Same resize as `matchCard`. */
  hash(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number): Uint8Array;
}

// ── loading ─────────────────────────────────────────────────────────────────

const decoder = new TextDecoder();

function asText(payload: ArrayBuffer | string): string {
  if (typeof payload === 'string') return payload;
  return decoder.decode(payload as ArrayBuffer);
}

function asBytes(payload: ArrayBuffer | string): Uint8Array {
  if (typeof payload === 'string') {
    throw new Error('expected binary index data, got a string');
  }
  if (ArrayBuffer.isView(payload as unknown as ArrayBufferView)) {
    const v = payload as unknown as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(payload as ArrayBuffer);
}

/** The manifest is tiny and always revalidated; the big files are then
 *  requested under a version that changes when they do. A missing or unparsable
 *  manifest is not fatal — the index files are still served, just uncached. */
async function loadManifest(load: ScannerOptions['load']): Promise<CardIndexManifest | null> {
  try {
    return JSON.parse(asText(await load(MANIFEST_FILE))) as CardIndexManifest;
  } catch {
    return null;
  }
}

interface LoadedGame {
  game: IndexGame;
  meta: GameIndexMeta;
  bin: Uint8Array;
}

async function loadGame(
  load: ScannerOptions['load'],
  game: IndexGame,
  version: string,
): Promise<LoadedGame | null> {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : '';
  try {
    const [metaRaw, binRaw] = await Promise.all([
      load(`${game}.json${suffix}`),
      load(`${game}.bin${suffix}`),
    ]);
    const meta = JSON.parse(asText(metaRaw)) as GameIndexMeta;
    const bin = asBytes(binRaw);
    if (meta.hashBytes !== HASH_BYTES) {
      throw new Error(`${game}.json says ${meta.hashBytes} hash bytes, this build expects ${HASH_BYTES}`);
    }
    if (bin.length < meta.count * HASH_BYTES || meta.cards.length !== meta.count) {
      throw new Error(`${game} index is corrupt: ${meta.count} cards, ${bin.length} bytes`);
    }
    return { game, meta, bin };
  } catch {
    return null;
  }
}

/** All loaded catalogues flattened into one searchable table. */
interface Catalogue {
  count: number;
  cards: [number, number, string, string][];
  /** Parallel to `cards`: which catalogue each row came from. */
  gameOf: IndexGame[];
  setOf: string[];
  index: Uint8Array;
  /** Per-row language prior; all zeros when `preferGame` is unset. */
  prior: Float64Array;
  /** False when `prior` is all zeros, so the hot loops can skip it. */
  hasPrior: boolean;
  games: IndexGame[];
}

export async function createScanner(opts: ScannerOptions): Promise<Scanner> {
  const games = (opts.games ?? INDEX_GAMES) as readonly IndexGame[];
  const manifest = games.length ? await loadManifest(opts.load) : null;
  const results = await Promise.all(
    games.map(async (g) => ({ game: g, part: await loadGame(opts.load, g, indexVersion(manifest, g)) })),
  );

  // games=[] is a deliberate no-catalogue mode (sports has no fingerprint
  // index) — ready with zero rows, not an error.
  const loaded = results.map((r) => r.part).filter((x): x is LoadedGame => !!x);
  if (!loaded.length && games.length) throw new Error('no card index could be loaded');
  // A PARTIAL load must not pass silently: lose pokemon-japan on a flaky show
  // connection and every Japanese card quietly gets English prices, with the
  // UI showing a smaller card count nobody reads. Say which one is missing.
  const missing = results.filter((r) => !r.part).map((r) => r.game);
  if (missing.length) {
    throw new Error(
      `card index incomplete — ${missing.join(', ')} failed to load. Retry before scanning (matching now would identify cards from the wrong catalogue).`,
    );
  }

  const total = loaded.reduce((n, l) => n + l.meta.count, 0);
  const merged = new Uint8Array(total * HASH_BYTES);
  const cards: [number, number, string, string][] = [];
  const gameOf: IndexGame[] = new Array(total);
  const setOf: string[] = new Array(total);
  const prior = new Float64Array(total);
  const preferCategory = opts.preferGame ? CATEGORY_ID[opts.preferGame] : 0;

  let row = 0;
  for (const l of loaded) {
    merged.set(l.bin.subarray(0, l.meta.count * HASH_BYTES), row * HASH_BYTES);
    for (const c of l.meta.cards) {
      cards.push(c);
      gameOf[row] = l.game;
      setOf[row] = l.meta.groups?.[String(c[1])] ?? '';
      prior[row] = preferCategory ? languagePrior(l.meta.categoryId, preferCategory) : 0;
      row++;
    }
  }

  const cat: Catalogue = {
    count: total,
    cards,
    gameOf,
    setOf,
    index: merged,
    prior,
    hasPrior: !!preferCategory,
    games: loaded.map((l) => l.game),
  };
  // One distance buffer per candidate crop, reused across frames — allocating
  // three 200k-element Float64Arrays per frame is a GC pause per frame.
  const scratch = [0, 1, 2].map(() => new Float64Array(total));
  const blended = new Float64Array(total);

  return makeScanner(cat, scratch, blended, manifest);
}

// ── matching ────────────────────────────────────────────────────────────────

function makeScanner(
  cat: Catalogue,
  scratch: Float64Array[],
  blended: Float64Array,
  manifest: CardIndexManifest | null,
): Scanner {
  /**
   * Build a light Match from an index row.
   *
   * categoryId (via `game`) and groupId come straight from the index, so a
   * price enrichment is an exact lookup rather than a set-name guess — and a
   * Japanese hit prices against the Japanese catalogue.
   */
  const toMatch = (c: Candidate, next: Candidate | undefined): Match => {
    const [productId, groupId, name, number] = cat.cards[c.row];
    return {
      productId,
      groupId,
      game: cat.gameOf[c.row],
      name,
      number,
      set: cat.setOf[c.row],
      distance: c.distance,
      confidence: confidence(c, next),
    };
  };

  const rank = (dist: Float64Array, k: number): Match[] => {
    if (!cat.count) return [];
    // k+1: the last match still needs a runner-up to measure its gap against.
    const best = topK(dist, cat.count, Math.max(1, k) + 1);
    return best.slice(0, Math.max(1, k)).map((c, i) => toMatch(c, best[i + 1]));
  };

  const fingerprint = (
    rgba: Uint8ClampedArray | Uint8Array,
    width: number,
    height: number,
  ): Uint8Array => hashCard(toCardRect({ data: rgba, width, height }));

  return {
    games: () => [...cat.games],
    count: cat.count,
    manifest,

    hash: fingerprint,

    async matchCard(rgba, width, height, opts) {
      if (!cat.count) return [];
      const d = distances(fingerprint(rgba, width, height), cat.index, cat.count, scratch[0]);
      if (cat.hasPrior) for (let i = 0; i < cat.count; i++) d[i] += cat.prior[i];
      return rank(d, opts?.k ?? 5);
    },

    async matchFrame(rgba, width, height, opts) {
      if (!cat.count) return { detected: false, matches: [] };
      const img: Rgba = { data: rgba, width, height };

      /**
       * Three ways of cropping the card out of a frame, blended by how
       * decisive each one turns out to be. No single crop is reliable across
       * real conditions:
       *
       *   capture style              auto-detect   guide   blended
       *   clean desk, card small        96.7%        0%     93.3%
       *   clutter, card fills frame     16.0%       50%     62.0%
       *   clutter, filled + aligned     22.0%       70%     70.0%
       *
       * Auto-detect needs the whole card comfortably inside a calm frame; the
       * fixed guide rectangle needs the user to fill it. Handheld shots
       * against shop clutter break the first and reward the second, so both
       * run and the one that separates its top two candidates most cleanly
       * gets the most say.
       */
      const guide = guideQuad(width, height, GUIDE_FILL);
      const det = detectCard(img);
      const quads: Quad[] = [guide, refineQuad(img, guide)];
      if (det) quads.push(det.quad);

      const weights: number[] = [];
      let totalWeight = 0;
      for (let k = 0; k < quads.length; k++) {
        const d = distances(hashCard(rectify(img, quads[k])), cat.index, cat.count, scratch[k]);
        const t2 = topK(d, cat.count, 2);
        const w = confidence(t2[0], t2[1]);
        weights.push(w);
        totalWeight += w;
      }
      if (totalWeight < 0.01) {
        // Nothing convincing anywhere — fall back to an even blend rather than
        // dividing by ~zero, and let the low confidence speak for itself.
        weights.fill(1);
        totalWeight = weights.length;
      }
      for (let i = 0; i < cat.count; i++) {
        let acc = 0;
        for (let k = 0; k < quads.length; k++) acc += scratch[k][i] * (weights[k] / totalWeight);
        blended[i] = cat.hasPrior ? acc + cat.prior[i] : acc;
      }

      return {
        detected: !!det,
        quad: det ? det.quad.map((p) => ({ x: p.x, y: p.y })) : undefined,
        matches: rank(blended, opts?.k ?? 5),
      };
    },
  };
}
