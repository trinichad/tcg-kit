// Find a trading card in a camera frame and warp it flat.
//
// This is the step that makes fingerprinting work at all: hashing a raw camera
// frame identifies ~11% of cards, hashing the same frame after rectification
// identifies ~97%. Perceptual hashes have no rotation or perspective
// invariance, so the geometry has to be normalised first.
//
// Deliberately hand-rolled rather than OpenCV.js — we need five operations
// (blur, gradient, threshold, contour-to-quad, warp) and the WASM build is
// 14 MB, which is a bad trade for a phone-first scanner. Everything below is
// plain typed-array work and runs in a few ms on a 320px frame.
//
// Pipeline: downscale -> grey -> blur -> Sobel -> Otsu -> dilate ->
//           largest connected edge blob -> convex hull -> 4-point simplify ->
//           validate shape -> warp to CARD_W x CARD_H.

import { CARD_W, CARD_H, type Rgba } from './cardhash';

export interface Point {
  x: number;
  y: number;
}

/** Card corners in source-frame pixels, ordered TL, TR, BR, BL. */
export type Quad = [Point, Point, Point, Point];

/** Frame is downscaled to this width before analysis — detection doesn't need
 *  detail, and it keeps the whole pass at a few milliseconds. */
const WORK_WIDTH = 320;

/** A standard card is 63x88mm, ratio 0.716. Perspective skews what the camera
 *  sees, so accept a generous band and let the fingerprint reject bad crops. */
const MIN_RATIO = 0.5;
const MAX_RATIO = 1.0;

/** Reject quads that are too small to be the card being presented. */
const MIN_AREA_FRACTION = 0.06;

// ------------------------------------------------------------- basic filters

function toGray(img: Rgba, dw: number, dh: number): Float64Array {
  const { data, width: sw, height: sh } = img;
  const out = new Float64Array(dw * dh);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(sh - 1, (dy * yr) | 0);
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, (dx * xr) | 0);
      const p = (sy * sw + sx) * 4;
      out[dy * dw + dx] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1000;
    }
  }
  return out;
}

/** Separable 5-tap binomial blur — cheap Gaussian approximation. */
function blur(src: Float64Array, w: number, h: number): Float64Array {
  const k = [1, 4, 6, 4, 1];
  const norm = 16;
  const tmp = new Float64Array(w * h);
  const out = new Float64Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        s += src[y * w + Math.min(w - 1, Math.max(0, x + i))] * k[i + 2];
      }
      tmp[y * w + x] = s / norm;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let i = -2; i <= 2; i++) {
        s += tmp[Math.min(h - 1, Math.max(0, y + i)) * w + x] * k[i + 2];
      }
      out[y * w + x] = s / norm;
    }
  }
  return out;
}

/** Sobel gradient magnitude. */
function sobel(src: Float64Array, w: number, h: number): Float64Array {
  const out = new Float64Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = src[i - w - 1];
      const t = src[i - w];
      const tr = src[i - w + 1];
      const l = src[i - 1];
      const r = src[i + 1];
      const bl = src[i + w - 1];
      const b = src[i + w];
      const br = src[i + w + 1];
      const gx = tr + 2 * r + br - tl - 2 * l - bl;
      const gy = bl + 2 * b + br - tl - 2 * t - tr;
      out[i] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/** Otsu's method over a 256-bin histogram of the values. */
function otsu(values: Float64Array): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max <= 0) return 0;
  const bins = new Float64Array(256);
  for (let i = 0; i < values.length; i++) bins[Math.min(255, ((values[i] / max) * 255) | 0)]++;

  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * bins[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    wB += bins[t];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * bins[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  return (best / 255) * max;
}

/** 3x3 dilation, to close small gaps in the card's outline. */
function dilate(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;
      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) {
            on = 1;
            break;
          }
        }
      }
      out[y * w + x] = on;
    }
  }
  return out;
}

