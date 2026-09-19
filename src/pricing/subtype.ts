// Origin: `pickSubType` from BinderPricer src/pipeline.ts and `mergedEditions`
// (+ editionKey / currentEdition) from BinderPricer src/editions.ts @ e995c9e —
// pure helpers that were stranded in the React app.
// Changed: nothing but the file they live in.

import type { ProductMatch, SubTypePrice } from './types';

/**
 * Which TCGplayer printing a read corresponds to.
 *
 * Vintage sets list "1st Edition Holofoil" alongside "Unlimited Holofoil".
 * Never drift into a 1st Edition subtype (often 10x the price) unless the
 * scan actually saw the stamp.
 */
export function pickSubType(printing: string, subTypes: SubTypePrice[]): string {
  if (!subTypes.length) return 'Market';
  const names = subTypes.map((s) => s.name);
  const lower = (s: string) => s.toLowerCase();
  const p = lower(printing);
  const find = (pred: (n: string) => boolean) => names.find((n) => pred(lower(n)));
  const no1st = (n: string) => !n.includes('1st');
  let pick: string | undefined;
  if (p.includes('reverse'))
    pick = find((n) => n.includes('reverse') && no1st(n)) ?? find((n) => n.includes('reverse'));
  else if (p.includes('1st')) {
    pick =
      (p.includes('holo')
        ? find((n) => n.includes('1st') && n.includes('holo'))
        : find((n) => n.includes('1st') && !n.includes('holo'))) ?? find((n) => n.includes('1st'));
  } else if (p.includes('holo')) {
    pick =
      find((n) => n === 'holofoil') ??
      find((n) => n.includes('holofoil') && !n.includes('reverse') && no1st(n));
  } else if (p.includes('etched')) pick = find((n) => n.includes('etched'));
  else if (p.includes('foil'))
    pick = find((n) => n.includes('foil') && !n.includes('non') && no1st(n));
  else if (p) {
    pick =
      find((n) => n === 'normal') ?? find((n) => n === 'unlimited') ?? find((n) => n.includes('non foil'));
  }
  if (!pick) {
    pick =
      names.find((n) => no1st(lower(n)) && subTypes.find((s) => s.name === n)?.marketPrice != null) ??
      names.find((n) => subTypes.find((s) => s.name === n)?.marketPrice != null) ??
      names[0];
  }
  return pick;
}

export interface MergedEdition {
  label: string;
  product: ProductMatch;
  subType: string;
  price: number | null;
}

/**
 * WOTC Base Set variants live in TWO TCGplayer products: "X (Shadowless)" —
 * which carries the "1st Edition" and shadowless printings — and plain "X",
 * the shadowed Unlimited. Merge them into one 1st Edition / Shadowless /
 * Unlimited picker, drawn from the matched product plus its sibling among the
 * candidates. Returns null for cards that don't have this split.
 *
 * (Which printing of a card is in your hand — the difference between $10 and
 * $400 on a WOTC-era Pokémon card.)
 */
export function mergedEditions(
  match: ProductMatch | undefined,
  candidates: ProductMatch[],
): MergedEdition[] | null {
  if (!match) return null;
  const all = [match, ...candidates];
  const shadow = all.find((p) => /\(shadowless\)/i.test(p.groupName));
  if (!shadow) return null;
  const baseName = shadow.groupName.replace(/\s*\(shadowless\)/i, '').trim().toLowerCase();
  const plain = all.find((p) => p.groupName.trim().toLowerCase() === baseName);
  const first = shadow.subTypes.find((s) => /1st/i.test(s.name));
  const shadowUnl = shadow.subTypes.find((s) => !/1st/i.test(s.name));
  const out: MergedEdition[] = [];
  if (first)
    out.push({ label: '1st Edition', product: shadow, subType: first.name, price: first.marketPrice });
  if (shadowUnl)
    out.push({
      label: 'Shadowless',
      product: shadow,
      subType: shadowUnl.name,
      price: shadowUnl.marketPrice,
    });
  const plainSub = plain?.subTypes[0];
  if (plain && plainSub)
    out.push({ label: 'Unlimited', product: plain, subType: plainSub.name, price: plainSub.marketPrice });
  return out.length >= 2 ? out : null;
}

/** Identity of one merged option, stable across re-renders. */
export const editionKey = (o: MergedEdition): string => `${o.product.productId}::${o.subType}`;

/** The option currently in effect for a slot, or the first as a fallback. */
export function currentEdition(
  merged: MergedEdition[],
  match: ProductMatch | undefined,
  /** A freshly scanned slot has no subType yet — fall back to the first. */
  subType: string | undefined,
): MergedEdition {
  return (
    merged.find((o) => o.product.productId === match?.productId && o.subType === subType) ??
    // Same product, subType not settled yet (a scan mid-pricing): still far
    // better than defaulting to 1st Edition and showing an Unlimited price
    // next to it — a highlight that lies is worse than no highlight.
    merged.find((o) => o.product.productId === match?.productId) ??
    merged[0]
  );
}
