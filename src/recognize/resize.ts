// Area-average RGBA resize — the step that turns "some image" into the
// canonical CARD_W x CARD_H rectangle everything is hashed at.
//
// Lifted VERBATIM out of BinderPricer's scripts/lib/cardindex.ts, where it was
// the index builder's private helper (`resizeRgba`). It lives here now because
// both sides of the match have to run the SAME resampler or the fingerprints
// disagree:
//
//   index side  — decode the TCGplayer catalog JPEG, resize here, hashCard()
//   query side  — Scanner.matchCard() on an already-cropped photo, resize
//                 here, hashCard()
//
// (The live camera path doesn't come through here: `rectify()` warps the quad
// straight to CARD_W x CARD_H, which is its own resampling.)
//
// Same contract as cardhash's `resizeChannel`: every output pixel is the mean
// of the input pixels its footprint covers, with fractional weights at the
// edges. Deterministic, platform-independent, no canvas/PIL/sharp — their
// resampling differs between platforms and would break the bit-for-bit
// agreement the whole index depends on.

import { CARD_H, CARD_W, type Rgba } from './cardhash';

/** Area-average RGBA resize (the hash module's resize, applied to 4 channels). */
export function resizeRgba(src: Rgba, dw: number, dh: number): Rgba {
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
          const p = (y * sw + x) * 4;
          r += data[p] * w;
          g += data[p + 1] * w;
          b += data[p + 2] * w;
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

/**
 * Resize an arbitrary RGBA image onto the canonical card rectangle.
 * Already-CARD_W x CARD_H input is returned untouched, so a caller that
 * rectified the frame itself pays nothing.
 */
export function toCardRect(src: Rgba): Rgba {
  if (src.width === CARD_W && src.height === CARD_H) return src;
  return resizeRgba(src, CARD_W, CARD_H);
}