/**
 * Everything the background can reach from the frame edge without crossing an
 * edge pixel. The card's outline is a closed loop, so the flood stops at it and
 * whatever is left is the card.
 *
 * This matters more than it sounds: the densest cluster of edges on a Pokemon
 * card is the ARTWORK box, which is wider than it is tall. Segmenting by
 * "largest blob of edges" therefore locks onto the art and every quad gets
 * rejected for having a ~1.24 aspect ratio instead of the card's 0.72.
 */
function floodBackground(edge: Uint8Array, w: number, h: number): Uint8Array {
  const bg = new Uint8Array(w * h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!edge[i] && !bg[i]) {
      bg[i] = 1;
      stack.push(i);
    }
  };
  for (let x = 0; x < w; x++) {
    push(x);
    push((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    push(y * w);
    push(y * w + w - 1);
  }
  // 4-connected: a diagonal pinhole in the card border shouldn't leak.
  while (stack.length) {
    const i = stack.pop() as number;
    const x = i % w;
    const y = (i / w) | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return bg;
}

interface Blob {
  /** Pixel count of the component. */
  count: number;
  /** Leftmost and rightmost pixel of each row it occupies. */
  outline: Point[];
}

/** How many candidate components to hull and score per mask. */
const MAX_CANDIDATES = 6;

/**
 * The largest 8-connected blob. The card's outline survives blur and
 * thresholding as one big connected loop; isolated background clutter doesn't.
 *
 * Only each row's extreme pixels are returned. Anything between them is
 * strictly inside the segment joining them, so it can never be a convex-hull
 * vertex — and returning ~2 points per row instead of one object per pixel
 * takes this from ~30 ms a frame to a few, since the flood-filled card
 * interior is tens of thousands of pixels.
 */
function candidateBlobs(mask: Uint8Array, w: number, h: number): Blob[] {
  const label = new Int32Array(w * h).fill(-1);
  const stack: number[] = [];
  interface Comp {
    label: number;
    count: number;
    x0: number;
    y0: number;
    x1: number;
    y1: number;
  }
  const comps: Comp[] = [];

  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] !== -1) continue;
    let count = 0;
    let x0 = w;
    let y0 = h;
    let x1 = -1;
    let y1 = -1;
    stack.push(start);
    label[start] = start;
    while (stack.length) {
      const i = stack.pop() as number;
      count++;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (mask[j] && label[j] === -1) {
            label[j] = start;
            stack.push(j);
          }
        }
      }
    }
    if (count >= 40) comps.push({ label: start, count, x0, y0, x1, y1 });
  }

  // Rank by bounding-box EXTENT, not pixel count. The card's outline is a thin
  // loop that encloses the whole card; its artwork is a dense blob covering
  // only the art box. By pixel count the artwork always wins — which is why
  // detection used to lock onto a ~1.2 aspect ratio instead of the card's 0.72.
  comps.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const keep = comps.slice(0, MAX_CANDIDATES);

  return keep.map((c) => {
    const outline: Point[] = [];
    for (let y = c.y0; y <= c.y1; y++) {
      const row = y * w;
      let minX = -1;
      let maxX = -1;
      for (let x = c.x0; x <= c.x1; x++) {
        if (label[row + x] === c.label) {
          if (minX < 0) minX = x;
          maxX = x;
        }
      }
      if (minX >= 0) {
        outline.push({ x: minX, y });
        if (maxX !== minX) outline.push({ x: maxX, y });
      }
    }
    return { count: c.count, outline };
  });
}

/**
 * How much this quad looks like the card we want, 0..1. Several components can
 * yield a valid-looking quad — the card, the slab around it, the artwork box, a
 * clutter rectangle behind the hand — so the winner is scored rather than
 * assumed. Aspect dominates: it is what separates a card (0.72) from its
 * artwork (~1.2) and from a slab (~0.62).
 */
