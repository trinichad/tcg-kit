// Perceptual fingerprints for card images.
//
// The same code runs in two places and MUST agree bit-for-bit:
//   - scripts/build-index.ts (Node) hashes every TCGplayer catalog image
//   - the live scanner (browser) hashes each rectified camera frame
// so everything here works on raw RGBA + a hand-written resize rather than
// PIL/canvas/sharp, whose resampling differs between platforms.
//
// Four hashes, 29 bytes per card. Chosen by ablation against 5,862 cards and
// simulated camera captures (angle, glare, blur, noise, JPEG):
//
//   combo        bytes  1 frame   top-5   5-frame vote
//   A only           8    94.0%   99.3%     98.0%
//   P+D             16    87.3%   96.0%     97.3%
//   P+D+A           24    96.0%  100.0%     98.7%
//   P+D+A+C         29    96.7%  100.0%     99.3%   <- this
//   +256-bit art    61    96.7%  100.0%     98.0%   (bigger AND worse)
//
// Hashing the raw camera frame instead of a rectified card scores 11%.
// Rectification is not optional.

/** Canonical rectified card size everything is hashed at. */
export const CARD_W = 200;
export const CARD_H = 280;

/** Byte layout of one fingerprint. */
export const PHASH_BYTES = 8; // 8x8 DCT of the whole card
export const DHASH_BYTES = 8; // 9x8 horizontal gradient
export const AHASH_BYTES = 8; // 8x8 DCT of the art box only
export const CHASH_BYTES = 5; // 4x3 grid of mean RGB (36 bits)
export const HASH_BYTES = PHASH_BYTES + DHASH_BYTES + AHASH_BYTES + CHASH_BYTES; // 29

/** Art box as a fraction of the card — Pokemon borders and text boxes are
 *  near-identical between cards, so the art carries the signal. */
const ART = { x0: 0.08, y0: 0.1, x1: 0.92, y1: 0.52 };

/** Distance weights. Art is worth double; see the ablation table above. */
const W_PHASH = 1;
const W_DHASH = 1;
const W_AHASH = 2;
const W_CHASH = 1;

/** Worst-case combined distance, used to normalise confidence to 0..1. */
export const MAX_DISTANCE =
  W_PHASH * 64 + W_DHASH * 64 + W_AHASH * 64 + W_CHASH * 36;

export interface Rgba {
  data: Uint8ClampedArray | Uint8Array;
  width: number;
  height: number;
}

// ---------------------------------------------------------------- resampling

/**
 * Area-average resize of a single channel. Every output pixel is the mean of
 * the input pixels its footprint covers, with fractional weights at the edges
 * — deterministic, and the right filter for the large downscales we do here
 * (a 200x280 card to 32x32).
 */
function resizeChannel(
  src: Float64Array,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): Float64Array {
  // Horizontal pass into an sh x dw buffer, then vertical into dh x dw.
  const horiz = new Float64Array(sh * dw);
  const xRatio = sw / dw;
  for (let dx = 0; dx < dw; dx++) {
    const x0 = dx * xRatio;
    const x1 = x0 + xRatio;
    const first = Math.floor(x0);
    const last = Math.min(sw - 1, Math.ceil(x1) - 1);
    for (let y = 0; y < sh; y++) {
      let sum = 0;
      let weight = 0;
      for (let x = first; x <= last; x++) {
        const w = Math.min(x + 1, x1) - Math.max(x, x0);
        if (w <= 0) continue;
        sum += src[y * sw + x] * w;
        weight += w;
      }
      horiz[y * dw + dx] = weight > 0 ? sum / weight : 0;
    }
  }

  const out = new Float64Array(dh * dw);
  const yRatio = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yRatio;
    const y1 = y0 + yRatio;
    const first = Math.floor(y0);
    const last = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let dx = 0; dx < dw; dx++) {
      let sum = 0;
      let weight = 0;
      for (let y = first; y <= last; y++) {
        const w = Math.min(y + 1, y1) - Math.max(y, y0);
        if (w <= 0) continue;
        sum += horiz[y * dw + dx] * w;
        weight += w;
      }
      out[dy * dw + dx] = weight > 0 ? sum / weight : 0;
    }
  }
  return out;
}

/** ITU-R 601-2 luma, matching PIL's RGB->L conversion. */
function toLuma(img: Rgba): Float64Array {
  const { data, width, height } = img;
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
  }
  return out;
}

/** Crop a sub-rectangle out of an RGBA image (fractional coords). */
function cropRgba(img: Rgba, x0f: number, y0f: number, x1f: number, y1f: number): Rgba {
  const x0 = Math.round(x0f * img.width);
  const y0 = Math.round(y0f * img.height);
  const x1 = Math.round(x1f * img.width);
  const y1 = Math.round(y1f * img.height);
  const w = Math.max(1, x1 - x0);
  const h = Math.max(1, y1 - y0);
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcRow = (y0 + y) * img.width * 4;
    out.set(img.data.subarray(srcRow + x0 * 4, srcRow + (x0 + w) * 4), y * w * 4);
  }
  return { data: out, width: w, height: h };
}

