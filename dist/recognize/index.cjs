'use strict';

// src/recognize/cardhash.ts
var CARD_W = 200;
var CARD_H = 280;
var PHASH_BYTES = 8;
var DHASH_BYTES = 8;
var AHASH_BYTES = 8;
var CHASH_BYTES = 5;
var HASH_BYTES = PHASH_BYTES + DHASH_BYTES + AHASH_BYTES + CHASH_BYTES;
var ART = { x0: 0.08, y0: 0.1, x1: 0.92, y1: 0.52 };
var W_PHASH = 1;
var W_DHASH = 1;
var W_AHASH = 2;
var W_CHASH = 1;
var MAX_DISTANCE = W_PHASH * 64 + W_DHASH * 64 + W_AHASH * 64 + W_CHASH * 36;
function resizeChannel(src, sw, sh, dw, dh) {
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
function toLuma(img) {
  const { data, width, height } = img;
  const out = new Float64Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += 4) {
    out[i] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1e3;
  }
  return out;
}
function cropRgba(img, x0f, y0f, x1f, y1f) {
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
var dctTables = /* @__PURE__ */ new Map();
function dctTable(n) {
  let t = dctTables.get(n);
  if (!t) {
    t = new Float64Array(n * n);
    for (let k = 0; k < n; k++) {
      for (let x = 0; x < n; x++) {
        t[k * n + x] = Math.cos(Math.PI * (2 * x + 1) * k / (2 * n));
      }
    }
    dctTables.set(n, t);
  }
  return t;
}
function dct2Corner(m, n, keep) {
  const t = dctTable(n);
  const tmp = new Float64Array(keep * n);
  for (let v = 0; v < keep; v++) {
    for (let y = 0; y < n; y++) {
      const c = t[v * n + y];
      if (c === 0) continue;
      const row = y * n;
      for (let x = 0; x < n; x++) tmp[v * n + x] += c * m[row + x];
    }
  }
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
function median(values) {
  const s = Array.from(values).sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function packBits(bits, into, offset) {
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) into[offset + (i >> 3)] |= 128 >> (i & 7);
  }
}
function phashInto(img, out, offset, size = 8, factor = 4) {
  const n = size * factor;
  const gray = resizeChannel(toLuma(img), img.width, img.height, n, n);
  const d = dct2Corner(gray, n, size);
  const med = median(d.subarray(1));
  const bits = new Array(size * size);
  for (let i = 0; i < d.length; i++) bits[i] = d[i] > med;
  packBits(bits, out, offset);
}
function dhashInto(img, out, offset, size = 8) {
  const g = resizeChannel(toLuma(img), img.width, img.height, size + 1, size);
  const bits = new Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      bits[y * size + x] = g[y * (size + 1) + x + 1] > g[y * (size + 1) + x];
    }
  }
  packBits(bits, out, offset);
}
function chashInto(img, out, offset) {
  const gw = 3;
  const gh = 4;
  const { data, width, height } = img;
  const chans = [];
  for (let c = 0; c < 3; c++) {
    const plane = new Float64Array(width * height);
    for (let i = 0, p = c; i < plane.length; i++, p += 4) plane[i] = data[p];
    chans.push(resizeChannel(plane, width, height, gw, gh));
  }
  const bits = new Array(gh * gw * 3);
  for (let c = 0; c < 3; c++) {
    let mean = 0;
    for (let i = 0; i < chans[c].length; i++) mean += chans[c][i];
    mean /= chans[c].length;
    for (let i = 0; i < chans[c].length; i++) bits[i * 3 + c] = chans[c][i] > mean;
  }
  packBits(bits, out, offset);
}
function hashCard(img) {
  const out = new Uint8Array(HASH_BYTES);
  phashInto(img, out, 0);
  dhashInto(img, out, PHASH_BYTES);
  phashInto(cropRgba(img, ART.x0, ART.y0, ART.x1, ART.y1), out, PHASH_BYTES + DHASH_BYTES);
  chashInto(img, out, PHASH_BYTES + DHASH_BYTES + AHASH_BYTES);
  return out;
}
var POPCOUNT = new Uint8Array(256);
for (let i = 0; i < 256; i++) POPCOUNT[i] = (i & 1) + POPCOUNT[i >> 1];
var BYTE_WEIGHT = new Float64Array(HASH_BYTES);
for (let i = 0; i < HASH_BYTES; i++) {
  BYTE_WEIGHT[i] = i < PHASH_BYTES ? W_PHASH : i < PHASH_BYTES + DHASH_BYTES ? W_DHASH : i < PHASH_BYTES + DHASH_BYTES + AHASH_BYTES ? W_AHASH : W_CHASH;
}
function distances(query, index, rowCount, out) {
  const result = out && out.length >= rowCount ? out : new Float64Array(rowCount);
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
    const ph = P[index[p] ^ q0] + P[index[p + 1] ^ q1] + P[index[p + 2] ^ q2] + P[index[p + 3] ^ q3] + P[index[p + 4] ^ q4] + P[index[p + 5] ^ q5] + P[index[p + 6] ^ q6] + P[index[p + 7] ^ q7];
    const dh = P[index[p + 8] ^ q8] + P[index[p + 9] ^ q9] + P[index[p + 10] ^ q10] + P[index[p + 11] ^ q11] + P[index[p + 12] ^ q12] + P[index[p + 13] ^ q13] + P[index[p + 14] ^ q14] + P[index[p + 15] ^ q15];
    const ah = P[index[p + 16] ^ q16] + P[index[p + 17] ^ q17] + P[index[p + 18] ^ q18] + P[index[p + 19] ^ q19] + P[index[p + 20] ^ q20] + P[index[p + 21] ^ q21] + P[index[p + 22] ^ q22] + P[index[p + 23] ^ q23];
    const ch = P[index[p + 24] ^ q24] + P[index[p + 25] ^ q25] + P[index[p + 26] ^ q26] + P[index[p + 27] ^ q27] + P[index[p + 28] ^ q28];
    result[r] = W_PHASH * ph + W_DHASH * dh + W_AHASH * ah + W_CHASH * ch;
  }
  return result;
}
function topK(dist, rowCount, k = 5) {
  const best = [];
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
function confidence(best, runnerUp) {
  if (!runnerUp) return 1;
  const gap = runnerUp.distance - best.distance;
  const closeness = 1 - Math.min(1, best.distance / (MAX_DISTANCE * 0.25));
  const separation = Math.min(1, gap / 24);
  return Math.max(0, Math.min(1, 0.35 * closeness + 0.65 * separation));
}

// src/recognize/carddetect.ts
var WORK_WIDTH = 320;
var MIN_RATIO = 0.5;
var MAX_RATIO = 1;
var MIN_AREA_FRACTION = 0.06;
function toGray(img, dw, dh) {
  const { data, width: sw, height: sh } = img;
  const out = new Float64Array(dw * dh);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy = Math.min(sh - 1, dy * yr | 0);
    for (let dx = 0; dx < dw; dx++) {
      const sx = Math.min(sw - 1, dx * xr | 0);
      const p = (sy * sw + sx) * 4;
      out[dy * dw + dx] = (data[p] * 299 + data[p + 1] * 587 + data[p + 2] * 114) / 1e3;
    }
  }
  return out;
}
function blur(src, w, h) {
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
function sobel(src, w, h) {
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
function otsu(values) {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (max <= 0) return 0;
  const bins = new Float64Array(256);
  for (let i = 0; i < values.length; i++) bins[Math.min(255, values[i] / max * 255 | 0)]++;
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
  return best / 255 * max;
}
function dilate(mask, w, h) {
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
function floodBackground(edge, w, h) {
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (i) => {
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
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = i / w | 0;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (y > 0) push(i - w);
    if (y < h - 1) push(i + w);
  }
  return bg;
}
var MAX_CANDIDATES = 6;
function candidateBlobs(mask, w, h) {
  const label = new Int32Array(w * h).fill(-1);
  const stack = [];
  const comps = [];
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
      const i = stack.pop();
      count++;
      const x = i % w;
      const y = i / w | 0;
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
  comps.sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0));
  const keep = comps.slice(0, MAX_CANDIDATES);
  return keep.map((c) => {
    const outline = [];
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
function cardScore(quad, w, h) {
  const side = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const width = (side(quad[0], quad[1]) + side(quad[2], quad[3])) / 2;
  const height = (side(quad[1], quad[2]) + side(quad[3], quad[0])) / 2;
  if (width <= 0 || height <= 0) return 0;
  const CARD_RATIO = 0.714;
  const aspect = 1 - Math.min(1, Math.abs(width / height - CARD_RATIO) / 0.32);
  const area = polygonArea(quad);
  const frac = area / (w * h);
  const size = frac >= 0.75 ? Math.max(0, 1 - (frac - 0.75) * 3) : Math.min(1, frac / 0.35);
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const off = Math.hypot(cx - w / 2, cy - h / 2) / Math.hypot(w / 2, h / 2);
  const centred = 1 - Math.min(1, off);
  const rect = Math.min(1, width * height / Math.max(1e-6, area));
  return 0.55 * aspect + 0.2 * size + 0.15 * centred + 0.1 * Math.min(1, rect);
}
var cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
function convexHull(points) {
  if (points.length < 4) return points.slice();
  const pts = points.slice().sort((a, b) => a.x === b.x ? a.y - b.y : a.x - b.x);
  const lower = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
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
function perimeter(poly) {
  let p = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    p += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return p;
}
function polygonArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p.x * q.y - q.x * p.y;
  }
  return Math.abs(a) / 2;
}
function simplify(poly, epsilon) {
  if (poly.length <= 4) return poly.slice();
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
function dp(line, epsilon) {
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
function toQuad(hull) {
  if (hull.length < 4) return null;
  if (hull.length === 4) return hull;
  const peri = perimeter(hull);
  let lo = 1e-3;
  let hi = 0.25;
  let fallback = null;
  for (let iter = 0; iter < 24; iter++) {
    const eps = (lo + hi) / 2 * peri;
    const s = simplify(hull, eps);
    if (s.length === 4) return s;
    if (s.length > 4) {
      lo = (lo + hi) / 2;
      if (s.length <= 6) fallback = s;
    } else {
      hi = (lo + hi) / 2;
    }
  }
  return fallback ? extremeQuad(fallback) : extremeQuad(hull);
}
function extremeQuad(poly) {
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
function orderCorners(quad) {
  const cx = quad.reduce((s, p) => s + p.x, 0) / 4;
  const cy = quad.reduce((s, p) => s + p.y, 0) / 4;
  const byAngle = quad.slice().sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
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
    byAngle[(start + 3) % 4]
  ];
}
function isConvex(q) {
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
function plausibleCard(q, w, h) {
  if (!isConvex(q)) return false;
  const area = polygonArea(q);
  if (area < w * h * MIN_AREA_FRACTION) return false;
  const side = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const top = side(q[0], q[1]);
  const right = side(q[1], q[2]);
  const bottom = side(q[2], q[3]);
  const left = side(q[3], q[0]);
  if (Math.min(top, right, bottom, left) < 12) return false;
  if (Math.min(top, bottom) / Math.max(top, bottom) < 0.6) return false;
  if (Math.min(left, right) / Math.max(left, right) < 0.6) return false;
  const width = (top + bottom) / 2;
  const height = (left + right) / 2;
  const ratio = width / height;
  return ratio >= MIN_RATIO && ratio <= MAX_RATIO;
}
function detectCard(img, debug) {
  const dw = Math.min(WORK_WIDTH, img.width);
  const dh = Math.max(1, Math.round(img.height / img.width * dw));
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
  const bg = floodBackground(edge, dw, dh);
  const enclosed = new Uint8Array(dw * dh);
  let enclosedCount = 0;
  for (let i = 0; i < enclosed.length; i++) {
    if (!bg[i]) {
      enclosed[i] = 1;
      enclosedCount++;
    }
  }
  const blobs = [];
  if (enclosedCount > 40 && enclosedCount < dw * dh * 0.98) {
    blobs.push(...candidateBlobs(enclosed, dw, dh));
  }
  blobs.push(...candidateBlobs(edge, dw, dh));
  if (!blobs.length) {
    if (debug) debug.stage = "no-blob";
    return null;
  }
  if (debug) debug.blobSize = blobs[0].count;
  let chosen = null;
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
      const side = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
      debug.ratio = (side(quad[0], quad[1]) + side(quad[2], quad[3])) / (side(quad[1], quad[2]) + side(quad[3], quad[0]));
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
    if (debug) debug.stage = sawQuad ? "implausible" : "no-quad";
    return null;
  }
  if (debug) {
    debug.stage = "ok";
    debug.quad = chosen;
  }
  const scaled = chosen.map((p) => ({ x: p.x * scaleX, y: p.y * scaleY }));
  return { quad: scaled, areaFraction: polygonArea(chosen) / (dw * dh) };
}
function guideQuad(w, h, fill = 0.92) {
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
    { x: x0, y: y0 + gh }
  ];
}
function intersect(a, b) {
  const det = a.dx * -b.dy - a.dy * -b.dx;
  if (Math.abs(det) < 1e-9) return null;
  const rx = b.px - a.px;
  const ry = b.py - a.py;
  const t = (rx * -b.dy - ry * -b.dx) / det;
  return { x: a.px + a.dx * t, y: a.py + a.dy * t };
}
function refineQuad(img, quad, searchFrac = 0.12) {
  const dw = Math.min(WORK_WIDTH, img.width);
  const dh = Math.max(1, Math.round(img.height / img.width * dw));
  const sx = dw / img.width;
  const sy = dh / img.height;
  const grad = sobel(blur(toGray(img, dw, dh), dw, dh), dw, dh);
  const at = (x, y) => {
    const xi = x | 0;
    const yi = y | 0;
    if (xi < 0 || yi < 0 || xi >= dw || yi >= dh) return 0;
    return grad[yi * dw + xi];
  };
  const small = quad.map((p) => ({ x: p.x * sx, y: p.y * sy }));
  const lines = [];
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
    const hits = [];
    const SAMPLES = 24;
    for (let i = 0; i < SAMPLES; i++) {
      const t = 0.12 + 0.76 * i / (SAMPLES - 1);
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
    const offs = hits.map((p) => p.off).sort((p, q) => p - q);
    const medOff = offs[offs.length >> 1];
    const spread = Math.max(2, reach * 0.35);
    const kept = hits.filter((p) => Math.abs(p.off - medOff) <= spread);
    if (kept.length < 6) {
      lines.push(null);
      continue;
    }
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
      const u = (p.x - mx) * dx + (p.y - my) * dy;
      const v = (p.x - mx) * nx + (p.y - my) * ny;
      num += u * v;
      den += u * u;
    }
    const slope = den > 1e-6 ? num / den : 0;
    const fdx = dx + nx * slope;
    const fdy = dy + ny * slope;
    const flen = Math.hypot(fdx, fdy) || 1;
    lines.push({ px: mx, py: my, dx: fdx / flen, dy: fdy / flen });
  }
  const out = [];
  for (let c = 0; c < 4; c++) {
    const prev = lines[(c + 3) % 4];
    const cur = lines[c];
    const fallback = small[c];
    const p = prev && cur ? intersect(prev, cur) : null;
    const ok = p && Math.hypot(p.x - fallback.x, p.y - fallback.y) < Math.max(dw, dh) * 0.25;
    out.push(ok ? p : fallback);
  }
  return out.map((p) => ({ x: p.x / sx, y: p.y / sy }));
}
function solvePerspective(src, dst) {
  const a = [];
  const b = [];
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
function rectify(img, quad, dw = CARD_W, dh = CARD_H) {
  const c = solvePerspective(
    [
      { x: 0, y: 0 },
      { x: dw, y: 0 },
      { x: dw, y: dh },
      { x: 0, y: dh }
    ],
    quad
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
        out[p + ch] = v00 * (1 - fx) * (1 - fy) + v10 * fx * (1 - fy) + v01 * (1 - fx) * fy + v11 * fx * fy;
      }
      out[p + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}

// src/recognize/resize.ts
function resizeRgba(src, dw, dh) {
  const { data, width: sw, height: sh } = src;
  const out = new Uint8ClampedArray(dw * dh * 4);
  const xr = sw / dw;
  const yr = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const y0 = dy * yr;
    const y1 = y0 + yr;
    const fy = Math.floor(y0);
    const ly = Math.min(sh - 1, Math.ceil(y1) - 1);
    for (let dx = 0; dx < dw; dx++) {
      const x0 = dx * xr;
      const x1 = x0 + xr;
      const fx = Math.floor(x0);
      const lx = Math.min(sw - 1, Math.ceil(x1) - 1);
      let r = 0;
      let g = 0;
      let b = 0;
      let wsum = 0;
      for (let y = fy; y <= ly; y++) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = fx; x <= lx; x++) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wy * wx;
          const p2 = (y * sw + x) * 4;
          r += data[p2] * w;
          g += data[p2 + 1] * w;
          b += data[p2 + 2] * w;
          wsum += w;
        }
      }
      const p = (dy * dw + dx) * 4;
      out[p] = wsum > 0 ? r / wsum : 0;
      out[p + 1] = wsum > 0 ? g / wsum : 0;
      out[p + 2] = wsum > 0 ? b / wsum : 0;
      out[p + 3] = 255;
    }
  }
  return { data: out, width: dw, height: dh };
}
function toCardRect(src) {
  if (src.width === CARD_W && src.height === CARD_H) return src;
  return resizeRgba(src, CARD_W, CARD_H);
}

// src/recognize/cardindex.ts
var MANIFEST_FILE = "manifest.json";
function indexVersion(manifest, game) {
  const g = manifest?.games?.[game];
  return g ? `${g.builtAt}-${g.count}` : "";
}
function indexUrl(game, ext, version, base = "/cardindex") {
  return `${base}/${game}.${ext}${version ? `?v=${encodeURIComponent(version)}` : ""}`;
}

// src/catalog/catalogues.ts
var INDEX_GAMES = [
  "pokemon",
  "pokemon-japan",
  "onepiece",
  "dragonball",
  // Dragon Ball Super CCG (2017+, Masters era)
  "dragonball-fusion",
  // Fusion World (current)
  "dragonball-z",
  // Panini DBZ TCG (2014–17)
  "magic",
  "yugioh",
  "lorcana"
];
var CATEGORY_ID = {
  pokemon: 3,
  "pokemon-japan": 85,
  onepiece: 68,
  dragonball: 27,
  "dragonball-fusion": 80,
  "dragonball-z": 23,
  magic: 1,
  yugioh: 2,
  lorcana: 71
};
var FAMILY = {
  3: "pokemon",
  85: "pokemon",
  68: "onepiece",
  27: "dragonball",
  80: "dragonball-fusion",
  23: "dragonball-z",
  1: "magic",
  2: "yugioh",
  71: "lorcana"
};
var OFF_LANGUAGE_PENALTY = 8;
function languagePrior(categoryId, preferCategory) {
  return categoryId !== preferCategory && FAMILY[categoryId] === FAMILY[preferCategory] ? OFF_LANGUAGE_PENALTY : 0;
}

// src/recognize/scanner.ts
var GUIDE_FILL = 0.92;
var decoder = new TextDecoder();
function asText(payload) {
  if (typeof payload === "string") return payload;
  return decoder.decode(payload);
}
function asBytes(payload) {
  if (typeof payload === "string") {
    throw new Error("expected binary index data, got a string");
  }
  if (ArrayBuffer.isView(payload)) {
    const v = payload;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  return new Uint8Array(payload);
}
async function loadManifest(load) {
  try {
    return JSON.parse(asText(await load(MANIFEST_FILE)));
  } catch {
    return null;
  }
}
async function loadGame(load, game, version) {
  const suffix = version ? `?v=${encodeURIComponent(version)}` : "";
  try {
    const [metaRaw, binRaw] = await Promise.all([
      load(`${game}.json${suffix}`),
      load(`${game}.bin${suffix}`)
    ]);
    const meta = JSON.parse(asText(metaRaw));
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
async function createScanner(opts) {
  const games = opts.games ?? INDEX_GAMES;
  const manifest = games.length ? await loadManifest(opts.load) : null;
  const results = await Promise.all(
    games.map(async (g) => ({ game: g, part: await loadGame(opts.load, g, indexVersion(manifest, g)) }))
  );
  const loaded = results.map((r) => r.part).filter((x) => !!x);
  if (!loaded.length && games.length) throw new Error("no card index could be loaded");
  const missing = results.filter((r) => !r.part).map((r) => r.game);
  if (missing.length) {
    throw new Error(
      `card index incomplete \u2014 ${missing.join(", ")} failed to load. Retry before scanning (matching now would identify cards from the wrong catalogue).`
    );
  }
  const total = loaded.reduce((n, l) => n + l.meta.count, 0);
  const merged = new Uint8Array(total * HASH_BYTES);
  const cards = [];
  const gameOf = new Array(total);
  const setOf = new Array(total);
  const prior = new Float64Array(total);
  const preferCategory = opts.preferGame ? CATEGORY_ID[opts.preferGame] : 0;
  let row = 0;
  for (const l of loaded) {
    merged.set(l.bin.subarray(0, l.meta.count * HASH_BYTES), row * HASH_BYTES);
    for (const c of l.meta.cards) {
      cards.push(c);
      gameOf[row] = l.game;
      setOf[row] = l.meta.groups?.[String(c[1])] ?? "";
      prior[row] = preferCategory ? languagePrior(l.meta.categoryId, preferCategory) : 0;
      row++;
    }
  }
  const cat = {
    count: total,
    cards,
    gameOf,
    setOf,
    index: merged,
    prior,
    hasPrior: !!preferCategory,
    games: loaded.map((l) => l.game)
  };
  const scratch = [0, 1, 2].map(() => new Float64Array(total));
  const blended = new Float64Array(total);
  return makeScanner(cat, scratch, blended, manifest);
}
function makeScanner(cat, scratch, blended, manifest) {
  const toMatch = (c, next) => {
    const [productId, groupId, name, number] = cat.cards[c.row];
    return {
      productId,
      groupId,
      game: cat.gameOf[c.row],
      name,
      number,
      set: cat.setOf[c.row],
      distance: c.distance,
      confidence: confidence(c, next)
    };
  };
  const rank = (dist, k) => {
    if (!cat.count) return [];
    const best = topK(dist, cat.count, Math.max(1, k) + 1);
    return best.slice(0, Math.max(1, k)).map((c, i) => toMatch(c, best[i + 1]));
  };
  const fingerprint = (rgba, width, height) => hashCard(toCardRect({ data: rgba, width, height }));
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
      const img = { data: rgba, width, height };
      const guide = guideQuad(width, height, GUIDE_FILL);
      const det = detectCard(img);
      const quads = [guide, refineQuad(img, guide)];
      if (det) quads.push(det.quad);
      const weights = [];
      let totalWeight = 0;
      for (let k = 0; k < quads.length; k++) {
        const d = distances(hashCard(rectify(img, quads[k])), cat.index, cat.count, scratch[k]);
        const t2 = topK(d, cat.count, 2);
        const w = confidence(t2[0], t2[1]);
        weights.push(w);
        totalWeight += w;
      }
      if (totalWeight < 0.01) {
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
        quad: det ? det.quad.map((p) => ({ x: p.x, y: p.y })) : void 0,
        matches: rank(blended, opts?.k ?? 5)
      };
    }
  };
}

exports.AHASH_BYTES = AHASH_BYTES;
exports.CARD_H = CARD_H;
exports.CARD_W = CARD_W;
exports.CHASH_BYTES = CHASH_BYTES;
exports.DHASH_BYTES = DHASH_BYTES;
exports.GUIDE_FILL = GUIDE_FILL;
exports.HASH_BYTES = HASH_BYTES;
exports.MANIFEST_FILE = MANIFEST_FILE;
exports.MAX_DISTANCE = MAX_DISTANCE;
exports.PHASH_BYTES = PHASH_BYTES;
exports.confidence = confidence;
exports.createScanner = createScanner;
exports.detectCard = detectCard;
exports.distances = distances;
exports.guideQuad = guideQuad;
exports.hashCard = hashCard;
exports.indexUrl = indexUrl;
exports.indexVersion = indexVersion;
exports.orderCorners = orderCorners;
exports.polygonArea = polygonArea;
exports.rectify = rectify;
exports.refineQuad = refineQuad;
exports.resizeRgba = resizeRgba;
exports.toCardRect = toCardRect;
exports.topK = topK;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map