function cardScore(quad: Quad, w: number, h: number): number {
  const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const width = (side(quad[0], quad[1]) + side(quad[2], quad[3])) / 2;
  const height = (side(quad[1], quad[2]) + side(quad[3], quad[0])) / 2;
  if (width <= 0 || height <= 0) return 0;

  const CARD_RATIO = 0.714;
  const aspect = 1 - Math.min(1, Math.abs(width / height - CARD_RATIO) / 0.32);
  const area = polygonArea(quad);
  // Prefer a card that fills a decent part of the frame, without rewarding
  // something that has swallowed the whole scene.
  const frac = area / (w * h);
  const size = frac >= 0.75 ? Math.max(0, 1 - (frac - 0.75) * 3) : Math.min(1, frac / 0.35);
  // A hand-held card sits near the middle of the viewfinder.
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const off = Math.hypot(cx - w / 2, cy - h / 2) / Math.hypot(w / 2, h / 2);
  const centred = 1 - Math.min(1, off);
  // A true rectangle's corners are near-square; a ragged blob's are not.
  const rect = Math.min(1, (width * height) / Math.max(1e-6, area));

  return 0.55 * aspect + 0.2 * size + 0.15 * centred + 0.1 * Math.min(1, rect);
}

// ------------------------------------------------------------------ geometry

const cross = (o: Point, a: Point, b: Point) =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

/** Andrew's monotone chain convex hull, counter-clockwise. */
function convexHull(points: Point[]): Point[] {
  if (points.length < 4) return points.slice();
  const pts = points.slice().sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));
  const lower: Point[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper: Point[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function perimeter(poly: Point[]): number {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}

export function polygonArea(poly: Point[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}

/** Douglas-Peucker simplification of a closed polygon. */
function simplify(poly: Point[], epsilon: number): Point[] {
  if (poly.length <= 4) return poly.slice();
  // Anchor at the two most distant points so the closed ring splits sensibly.
  let iFar = 0;
  let dFar = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i].x - poly[0].x, poly[i].y - poly[0].y);
    if (d > dFar) {
      dFar = d;
      iFar = i;
    }
  }
  const a = poly.slice(0, iFar + 1);
  const b = poly.slice(iFar).concat([poly[0]]);
  const out = dp(a, epsilon).concat(dp(b, epsilon).slice(1, -1));
  return out;
}

function dp(line: Point[], epsilon: number): Point[] {
  if (line.length < 3) return line.slice();
  const first = line[0];
  const last = line[line.length - 1];
  let index = -1;
  let maxDist = 0;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < line.length - 1; i++) {
    const d = Math.abs((line[i].x - first.x) * dy - (line[i].y - first.y) * dx) / len;
    if (d > maxDist) {
      maxDist = d;
      index = i;
    }
  }
  if (maxDist <= epsilon || index < 0) return [first, last];
  return dp(line.slice(0, index + 1), epsilon).slice(0, -1).concat(dp(line.slice(index), epsilon));
}

/** Simplify a hull down to exactly four corners, searching over epsilon. */
function toQuad(hull: Point[]): Point[] | null {
  if (hull.length < 4) return null;
  if (hull.length === 4) return hull;
  const peri = perimeter(hull);
  let lo = 0.001;
  let hi = 0.25;
  let fallback: Point[] | null = null;
  for (let iter = 0; iter < 24; iter++) {
    const eps = ((lo + hi) / 2) * peri;
    const s = simplify(hull, eps);
    if (s.length === 4) return s;
    if (s.length > 4) {
      lo = (lo + hi) / 2;
      if (s.length <= 6) fallback = s;
    } else {
      hi = (lo + hi) / 2;
    }
  }
  // Never landed exactly on 4 — take the 4 extreme corners of the best hull.
  return fallback ? extremeQuad(fallback) : extremeQuad(hull);
}

/** The classic document-scanner fallback: corners by extremes of x±y. */
function extremeQuad(poly: Point[]): Point[] {
  let tl = poly[0];
  let br = poly[0];
  let tr = poly[0];
  let bl = poly[0];
  for (const p of poly) {
    if (p.x + p.y < tl.x + tl.y) tl = p;
    if (p.x + p.y > br.x + br.y) br = p;
    if (p.x - p.y > tr.x - tr.y) tr = p;
    if (p.x - p.y < bl.x - bl.y) bl = p;
  }
  return [tl, tr, br, bl];
}

