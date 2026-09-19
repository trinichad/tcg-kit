import { describe, expect, it } from 'vitest';
import { createPricing } from '../../src/pricing/index';

// productById must be one tcgcsv products call (+ the cached group list and
// prices for printings) — never a search — and null when the id is not in
// the group.
const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function fakeFetch(calls: string[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith('/3/groups')) return json({ results: [{ groupId: 604, name: 'Base Set', abbreviation: 'BS', categoryId: 3 }] });
    if (url.endsWith('/3/604/products'))
      return json({
        results: [
          {
            productId: 42382, name: 'Charizard', cleanName: 'Charizard', groupId: 604, categoryId: 3,
            imageUrl: 'https://tcgplayer-cdn.tcgplayer.com/product/42382_200w.jpg', url: 'https://www.tcgplayer.com/product/42382',
            extendedData: [{ name: 'Number', value: '004/102' }, { name: 'Rarity', value: 'Holo Rare' }],
          },
        ],
      });
    if (url.endsWith('/3/604/prices'))
      return json({ results: [{ productId: 42382, subTypeName: 'Holofoil', marketPrice: 840.5, lowPrice: 500, midPrice: 800, highPrice: 2000 }] });
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

describe('productById', () => {
  it('builds a full match from the group listing without searching', async () => {
    const calls: string[] = [];
    const p = createPricing({ fetch: fakeFetch(calls) });
    const m = await p.productById(42382, 3, 604);
    expect(m).not.toBeNull();
    expect(m!.name).toBe('Charizard');
    expect(m!.groupName).toBe('Base Set');
    expect(m!.number).toBe('004/102');
    expect(m!.rarity).toBe('Holo Rare');
    expect(m!.subTypes).toEqual([{ name: 'Holofoil', marketPrice: 840.5 }]);
    expect(calls.some((u) => /search|tcgplayer\.com\/.*search/i.test(u) && !u.includes('tcgcsv'))).toBe(false);
  });

  it('is null when the product is not in that group', async () => {
    const p = createPricing({ fetch: fakeFetch([]) });
    expect(await p.productById(99999, 3, 604)).toBeNull();
  });
});
