#!/usr/bin/env tsx
// Origin: BinderPricer scripts/battery.ts @ e995c9e.
// Changed: calls `createPricing()` directly instead of an HTTP server (no
// CANARY_BASE); ground-truth seeding uses the same instance's tcgcsv provider
// through a tiny internal handle rather than importing server/core/tcgcsv.
// Picks, seeding rules, grader rotation and output format are unchanged.
//
// Large accuracy battery: ~50 raw cards (vintage → modern, every game) + 50
// graded slabs. Catalog-SEEDED so no fixture can be bogus: each raw pick's
// real collector number + productId are pulled from the live tcgcsv catalog as
// ground truth, then the search-based resolver must round-trip back to that
// exact product. Graded picks reuse those verified identities.
//
// Run:  npx tsx scripts/battery.ts
//
// Not a pass/fail gate like canary.ts — this is a broad correctness sweep whose
// job is to surface where identification or pricing drifts across the catalog.

import { createContext } from '../src/pricing/context';
import { createPricing } from '../src/pricing/index';
import { createTcgCsv, extValue, type CsvProduct } from '../src/pricing/providers/tcgcsv';
import type { Game } from '../src/pricing/index';

// scripts/ is the ONLY place in this package that reads process.env.
const config = {
  userAgent: process.env.TCG_KIT_USER_AGENT || undefined,
  tokens: {
    pricecharting: process.env.PRICECHARTING_API_TOKEN,
    psa: process.env.PSA_API_TOKEN,
  },
};
const pricing = createPricing(config);
// The catalog handle used for ground truth. Its own context (and cache) — the
// battery reads the same public endpoints the engine does.
const csv = createTcgCsv(createContext(config));

interface Pick {
  game: string;
  set: string;
  name: string;
  line?: string; // catalog product-line override for ground-truth lookup
  setCode?: string;
  lang?: string;
  printing?: string;
  era: 'vintage' | 'modern' | 'jp';
}

const PICKS: Pick[] = [
  // ── Vintage Pokémon (WOTC) ──
  { game: 'pokemon', set: 'Base Set', name: 'Charizard', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Base Set', name: 'Blastoise', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Base Set', name: 'Venusaur', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Base Set', name: 'Mewtwo', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Base Set', name: 'Alakazam', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Jungle', name: 'Snorlax', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Jungle', name: 'Scyther', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Fossil', name: 'Dragonite', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Fossil', name: 'Gengar', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Fossil', name: 'Lapras', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Team Rocket', name: 'Dark Charizard', era: 'vintage', printing: 'holofoil' },
  { game: 'pokemon', set: 'Neo Genesis', name: 'Lugia', era: 'vintage', printing: 'holofoil' },
  // ── Modern Pokémon ──
  { game: 'pokemon', set: 'Evolving Skies', name: 'Rayquaza VMAX', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'Evolving Skies', name: 'Umbreon VMAX', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'Paldea Evolved', name: 'Iono', era: 'modern', printing: 'full art' },
  { game: 'pokemon', set: 'Obsidian Flames', name: 'Charizard ex', era: 'modern', printing: 'holofoil' },
  { game: 'pokemon', set: 'Lost Origin', name: 'Giratina V', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'Silver Tempest', name: 'Lugia V', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'Crown Zenith: Galarian Gallery', name: 'Giratina VSTAR', era: 'modern', printing: 'alternate art secret' },
  { game: 'pokemon', set: '151', name: 'Charizard ex', era: 'modern', printing: 'holofoil' },
  { game: 'pokemon', set: 'Surging Sparks', name: 'Pikachu ex', era: 'modern', printing: 'holofoil' },
  // ── Magic (older → modern) ──
  { game: 'magic', set: 'Commander 2021', name: 'Sol Ring', era: 'vintage' },
  { game: 'magic', set: 'Modern Horizons 2', name: 'Ragavan, Nimble Pilferer', era: 'modern' },
  { game: 'magic', set: 'Modern Horizons', name: 'Wrenn and Six', era: 'modern' },
  { game: 'magic', set: 'Dominaria United', name: 'Sheoldred, the Apocalypse', era: 'modern' },
  { game: 'magic', set: 'Universes Beyond: The Lord of the Rings: Tales of Middle-earth', name: 'Orcish Bowmasters', era: 'modern' },
  { game: 'magic', set: 'Kamigawa: Neon Dynasty', name: 'Fable of the Mirror-Breaker', era: 'modern' },
  { game: 'magic', set: 'Phyrexia: All Will Be One', name: 'Atraxa, Grand Unifier', era: 'modern' },
  // ── Yu-Gi-Oh (vintage → modern) ──
  { game: 'yugioh', set: 'Legend of Blue Eyes White Dragon', name: 'Blue-Eyes White Dragon', era: 'vintage' },
  { game: 'yugioh', set: 'Legend of Blue Eyes White Dragon', name: 'Dark Magician', era: 'vintage' },
  { game: 'yugioh', set: '25th Anniversary Rarity Collection', name: 'Ash Blossom & Joyous Spring', era: 'modern' },
  { game: 'yugioh', set: 'Eternity Code', name: 'Accesscode Talker', era: 'modern' },
  // ── One Piece ──
  { game: 'onepiece', set: 'Romance Dawn', name: 'Monkey.D.Luffy', setCode: 'OP01', era: 'modern', printing: 'alternate art' },
  { game: 'onepiece', set: 'Romance Dawn', name: 'Shanks', setCode: 'OP01', era: 'modern' },
  { game: 'onepiece', set: 'Romance Dawn', name: 'Roronoa Zoro', setCode: 'OP01', era: 'modern' },
  { game: 'onepiece', set: 'Paramount War', name: 'Portgas.D.Ace', setCode: 'OP02', era: 'modern' },
  { game: 'onepiece', set: 'Kingdoms of Intrigue', name: 'Yamato', setCode: 'OP04', era: 'modern' },
  // ── Lorcana ──
  { game: 'lorcana', set: 'The First Chapter', name: 'Elsa - Spirit of Winter', era: 'modern' },
  { game: 'lorcana', set: 'The First Chapter', name: 'Mickey Mouse - Brave Little Tailor', era: 'modern' },
  { game: 'lorcana', set: 'Rise of the Floodborn', name: 'Elsa - Gloves Off', era: 'modern' },
  // ── Dragon Ball (Fusion World) ──
  { game: 'dragonball', set: 'Awakened Pulse', name: 'Son Goku', line: 'Dragon Ball Super Fusion World', era: 'modern', printing: 'foil' },
  { game: 'dragonball', set: 'Blazing Aura', name: 'Vegeta', line: 'Dragon Ball Super Fusion World', era: 'modern', printing: 'foil' },
  // ── Digimon (via "other") ──
  { game: 'other', set: 'Release Special Booster 1.0', name: 'Agumon', line: 'Digimon Card Game', era: 'modern' },
  { game: 'other', set: 'Release Special Booster', name: 'Omnimon', line: 'Digimon Card Game', era: 'modern' },
  // ── A few more modern Pokémon to reach 50 ──
  { game: 'pokemon', set: 'Brilliant Stars', name: 'Charizard VSTAR', era: 'modern', printing: 'holofoil' },
  { game: 'pokemon', set: 'Fusion Strike', name: 'Mew VMAX', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'Shining Fates: Shiny Vault', name: 'Charizard VMAX', era: 'modern', printing: 'holofoil' },
  { game: 'pokemon', set: 'Chilling Reign', name: 'Blaziken VMAX', era: 'modern', printing: 'holofoil alternate art' },
  { game: 'pokemon', set: 'SV01: Scarlet & Violet Base Set', name: 'Miraidon ex', era: 'modern', printing: 'holofoil' },
  { game: 'pokemon', set: 'Temporal Forces', name: 'Iron Crown ex', era: 'modern', printing: 'holofoil' },
];

