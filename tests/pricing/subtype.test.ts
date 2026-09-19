import { describe, expect, it } from 'vitest';
import { currentEdition, editionKey, mergedEditions, pickSubType } from '../../src/pricing/index';
import type { ProductMatch, SubTypePrice } from '../../src/pricing/index';

const subs = (...names: string[]): SubTypePrice[] =>
  names.map((name) => ({ name, marketPrice: 1 }));

const MODERN = subs('Normal', 'Holofoil', 'Reverse Holofoil');
const WOTC = subs('1st Edition Holofoil', 'Unlimited Holofoil', '1st Edition', 'Unlimited');

describe('pickSubType', () => {
  it('falls back to "Market" with no printings at all', () => {
    expect(pickSubType('holofoil', [])).toBe('Market');
  });

  it('picks the modern printings off the read', () => {
    expect(pickSubType('reverse holofoil', MODERN)).toBe('Reverse Holofoil');
    expect(pickSubType('holofoil', MODERN)).toBe('Holofoil');
    expect(pickSubType('normal', MODERN)).toBe('Normal');
  });

  it('never drifts into a 1st Edition printing unless the stamp was read', () => {
    // Often 10x the price — this is the guard that keeps a $4 Unlimited from
    // being priced as an $85 1st Edition.
    expect(pickSubType('holofoil', WOTC)).toBe('Unlimited Holofoil');
    expect(pickSubType('reverse', WOTC)).toBe('Unlimited Holofoil');
    expect(pickSubType('', WOTC)).toBe('Unlimited Holofoil');
  });

  it('honours an explicit 1st Edition read, holo and non-holo', () => {
    expect(pickSubType('1st edition holofoil', WOTC)).toBe('1st Edition Holofoil');
    expect(pickSubType('1st edition', WOTC)).toBe('1st Edition');
  });

  it('handles etched and plain foil reads', () => {
    expect(pickSubType('etched foil', subs('Normal', 'Foil Etched'))).toBe('Foil Etched');
    expect(pickSubType('foil', subs('Non Foil', 'Foil'))).toBe('Foil');
  });

  it('prefers a printing that actually has a market price', () => {
    const mixed: SubTypePrice[] = [
      { name: '1st Edition', marketPrice: 40 },
      { name: 'Unlimited', marketPrice: null },
      { name: 'Reverse Holofoil', marketPrice: 3 },
    ];
    expect(pickSubType('', mixed)).toBe('Reverse Holofoil');
  });
});

const product = (p: Partial<ProductMatch>): ProductMatch => ({
  productId: 1,
  name: 'Charizard',
  categoryId: 3,
  groupId: 1,
  groupName: 'Base Set',
  number: '4/102',
  rarity: 'Holo Rare',
  imageUrl: '',
  url: '',
  subTypes: [],
  score: 1,
  ...p,
});

describe('mergedEditions', () => {
  const shadow = product({
    productId: 2,
    groupId: 2,
    groupName: 'Base Set (Shadowless)',
    subTypes: [
      { name: '1st Edition Holofoil', marketPrice: 8000 },
      { name: 'Unlimited Holofoil', marketPrice: 900 },
    ],
  });
  const plain = product({
    productId: 1,
    groupName: 'Base Set',
    subTypes: [{ name: 'Holofoil', marketPrice: 350 }],
  });

  it('is null when there is no shadowless sibling', () => {
    expect(mergedEditions(plain, [])).toBeNull();
    expect(mergedEditions(undefined, [shadow])).toBeNull();
  });

  it('merges the two products into one 1st Ed / Shadowless / Unlimited picker', () => {
    const merged = mergedEditions(shadow, [plain]);
    expect(merged?.map((m) => [m.label, m.subType, m.price])).toEqual([
      ['1st Edition', '1st Edition Holofoil', 8000],
      ['Shadowless', 'Unlimited Holofoil', 900],
      ['Unlimited', 'Holofoil', 350],
    ]);
  });

  it('keys options by product + printing, and resolves the current one', () => {
    const merged = mergedEditions(shadow, [plain])!;
    expect(editionKey(merged[0])).toBe('2::1st Edition Holofoil');
    expect(currentEdition(merged, plain, 'Holofoil').label).toBe('Unlimited');
    // Same product, printing not settled yet → that product's first option,
    // never a default that would show a 1st Edition price for an Unlimited.
    expect(currentEdition(merged, shadow, undefined).label).toBe('1st Edition');
  });
});
