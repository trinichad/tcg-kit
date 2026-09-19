// The fingerprint primitives, with no network and no index.
//
// `hashCard` is the one function in this repo that is not allowed to change:
// every byte in data/cardindex/*.bin was produced by it, and a scanner whose
// hasher has drifted matches nothing. These tests pin the shape and the
// determinism; index.integration.test.ts pins the actual bytes, by matching
// real catalog images against the shipped index.

import { describe, expect, it } from 'vitest';
import {
  CARD_H,
  CARD_W,
  HASH_BYTES,
  MAX_DISTANCE,
  confidence,
  distances,
  hashCard,
  topK,
  toCardRect,
  type Rgba,
} from '../../src/recognize';

/** A deterministic, non-uniform RGBA image — a diagonal gradient with a bright
 *  block offset by `seed`, so different seeds give genuinely different cards. */
function gradient(width: number, height: number, seed = 0): Rgba {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      data[p] = (x * 255) / width;
      data[p + 1] = (y * 255) / height;
      data[p + 2] = ((x + y + seed * 37) % 256);
      data[p + 3] = 255;
      // A bright square inside the art box (0.08–0.92 x, 0.10–0.52 y), which
      // is where the double-weighted art pHash actually looks.
      if (x > width * (0.2 + seed * 0.05) && x < width * 0.6 && y > height * 0.15 && y < height * 0.45) {
        data[p] = 250;
        data[p + 1] = 40;
        data[p + 2] = 200;
      }
    }
  }
  return { data, width, height };
}

describe('hashCard', () => {
  it('returns exactly HASH_BYTES (29) bytes', () => {
    const h = hashCard(gradient(CARD_W, CARD_H));
    expect(h).toBeInstanceOf(Uint8Array);
    expect(h.length).toBe(HASH_BYTES);
    expect(HASH_BYTES).toBe(29);
  });

  it('is deterministic — same pixels, same bytes', () => {
    const a = hashCard(gradient(CARD_W, CARD_H, 1));
    const b = hashCard(gradient(CARD_W, CARD_H, 1));
    expect([...a]).toEqual([...b]);
  });

  it('is not degenerate — a gradient does not hash to all zeros or all ones', () => {
    const h = hashCard(gradient(CARD_W, CARD_H, 2));
    expect([...h].some((b) => b !== 0)).toBe(true);
    expect([...h].some((b) => b !== 0xff)).toBe(true);
  });

  it('separates different images', () => {
    const a = hashCard(gradient(CARD_W, CARD_H, 0));
    const b = hashCard(gradient(CARD_W, CARD_H, 4));
    expect([...a]).not.toEqual([...b]);
  });

  it('hashes any size, via the canonical resize', () => {
    // A card cropped at some other resolution must land on the same rectangle
    // the index was built at, or its fingerprint is meaningless.
    const big = toCardRect(gradient(400, 560, 3));
    expect(big.width).toBe(CARD_W);
    expect(big.height).toBe(CARD_H);
    expect(hashCard(big).length).toBe(HASH_BYTES);
  });
});

describe('distances', () => {
  const rows = 4;
  const seeds = [0, 1, 2, 3];
  const index = new Uint8Array(rows * HASH_BYTES);
  seeds.forEach((s, i) => index.set(hashCard(gradient(CARD_W, CARD_H, s)), i * HASH_BYTES));

  it('is zero against an identical row and non-zero against the others', () => {
    const q = hashCard(gradient(CARD_W, CARD_H, 2));
    const d = distances(q, index, rows);
    expect(d[2]).toBe(0);
    expect(d[0]).toBeGreaterThan(0);
    expect(d[1]).toBeGreaterThan(0);
    expect(d[3]).toBeGreaterThan(0);
  });

  it('stays inside 0..MAX_DISTANCE', () => {
    const d = distances(hashCard(gradient(CARD_W, CARD_H, 0)), index, rows);
    for (const v of d) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(MAX_DISTANCE);
    }
    expect(MAX_DISTANCE).toBe(292);
  });

  it('writes into the buffer it is given, so a video frame allocates nothing', () => {
    const out = new Float64Array(rows);
    const d = distances(hashCard(gradient(CARD_W, CARD_H, 1)), index, rows, out);
    expect(d).toBe(out);
    expect(out[1]).toBe(0);
  });
});

describe('topK', () => {
  const dist = Float64Array.from([50, 5, 90, 12, 1, 33]);

  it('returns the k nearest rows, nearest first', () => {
    expect(topK(dist, dist.length, 3)).toEqual([
      { row: 4, distance: 1 },
      { row: 1, distance: 5 },
      { row: 3, distance: 12 },
    ]);
  });

  it('is sorted even when there are fewer rows than k', () => {
    const short = Float64Array.from([7, 2]);
    expect(topK(short, 2, 5).map((c) => c.row)).toEqual([1, 0]);
  });

  it('handles k = 1', () => {
    expect(topK(dist, dist.length, 1)).toEqual([{ row: 4, distance: 1 }]);
  });
});

describe('confidence', () => {
  it('is 1 when there is no runner-up', () => {
    expect(confidence({ row: 0, distance: 40 }, undefined)).toBe(1);
  });

  it('is ~0 for a tie — the case the twin picker exists for', () => {
    expect(confidence({ row: 0, distance: 80 }, { row: 1, distance: 80 })).toBeLessThan(0.05);
  });

  it('rises with the gap to the runner-up', () => {
    const near = confidence({ row: 0, distance: 30 }, { row: 1, distance: 34 });
    const far = confidence({ row: 0, distance: 30 }, { row: 1, distance: 90 });
    expect(far).toBeGreaterThan(near);
    expect(far).toBeLessThanOrEqual(1);
  });

  it('stays in 0..1 at both extremes', () => {
    expect(confidence({ row: 0, distance: 0 }, { row: 1, distance: MAX_DISTANCE })).toBe(1);
    expect(confidence({ row: 0, distance: MAX_DISTANCE }, { row: 1, distance: MAX_DISTANCE })).toBe(0);
  });
});