interface Truth extends Pick { productId: number; number: string; realName: string }

async function groundTruth(p: Pick): Promise<Truth | null> {
  let cat: number | null = null;
  if (p.line) cat = await csv.categoryIdForLine(p.line);
  if (cat == null && ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'dragonball'].includes(p.game)) {
    cat = await csv.categoryIdForGame(p.game as Game);
  }
  if (cat == null) return null;
  const g = await csv.findGroup(cat, p.set, p.setCode);
  if (!g) return null;
  let prods: CsvProduct[];
  try {
    prods = await csv.products(cat, g.groupId);
  } catch {
    return null;
  }
  // Prefer the base printing of the named card; avoid sealed/booster products.
  const nameL = p.name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const matches = prods.filter((pr) => {
    const n = pr.name.toLowerCase().replace(/[^a-z0-9]/g, '');
    return n.includes(nameL) && extValue(pr, 'Number');
  });
  if (!matches.length) return null;
  // Pick the lowest collector number (usually the base card, not an alt/promo).
  matches.sort((a, b) => {
    const na = parseInt(extValue(a, 'Number').replace(/\D/g, '') || '99999', 10);
    const nb = parseInt(extValue(b, 'Number').replace(/\D/g, '') || '99999', 10);
    return na - nb;
  });
  const chosen =
    p.printing && /alternate|full art/i.test(p.printing)
      ? (matches.find((m) => /alt|full art|secret/i.test(m.name)) ?? matches[0])
      : matches[0];
  return { ...p, productId: chosen.productId, number: extValue(chosen, 'Number'), realName: chosen.name };
}

const coreNum = (s: string) =>
  s.toLowerCase().trim().replace(/\s+[a-z]{1,3}$/, '').split('/')[0].replace(/\s+/g, '').replace(/^0+(?=\d)/, '');

interface RawRow { pick: Pick; ok: boolean; note: string }

