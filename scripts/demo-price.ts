#!/usr/bin/env tsx
// New: the smallest end-to-end demo of @holo/tcg-kit/pricing — one Pokémon
// card and one One Piece card, resolved and priced through `lookupPrice()`.
//
//   npx tsx scripts/demo-price.ts

import { createPricing, imageUrl, toCents } from '../src/pricing/index';
import type { ConditionCode, PricedCard, ResolveRequestCard } from '../src/pricing/index';

// scripts/ is the ONLY place in this package that reads process.env.
const pricing = createPricing({
  userAgent: process.env.TCG_KIT_USER_AGENT || undefined,
  tokens: { pricecharting: process.env.PRICECHARTING_API_TOKEN, psa: process.env.PSA_API_TOKEN },
});

const CONDITIONS: ConditionCode[] = ['NM', 'LP', 'MP', 'HP', 'DM'];
const usd = (n: number | null | undefined) => (n == null ? '   —   ' : `$${n.toFixed(2)}`.padStart(9));

function show(title: string, card: PricedCard): void {
  console.log(`\n══ ${title} ══`);
  if (!card.match) {
    console.log(`  no match — ${card.note ?? 'no reason given'}`);
    return;
  }
  const m = card.match;
  console.log(`  ${m.name}  #${m.number}  ·  ${m.groupName}${m.groupCode ? ` (${m.groupCode})` : ''}`);
  console.log(`  productId ${m.productId} · ${m.rarity || 'no rarity'} · match ${card.status} (score ${m.score})`);
  console.log(`  printing chosen: ${card.subType}`);
  console.log(`  printings available: ${m.subTypes.map((s) => s.name).join(', ') || '—'}`);
  console.log(`  image 200w: ${imageUrl(m.productId)}`);
  console.log(`  image 400w: ${imageUrl(m.productId, '400w')}`);
  console.log(`  url: ${m.url}`);
  console.log('  ladder:');
  for (const c of CONDITIONS) {
    const q = card.quotes[c];
    if (!q) continue;
    const bits = [
      `${c}  ${usd(q.price)}`,
      `${q.source.padEnd(10)}`,
      q.salesUsed ? `n=${q.salesUsed}` : '     ',
      q.asOf ? `as of ${q.asOf}` : '',
    ];
    console.log(`    ${bits.filter(Boolean).join('  ')}${q.note ? `\n        ↳ ${q.note}` : ''}`);
  }
  const picked = card.quotes[card.condition];
  console.log(
    `  → ${card.condition} = ${usd(picked?.price)} (${toCents(picked?.price ?? 0)} cents) · confidence: ${card.confidence ?? 'none'}`,
  );
}

const CHARIZARD: ResolveRequestCard & { condition?: ConditionCode } = {
  game: 'pokemon',
  name: 'Charizard',
  setName: 'Base Set',
  number: '4/102',
  printing: 'Holofoil',
  language: 'English',
  condition: 'NM',
};

const LUFFY: ResolveRequestCard & { condition?: ConditionCode } = {
  game: 'onepiece',
  name: 'Monkey.D.Luffy',
  printing: '',
  language: 'English',
  condition: 'NM',
};

(async () => {
  console.log('tcg-kit pricing demo — live upstreams, no server, no env beyond optional tokens');
  const charizard = await pricing.lookupPrice(CHARIZARD);
  show('Pokémon · Charizard · Base Set · 4/102 · Holofoil', charizard);

  const luffy = await pricing.lookupPrice(LUFFY);
  show('One Piece · Monkey.D.Luffy · any printing', luffy);
})();