/** Order four corners as TL, TR, BR, BL regardless of winding. */
export function orderCorners(quad: Point[]): Quad {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const byAngle = quad
    .slice()
    .sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  // Angles start at -pi (left), so rotate until the first point is top-left.
  let start = 0;
  let bestScore = Infinity;
  for (let i = 0; i < 4; i++) {
    const p = byAngle[i];
    const score = p.x + p.y;
    if (score < bestScore) {
      bestScore = score;
      start = i;
    }
  }
  return [
    byAngle[start % 4],
    byAngle[(start + 1) % 4],
    byAngle[(start + 2) % 4],
    byAngle[(start + 3) % 4],
  ] as Quad;
}

function isConvex(q: Quad): boolean {
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const c = cross(q[i], q[(i + 1) % 4], q[(i + 2) % 4]);
    if (c === 0) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Shape sanity: convex, card-ish aspect, big enough, not a sliver. */
function plausibleCard(q: Quad, w: number, h: number): boolean {
  if (!isConvex(q)) return false;
  const area = polygonArea(q);
  if (area < w * h * MIN_AREA_FRACTION) return false;

  const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
  const top = side(q[0], q[1]);
  const right = side(q[1], q[2]);
  const bottom = side(q[2], q[3]);
  const left = side(q[3], q[0]);
  if (Math.min(top, right, bottom, left) < 12) return false;

  // Opposite sides should roughly match, or it isn't a rectangle in 3-space.
  if (Math.min(top, bottom) / Math.max(top, bottom) < 0.6) return false;
  if (Math.min(left, right) / Math.max(left, right) < 0.6) return false;

  const width = (top + bottom) / 2;
  const height = (left + right) / 2;
  const ratio = width / height;
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO;
}

// ------------------------------------------------------------------ detection

export interface Detection {
  quad: Quad;
  /** Fraction of the frame the card covers — drives "move closer" hints. */
  areaFraction: number;
}

/** Why a frame produced no card, for the accuracy harness. */
export interface DetectDebug {
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
export function detectCard(img: Rgba, debug?: DetectDebug): Detection | null {
  const dw = Math.min(WORK_WIDTH, img.width);
  const dh = Math.max(1, Math.round((img.height / img.width) * dw));
  const scaleX = img.width / dw;
  const scaleY = img.height / dh;
  if (debug) {
    debug.workW = dw;
    debug.workH = dh;
  }

  const grad = sobel(blur(toGray(img, dw, dh), dw, dh), dw, dh);
  const t = otsu(grad);
  const raw = new Uint8Array(dw * dh);
  for (let i = 0; i < grad.length; i++) raw[i] = grad[i] >= t ? 1 : 0;
  const edge = dilate(raw, dw, dh);

  // Primary: whatever the background flood can't reach is the card.
  // Fallback: the largest blob of edges, for frames where the border leaks.
  const bg = floodBackground(edge, dw, dh);
  const enclosed = new Uint8Array(dw * dh);
  let enclosedCount = 0;
  for (let i = 0; i < enclosed.length; i++) {
    if (!bg[i]) {
      enclosed[i] = 1;
      enclosedCount++;
    }
  }

  // Two views of the scene, because either can be the one that works: the
  // region the background flood can't reach (clean backdrop), and the raw edge
  // components (cluttered backdrop, where the flood gets blocked before it
  // ever reaches the card).
  const blobs: Blob[] = [];
  if (enclosedCount > 40 && enclosedCount < dw * dh * 0.98) {
    blobs.push(...candidateBlobs(enclosed, dw, dh));
  }
  blobs.push(...candidateBlobs(edge, dw, dh));
  if (!blobs.length) {
    if (debug) debug.stage = 'no-blob';
    return null;
  }
  if (debug) debug.blobSize = blobs[0].count;

  let chosen: Quad | null = null;
  let chosenScore = 0;
  let sawQuad = false;
  for (const blob of blobs) {
    if (blob.count < 40) continue;
    const hull = convexHull(blob.outline);
    const quadPts = toQuad(hull);
    if (!quadPts || quadPts.length !== 4) continue;
    const quad = orderCorners(quadPts);
    sawQuad = true;
    if (debug && !debug.quad) {
      debug.hullSize = hull.length;
      debug.quad = quad;
      const side = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
      debug.ratio =
        (side(quad[0], quad[1]) + side(quad[2], quad[3])) /
        (side(quad[1], quad[2]) + side(quad[3], quad[0]));
      debug.areaFraction = polygonArea(quad) / (dw * dh);
    }
    if (!plausibleCard(quad, dw, dh)) continue;
    const score = cardScore(quad, dw, dh);
    if (score > chosenScore) {
      chosenScore = score;
      chosen = quad;
    }
  }
  if (!chosen) {
    if (debug) debug.stage = sawQuad ? 'implausible' : 'no-quad';
    return null;
  }
  if (debug) {
    debug.stage = 'ok';
    debug.quad = chosen;
  }

  const scaled = chosen.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY })) as Quad;
  return { quad: scaled, areaFraction: polygonArea(chosen) / (dw * dh) };
}