async function testRaw(t: Truth): Promise<RawRow> {
  const r = await pricing.resolveCard({
    cell: 1,
    game: t.game,
    name: t.name,
    setName: t.set,
    setCode: t.setCode ?? '',
    number: t.number,
    printing: t.printing ?? '',
    language: t.lang ?? 'English',
  });
  if (!r.best) return { pick: t, ok: false, note: `NO MATCH (truth #${t.number})` };

  const m = r.best;
  const idHit = m.productId === t.productId;
  const numHit = coreNum(m.number) === coreNum(t.number);
  const nameHit = m.name.toLowerCase().includes(t.name.toLowerCase().split(/[.\- ]/)[0]);

  // Price it.
  const quotes = await pricing.priceAll({
    productId: m.productId,
    categoryId: m.categoryId,
    groupId: m.groupId,
    subType: m.subTypes[0]?.name ?? 'Market',
    salesCount: 5,
  });
  const nm = quotes.NM;
  const price = nm?.price ?? null;
  const priceOk = price != null && price > 0;

  const ok = (idHit || numHit) && nameHit && priceOk;
  const tag = idHit ? 'exact' : numHit ? 'num-ok' : 'MISS';
  const note = `${r.status}/${tag} → ${m.name} #${m.number} $${price ?? 'null'} (${nm?.source ?? '-'})${idHit ? '' : ` [truth #${t.number} id=${t.productId}]`}`;
  return { pick: t, ok, note };
}

// ── Graded battery: 50 slabs across graders/grades on verified identities ──
interface GradedRow { label: string; ok: boolean; note: string }

async function testGraded(t: Truth, grader: string, grade: string): Promise<GradedRow> {
  const label = `${grader} ${grade} ${t.name} (${t.set})`;
  const j = await pricing.priceGraded({
    grader,
    grade,
    name: t.name,
    setName: t.set,
    number: t.number,
    variant: t.printing ?? '',
  });
  const price = j.price ?? null;
  const ok = price != null && price > 0 && Boolean(j.gradeLabel);
  const slug = (j.sourceUrl || j.url || '').split('/').pop() || '-';
  return { label, ok, note: `$${price ?? 'null'} | ${j.gradeLabel ?? '-'} | ${slug}${j.note ? ` | ${j.note.slice(0, 60)}` : ''}` };
}

(async () => {
  console.log('Battery against live upstreams\n');
  console.log('Seeding ground truth from catalog…');
  const truths: Truth[] = [];
  const missing: Pick[] = [];
  for (const p of PICKS) {
    const t = await groundTruth(p).catch(() => null);
    if (t) truths.push(t);
    else missing.push(p);
  }
  console.log(`  ${truths.length}/${PICKS.length} picks verified real in catalog` + (missing.length ? `; ${missing.length} not found:` : ''));
  for (const m of missing) console.log(`   ✗ GT-not-found: ${m.game} · ${m.set} · ${m.name}`);

  // ── RAW ──
  console.log(`\n═══ RAW CARDS (${truths.length}) ═══`);
  const rawRows: RawRow[] = [];
  for (const t of truths) rawRows.push(await testRaw(t).catch((e) => ({ pick: t, ok: false, note: `threw: ${e}` })));
  for (const row of rawRows) console.log(`${row.ok ? 'OK  ' : 'BAD '} ${row.pick.game.padEnd(10)} ${row.pick.name}\n      ${row.note}`);
  const rawOk = rawRows.filter((r) => r.ok).length;

  // ── GRADED: build 50 slab combos from the verified TCG identities ──
  const gradedTargets = truths.filter((t) => t.game !== 'sports');
  const combos: { t: Truth; grader: string; grade: string }[] = [];
  const plan = [['PSA', '10'], ['PSA', '9'], ['BGS', '9.5'], ['CGC', '10'], ['SGC', '10']];
  let i = 0;
  for (const t of gradedTargets) {
    // Rotate graders/grades so we cover a spread; ~1-2 slabs per card until 50.
    const [grader, grade] = plan[i % plan.length];
    combos.push({ t, grader, grade });
    i++;
    if (i < 50 && i % 3 === 0) {
      const [g2, gr2] = plan[(i + 2) % plan.length];
      combos.push({ t, grader: g2, grade: gr2 });
      i++;
    }
    if (combos.length >= 50) break;
  }
  console.log(`\n═══ GRADED SLABS (${combos.length}) ═══`);
  const gradedRows: GradedRow[] = [];
  for (const c of combos) {
    gradedRows.push(
      await testGraded(c.t, c.grader, c.grade).catch((e) => ({ label: `${c.grader} ${c.grade} ${c.t.name}`, ok: false, note: `threw: ${e}` })),
    );
  }
  for (const row of gradedRows) console.log(`${row.ok ? 'OK  ' : 'BAD '} ${row.label}\n      ${row.note}`);
  const gradedOk = gradedRows.filter((r) => r.ok).length;

  console.log(`\n═══ SUMMARY ═══`);
  console.log(`Raw cards:    ${rawOk}/${rawRows.length} correct (id/number + name + real price)`);
  console.log(`Graded slabs: ${gradedOk}/${gradedRows.length} priced (value + grade label)`);
})();
