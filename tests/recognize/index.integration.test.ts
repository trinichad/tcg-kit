// End-to-end proof that the SHIPPED index and the EXTRACTED hasher agree.
//
// The index in data/cardindex/ was fingerprinted by BinderPricer, months ago,
// by code that now lives in src/recognize/. If anything about the resize, the
// DCT, the bit packing or the byte layout shifted during the extraction, every
// one of those 227,210 fingerprints is garbage — and nothing else in the test
// suite would notice, because the hasher would still be self-consistent.
//
// So: take real productIds out of the shipped pokemon index, fetch the exact
// catalog images TCGplayer serves for them, push them through the kit's own
// scanner (load from disk → resize → hash → distances → topK → confidence),
// and require that each one comes back as itself, comfortably.
//
// Network test. It SKIPS rather than fails when tcgplayer-cdn is unreachable —
// a flaky café connection must not read as a broken hasher. Run it when
// changing anything under src/recognize/.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { CARD_H, CARD_W, HASH_BYTES, createScanner, type Scanner } from '../../src/recognize';
import type { GameIndexMeta } from '../../src/recognize';

const INDEX_DIR = join(import.meta.dirname, '..', '..', 'data', 'cardindex');

/** tcgcsv and the TCGplayer CDN want a User-Agent that says who is calling. */
const UA = 'HoloTcgKit/0.1 (+https://holohuntingtcg.com)';

/**
 * BinderPricer's lock gate (src/scan/useScanner.ts MIN_CONFIDENCE). Chosen for
 * precision: 100% correct locks at 0.14 across clean, cluttered and slabbed
 * captures; 0.10 starts naming the wrong card. A catalog image matched against
 * its own fingerprint should clear it by a mile.
 */
const MIN_CONFIDENCE = 0.14;

/** How many cards to check. Each one is a CDN fetch. */
const SAMPLE = 3;

const meta = JSON.parse(readFileSync(join(INDEX_DIR, 'pokemon.json'), 'utf8')) as GameIndexMeta;

/**
 * Sample from the MIDDLE of `cards`. The ends are the oldest and newest
 * productIds — Base Set and whatever released last — and both are unusual:
 * vintage art is low-contrast and the newest set is the one most likely to
 * still carry placeholder images.
 */
const mid = Math.floor(meta.cards.length / 2);
const sample = meta.cards.slice(mid, mid + SAMPLE);

/** A filesystem `load` for createScanner: strip the `?v=` cache-buster the
 *  scanner appends for browsers, then read the file. */