// ------------------------------------------------------- guided detection

/**
 * The viewfinder rectangle: card-shaped, centred, covering `fill` of the frame.
 * The user lines a card up inside it.
 */
export function guideQuad(w: number, h: number, fill = 0.92): Quad {
  const ratio = CARD_W / CARD_H;
  let gh = h * fill;
  let gw = gh * ratio;
  if (gw > w * fill) {
    gw = w * fill;
    gh = gw / ratio;
  }
  const x0 = (w - gw) / 2;
  const y0 = (h - gh) / 2;
  return [
    { x: x0, y: y0 },
    { x: x0 + gw, y: y0 },
    { x: x0 + gw, y: y0 + gh },
    { x: x0, y: y0 + gh },
  ];
}

interface Line {
  px: number;
  py: number;
  dx: number;
  dy: number;
}

function intersect(a: Line, b: Line): Point | null {
  const det = a.dx * -b.dy - a.dy * -b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const rx = b.px - a.px;
  const ry = b.py - a.py;
  const t = (rx * -b.dy - ry * -b.dx) / det;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}

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
export function refineQuad(img: Rgba, quad: Quad, searchFrac = 0.12): Quad {
  const dw = Math.min(WORK_WIDTH, img.width);
  const dh = Math.max(1, Math.round((img.height / img.width) * dw));
  const sx = dw / img.width;
  const sy = dh / img.height;
  const grad = sobel(blur(toGray(img, dw, dh), dw, dh), dw, dh);
  const at = (x: number, y: number) => {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= dw || yi >= dh) return 0;
    return grad[yi * dw + xi];
  };

  const small = quad.map((p) => ({ x: p.x * sx, y: p.y * sy })) as Quad;
  const lines: (Line | null)[] = [];

  for (let e = 0; e < 4; e++) {
    const a = small[e];
    const b = small[(e + 1) % 4];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) {
      lines.push(null);
      continue;
    }
    const dx = (b.x - a.x) / len;
    const dy = (b.y - a.y) / len;
    const nx = -dy;
    const ny = dx;
    const reach = Math.max(3, len * searchFrac);

    const hits: { x: number; y: number; off: number }[] = [];
    const SAMPLES = 24;
    for (let i = 0; i < SAMPLES; i++) {
      // Skip the corners: they are where two edges blur together.
      const t = 0.12 + (0.76 * i) / (SAMPLES - 1);
      const bx = a.x + dx * len * t;
      const by = a.y + dy * len * t;
      let bestOff = 0;
      let bestVal = 0;
      for (let s = -reach; s <= reach; s += 0.5) {
        const v = at(bx + nx * s, by + ny * s);
        if (v > bestVal) {
          bestVal = v;
          bestOff = s;
        }
      }
      if (bestVal > 0) hits.push({ x: bx + nx * bestOff, y: by + ny * bestOff, off: bestOff });
    }
    if (hits.length < 8) {
      lines.push(null);
      continue;
    }
    // Drop samples whose offset disagrees with the consensus (fingers, glare).
    const offs = hits.map((p) => p.off).sort((p, q) => p - q);
    const medOff = offs[offs.length >> 1];
    const spread = Math.max(2, reach * 0.35);
    const kept = hits.filter((p) => Math.abs(p.off - medOff) <= spread);
    if (kept.length < 6) {
      lines.push(null);
      continue;
    }
    // Least-squares fit along the edge direction.
    let sxm = 0;
    let sym = 0;
    for (const p of kept) {
      sxm += p.x;
      sym += p.y;
    }
    const mx = sxm / kept.length;
    const my = sym / kept.length;
    let num = 0;
    let den = 0;
    for (const p of kept) {
      const u = (p.x - mx) * dx + (p.y - my) * dy; // along the edge
      const v = (p.x - mx) * nx + (p.y - my) * ny; // across it
      num += u * v;
      den += u * u;
    }
    const slope = den > 1e-6 ? num / den : 0;
    // Direction tilted by the fitted slope, anchored at the fitted centroid.
    const fdx = dx + nx * slope;
    const fdy = dy + ny * slope;
    const flen = Math.hypot(fdx, fdy) || 1;
    lines.push({ px: mx, py: my, dx: fdx / flen, dy: fdy / flen });
  }

  const out: Point[] = [];
  for (let c = 0; c < 4; c++) {
    const prev = lines[(c + 3) % 4];
    const cur = lines[c];
    const fallback = small[c];
    const p = prev && cur ? intersect(prev, cur) : null;
    // Reject a corner that flew off; a bad intersection is worse than the guide.
    const ok =
      p && Math.hypot(p.x - fallback.x, p.y - fallback.y) < Math.max(dw, dh) * 0.25;
    out.push(ok ? (p as Point) : fallback);
  }
  return out.map((p) => ({ x: p.x / sx, y: p.y / sy })) as Quad;
}