// ---------------------------------------------------------------- transforms

const dctTables = new Map<number, Float64Array>();

/** Cosine table for an n-point DCT-II, built once per size. */
function dctTable(n: number): Float64Array {
  let t = dctTables.get(n);
  if (!t) {
    t = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
      for (let x = 0; x < n; x++) {
        t[k * n + x] = Math.cos((Math.PI * (2 * x + 1) * k) / (2 * n));
      }
    }
    dctTables.set(n, t);
  }
  return t;
}

/**
 * Top-left `keep` x `keep` block of the 2-D DCT-II of an n x n matrix.
 * Only the low-frequency corner is needed, so the full transform is skipped.
 */
function dct2Corner(m: Float64Array, n: number, keep: number): Float64Array {
  const t = dctTable(n);
  // rows first: tmp[v][x] = sum_y t[v][y] * m[y][x], for v < keep
  const tmp = new Float64Array(keep * n);
  for (let v = 0; v < keep; v++) {
    for (let y = 0; y < n; y++) {
      const c = t[v * n + y];
      if (c === 0) continue;
      const row = y * n;
      for (let x = 0; x < n; x++) tmp[v * n + x] += c * m[row + x];
    }
  }
  // then columns: out[v][u] = sum_x tmp[v][x] * t[u][x]
  const out = new Float64Array(keep * keep);
  for (let v = 0; v < keep; v++) {
    for (let u = 0; u < keep; u++) {
      let sum = 0;
      for (let x = 0; x < n; x++) sum += tmp[v * n + x] * t[u * n + x];
      out[v * keep + u] = sum;
    }
  }
  return out;
}

function median(values: Float64Array | number[]): number {
  const s = Array.from(values).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Pack booleans MSB-first into bytes, matching numpy's packbits. */
function packBits(bits: boolean[], into: Uint8Array, offset: number): void {
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) into[offset + (i >> 3)] |= 0x80 >> (i & 7);
  }
}

// ---------------------------------------------------------------- the hashes

/** 64-bit DCT hash of a luma image. */
function phashInto(img: Rgba, out: Uint8Array, offset: number, size = 8, factor = 4): void {
  const n = size * factor;
  const gray = resizeChannel(toLuma(img), img.width, img.height, n, n);
  const d = dct2Corner(gray, n, size);
  // Median over everything except the DC term, which only encodes brightness.
  const med = median(d.subarray(1));
  const bits: boolean[] = new Array(size * size);
  for (let i = 0; i < d.length; i++) bits[i] = d[i] > med;
  packBits(bits, out, offset);
}

/** 64-bit horizontal-gradient hash — cheap and brightness-invariant. */
function dhashInto(img: Rgba, out: Uint8Array, offset: number, size = 8): void {
  const g = resizeChannel(toLuma(img), img.width, img.height, size + 1, size);
  const bits: boolean[] = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bits[y * size + x] = g[y * (size + 1) + x + 1] > g[y * (size + 1) + x];
    }
  }
  packBits(bits, out, offset);
}

/**
 * 36-bit coarse colour signature: a 4x3 grid of mean RGB, each channel
 * thresholded against that channel's overall mean. Separates cards whose
 * luma structure is similar but whose palettes differ.
 */
function chashInto(img: Rgba, out: Uint8Array, offset: number): void {
  const gw = 3;
  const gh = 4;
  const { data, width, height } = img;
  // Mean RGB per grid cell, via an area-average resize per channel.
  const chans: Float64Array[] = [];
  for (let c = 0; c < 3; c++) {
    const plane = new Float64Array(width * height);
    for (let i = 0, p = c; i < plane.length; i++, p += 4) plane[i] = data[p];
    chans.push(resizeChannel(plane, width, height, gw, gh));
  }
  const bits: boolean[] = new Array(gh * gw * 3);
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < chans[c].length; i++) mean += chans[c][i];
    mean /= chans[c].length;
    for (let i = 0; i < chans[c].length; i++) bits[i * 3 + c] = chans[c][i] > mean;
  }
  packBits(bits, out, offset);
}

/**
 * Fingerprint one rectified card image. Input should already be warped to an
 * upright rectangle; CARD_W x CARD_H is expected but any size works.
 */
export function hashCard(img: Rgba): Uint8Array {
  const out = new Uint8Array(HASH_BYTES);
  phashInto(img, out, 0);
  dhashInto(img, out, PHASH_BYTES);
  phashInto(cropRgba(img, ART.x0, ART.y0, ART.x1, ART.y1), out, PHASH_BYTES + DHASH_BYTES);
  chashInto(img, out, PHASH_BYTES + DHASH_BYTES + AHASH_BYTES);
  return out;
}

// ---------------------------------------------------------------- matching

/** Popcount for a byte. */
const POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];