const load = async (file: string): Promise<ArrayBuffer | string> => {
  const name = file.split('?')[0];
  const buf = readFileSync(join(INDEX_DIR, name));
  if (name.endsWith('.json')) return buf.toString('utf8');
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

async function fetchCardImage(productId: number): Promise<Buffer | null> {
  try {
    const r = await fetch(`https://tcgplayer-cdn.tcgplayer.com/product/${productId}_200w.jpg`, {
      headers: { 'user-agent': UA, accept: 'image/jpeg,image/*' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return Buffer.from(await r.arrayBuffer());
  } catch {
    return null;
  }
}

describe('shipped index ↔ extracted hasher', () => {
  let scanner: Scanner;
  let online = true;

  beforeAll(async () => {
    scanner = await createScanner({ load, games: ['pokemon'] });
    // One probe decides online/offline for the whole suite, so a dead network
    // costs one timeout rather than SAMPLE of them.
    online = (await fetchCardImage(sample[0][0])) !== null;
    if (!online) {
      console.warn('[skip] tcgplayer-cdn.tcgplayer.com unreachable — network assertions skipped');
    }
  }, 60_000);

  it('loads the pokemon catalogue as the manifest describes it', () => {
    expect(scanner.games()).toEqual(['pokemon']);
    expect(scanner.count).toBe(meta.count);
    expect(scanner.manifest?.games.pokemon?.count).toBe(meta.count);
    // The .bin is exactly count × 29 bytes, or a row is reading past its card.
    const bin = readFileSync(join(INDEX_DIR, 'pokemon.bin'));
    expect(bin.length).toBe(meta.count * HASH_BYTES);
    expect(meta.hashBytes).toBe(HASH_BYTES);
    expect(meta.cardW).toBe(CARD_W);
    expect(meta.cardH).toBe(CARD_H);
  });

  for (const [productId, groupId, name, number] of sample) {
    it(`identifies ${name} (${number}, product ${productId})`, async () => {
      const bytes = await fetchCardImage(productId);
      if (!bytes) {
        expect(online, 'image fetch failed while the network was up').toBe(false);
        return;
      }
      const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
      const matches = await scanner.matchCard(raw.data, raw.width, raw.height, { k: 5 });

      expect(matches.length).toBeGreaterThan(0);
      const top = matches[0];
      expect(
        top.productId,
        `top match was ${top.name} (${top.productId}) at distance ${top.distance}`,
      ).toBe(productId);
      expect(top.groupId).toBe(groupId);
      expect(top.game).toBe('pokemon');
      expect(top.name).toBe(name);
      expect(top.number).toBe(number);
      expect(top.set).toBe(meta.groups[String(groupId)]);
      // The catalog image IS what was fingerprinted, so the round trip should
      // be exact — any non-zero distance means the hasher has drifted.
      expect(top.distance).toBe(0);
      expect(top.confidence).toBeGreaterThan(MIN_CONFIDENCE);
    }, 60_000);
  }

  it('matchFrame finds the card in a full frame and identifies it', async () => {
    // The whole reason rectification exists: hashing a raw camera frame
    // identifies ~11% of cards, hashing the same frame after detect+rectify
    // identifies ~97%. This exercises that path — detect the outline, warp it
    // flat, hash, rank — rather than matchCard's already-cropped shortcut.
    const [productId] = sample[0];
    const bytes = await fetchCardImage(productId);
    if (!bytes) {
      expect(online).toBe(false);
      return;
    }
    const card = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });

    // Paste the card onto flat grey, the way one sits in a viewfinder.
    const FW = 320;
    const FH = 440;
    const frame = new Uint8ClampedArray(FW * FH * 4);
    for (let i = 0; i < FW * FH; i++) {
      frame[i * 4] = 120;
      frame[i * 4 + 1] = 122;
      frame[i * 4 + 2] = 125;
      frame[i * 4 + 3] = 255;
    }
    const ox = Math.floor((FW - card.width) / 2);
    const oy = Math.floor((FH - card.height) / 2);
    for (let y = 0; y < card.height; y++) {
      for (let x = 0; x < card.width; x++) {
        const sp = (y * card.width + x) * 4;
        const dp = ((oy + y) * FW + ox + x) * 4;
        frame[dp] = card.data[sp];
        frame[dp + 1] = card.data[sp + 1];
        frame[dp + 2] = card.data[sp + 2];
        frame[dp + 3] = 255;
      }
    }

    const res = await scanner.matchFrame(frame, FW, FH, { k: 3 });
    expect(res.detected).toBe(true);
    expect(res.quad).toHaveLength(4);
    // The outline should land on the pasted rectangle, not the artwork box.
    const [tl, , br] = res.quad!;
    expect(Math.abs(tl.x - ox)).toBeLessThan(12);
    expect(Math.abs(tl.y - oy)).toBeLessThan(12);
    expect(Math.abs(br.x - (ox + card.width))).toBeLessThan(12);
    expect(Math.abs(br.y - (oy + card.height))).toBeLessThan(12);

    expect(res.matches[0].productId).toBe(productId);
    expect(res.matches[0].confidence).toBeGreaterThan(MIN_CONFIDENCE);
  }, 60_000);

  it('hash() returns the 29 bytes the index stores for that card', async () => {
    const [productId] = sample[0];
    const bytes = await fetchCardImage(productId);
    if (!bytes) {
      expect(online).toBe(false);
      return;
    }
    const raw = jpeg.decode(bytes, { useTArray: true, formatAsRGBA: true });
    const got = scanner.hash(raw.data, raw.width, raw.height);
    expect(got.length).toBe(HASH_BYTES);

    const row = meta.cards.findIndex((c) => c[0] === productId);
    const bin = readFileSync(join(INDEX_DIR, 'pokemon.bin'));
    const stored = bin.subarray(row * HASH_BYTES, (row + 1) * HASH_BYTES);
    expect(Buffer.from(got).toString('hex')).toBe(stored.toString('hex'));
  }, 60_000);
});