// -------------------------------------------------------------------- warping

/**
 * Coefficients of the projective map src -> dst, solved by Gaussian
 * elimination on the standard 8x8 homography system.
 */
function solvePerspective(src: Point[], dst: Point[]): number[] {
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const { x: u, y: v } = dst[i];
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  for (let col = 0; col < 8; col++) {
    let pivot = col;
    for (let r = col + 1; r < 8; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (Math.abs(a[pivot][col]) < 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0];
    [a[col], a[pivot]] = [a[pivot], a[col]];
    [b[col], b[pivot]] = [b[pivot], b[col]];
    for (let r = 0; r < 8; r++) {
      if (r === col) continue;
      const f = a[r][col] / a[col][col];
      if (f === 0) continue;
      for (let c = col; c < 8; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  return b.map((v, i) => v / a[i][i]);
}

/**
 * Warp the quad out of the frame into an upright CARD_W x CARD_H image,
 * sampling bilinearly. This is the input the fingerprint is computed on.
 */
export function rectify(img: Rgba, quad: Quad, dw = CARD_W, dh = CARD_H): Rgba {
  // Solve output -> input so each destination pixel pulls from the source.
  const c = solvePerspective(
    [
      { x: 0, y: 0 },
      { x: dw, y: 0 },
      { x: dw, y: dh },
      { x: 0, y: dh },
    ],
    quad,
  );
  const { data, width: sw, height: sh } = img;
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const denom = c[6] * x + c[7] * y + 1;
      const sx = (c[0] * x + c[1] * y + c[2]) / denom;
      const sy = (c[3] * x + c[4] * y + c[5]) / denom;
      const p = (y * dw + x) * 4;
      if (sx < 0 || sy < 0 || sx > sw - 1 || sy > sh - 1) {
        out[p + 3] = 255;
        continue;
      }
      const x0 = sx | 0;
      const y0 = sy | 0;
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const fx = sx - x0;
      const fy = sy - y0;
      for (let ch = 0; ch < 3; ch++) {
        const v00 = data[(y0 * sw + x0) * 4 + ch];
        const v10 = data[(y0 * sw + x1) * 4 + ch];
        const v01 = data[(y1 * sw + x0) * 4 + ch];
        const v11 = data[(y1 * sw + x1) * 4 + ch];
        out[p + ch] =
          v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}