/** Weight applied to each byte position of a fingerprint. */
const BYTE_WEIGHT = new Float64Array(HASH_BYTES);
for (let i = 0; i < HASH_BYTES; i++) {
  BYTE_WEIGHT[i] =
    i < PHASH_BYTES
      ? W_PHASH
      : i < PHASH_BYTES + DHASH_BYTES
        ? W_DHASH
        : i < PHASH_BYTES + DHASH_BYTES + AHASH_BYTES
          ? W_AHASH
          : W_CHASH;
}

/**
 * Weighted Hamming distance from one fingerprint to every row of a packed
 * index (a flat Uint8Array of rowCount * HASH_BYTES). Writes into `out` to
 * avoid allocating on every video frame.
 */
export function distances(
  query: Uint8Array,
  index: Uint8Array,
  rowCount: number,
  out?: Float64Array,
): Float64Array {
  const result = out && out.length >= rowCount ? out : new Float64Array(rowCount);
  // HOT: this loop runs rows × 3 crops per video frame — at a 190k-card index
  // that's ~17M byte ops a frame. Weights are constant per SEGMENT, so sum
  // integer popcounts per segment and multiply once per row instead of per
  // byte (integer sums of ≤128 are exact in float64, so the result is
  // bit-identical to the naive per-byte version — verified in scripts).
  // Query bytes are hoisted: `query[b]` inside the loop defeats the JIT.
  const q0 = query[0], q1 = query[1], q2 = query[2], q3 = query[3];
  const q4 = query[4], q5 = query[5], q6 = query[6], q7 = query[7];
  const q8 = query[8], q9 = query[9], q10 = query[10], q11 = query[11];
  const q12 = query[12], q13 = query[13], q14 = query[14], q15 = query[15];
  const q16 = query[16], q17 = query[17], q18 = query[18], q19 = query[19];
  const q20 = query[20], q21 = query[21], q22 = query[22], q23 = query[23];
  const q24 = query[24], q25 = query[25], q26 = query[26], q27 = query[27];
  const q28 = query[28];
  const P = POPCOUNT;
  for (let r = 0, p = 0; r < rowCount; r++, p += HASH_BYTES) {
    const ph =
      P[index[p] ^ q0] + P[index[p + 1] ^ q1] + P[index[p + 2] ^ q2] + P[index[p + 3] ^ q3] +
      P[index[p + 4] ^ q4] + P[index[p + 5] ^ q5] + P[index[p + 6] ^ q6] + P[index[p + 7] ^ q7];
    const dh =
      P[index[p + 8] ^ q8] + P[index[p + 9] ^ q9] + P[index[p + 10] ^ q10] + P[index[p + 11] ^ q11] +
      P[index[p + 12] ^ q12] + P[index[p + 13] ^ q13] + P[index[p + 14] ^ q14] + P[index[p + 15] ^ q15];
    const ah =
      P[index[p + 16] ^ q16] + P[index[p + 17] ^ q17] + P[index[p + 18] ^ q18] + P[index[p + 19] ^ q19] +
      P[index[p + 20] ^ q20] + P[index[p + 21] ^ q21] + P[index[p + 22] ^ q22] + P[index[p + 23] ^ q23];
    const ch =
      P[index[p + 24] ^ q24] + P[index[p + 25] ^ q25] + P[index[p + 26] ^ q26] + P[index[p + 27] ^ q27] +
      P[index[p + 28] ^ q28];
    result[r] = W_PHASH * ph + W_DHASH * dh + W_AHASH * ah + W_CHASH * ch;
  }
  return result;
}

export interface Candidate {
  row: number;
  distance: number;
}

/** The `k` closest rows, nearest first. */
export function topK(dist: Float64Array, rowCount: number, k = 5): Candidate[] {
  const best: Candidate[] = [];
  for (let r = 0; r < rowCount; r++) {
    const d = dist[r];
    if (best.length < k) {
      best.push({ row: r, distance: d });
      if (best.length === k) best.sort((a, b) => a.distance - b.distance);
    } else if (d < best[k - 1].distance) {
      best[k - 1] = { row: r, distance: d };
      for (let i = k - 1; i > 0 && best[i].distance < best[i - 1].distance; i--) {
        [best[i], best[i - 1]] = [best[i - 1], best[i]];
      }
    }
  }
  return best.length < k ? best.sort((a, b) => a.distance - b.distance) : best;
}

/**
 * How much to trust a match, 0..1. Built from the gap between the best and
 * runner-up rather than the raw distance: a card is identified when nothing
 * else is close, which is what actually separates a hit from a guess.
 */
export function confidence(best: Candidate, runnerUp: Candidate | undefined): number {
  if (!runnerUp) return 1;
  const gap = runnerUp.distance - best.distance;
  const closeness = 1 - Math.min(1, best.distance / (MAX_DISTANCE * 0.25));
  const separation = Math.min(1, gap / 24);
  return Math.max(0, Math.min(1, 0.35 * closeness + 0.65 * separation));
}
