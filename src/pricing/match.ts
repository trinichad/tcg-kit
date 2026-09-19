// Origin: BinderPricer server/core/match.ts @ e995c9e, plus the generic number
// helpers from PokedexDebut execution/pricing/variant.mjs (normNum,
// numberTokens, numMatch — merged onto normNumber rather than duplicated).
// Changed: providers arrive via `createMatch(ctx, { csv, live })`; the pure
// text/number helpers stay module-level; `imageUrl` moved to ../helpers.
// Scoring, gates and thresholds untouched.

import type { PricingCtx } from './context';
import { imageUrl } from './helpers';
import type { CsvGroup, CsvPrice, TcgCsv } from './providers/tcgcsv';
import { extValue, saneMarketPrice } from './providers/tcgcsv';
import { linesFor, type SearchHit, type TcgLive } from './providers/tcglive';
import type { Game, ProductMatch, ResolveRequestCard, ResolveResult } from './types';

// Games searched with a product-line filter. Anything else ("other") still
// works: the search runs unfiltered across all of TCGplayer and the hit's own
// product line resolves the category dynamically.
const KNOWN_GAMES: Game[] = ['pokemon', 'magic', 'yugioh', 'lorcana', 'onepiece', 'dragonball'];

const cdnImage = (productId: number) => imageUrl(productId, '200w');
const productUrl = (productId: number) => `https://www.tcgplayer.com/product/${productId}`;
const r3 = (n: number) => Math.round(n * 1000) / 1000;

// ── Text similarity helpers ─────────────────────────────────────────────────

export function normText(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      // Hyphens split into tokens: "Zoro-Juurou" must match slug-derived
      // "zoro juurou". Collector numbers go through normNumber, not here.
      .replace(/[^a-z0-9\s/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function tokenSet(s: string): Set<string> {
  return new Set(normText(s).split(' ').filter(Boolean));
}

/** Token-set Dice similarity with a bonus when one string contains the other. */
export function nameSim(a: string, b: string): number {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokenSet(a);
  const B = tokenSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const dice = (2 * inter) / (A.size + B.size);
  const contains = na.includes(nb) || nb.includes(na) ? 0.85 : 0;
  // Squashed containment: PriceCharting collapses punctuated names to one
  // token ("Monkey.D.Luffy" → "monkeydluffy"), which token overlap scores 0.
  // Guard with a length floor so tiny fragments can't false-positive.
  const ja = na.replace(/[\s/]+/g, '');
  const jb = nb.replace(/[\s/]+/g, '');
  const squashed =
    Math.min(ja.length, jb.length) >= 5 && (ja.includes(jb) || jb.includes(ja)) ? 0.85 : 0;
  return Math.max(dice, contains, squashed);
}

// ── Collector-number family ─────────────────────────────────────────────────
// BinderPricer's `normNumber` (lenient — keeps letters and hyphens, so
// "LOB-EN001" → "lob-en1") and PokéDebut's `normNum` (strict — only accepts
// things that ARE a card number, so "LOB-EN001" and "Unknown" → "") do
// different jobs, so both survive; normNum is now defined in terms of
// normNumber instead of re-implementing the zero-stripping.

/** "004/102" → "4/102", "LOB-EN001" → "lob-en1" (consistent both sides). */
export function normNumber(n: string): string {
  return n
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/\d+/g, (d) => String(parseInt(d, 10)));
}

/**
 * Strict form: "044/102" ≡ "44/102"; "TG18/TG30" keeps its letters; anything
 * that isn't a plain card number ("", "Unknown", "LOB-EN001") → "".
 */
export function normNum(s: string): string {
  const v = normNumber(String(s ?? '').trim());
  if (!v || v === 'unknown') return '';
  const m = v.match(/^([a-z]*\d+[a-z]*)\/([a-z]*\d+[a-z]*)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return /^[a-z]*\d+[a-z]*$/.test(v) ? v : '';
}

/**
 * A number field may list several cards ("53/111, 54/111", "AR1, AR2 …",
 * "18/106 19/106"): each is its own TCGplayer product. Normalised,
 * de-duplicated, in the order written.
 */
export function numberTokens(field: string | null | undefined): string[] {
  const out: string[] = [];
  for (const t of String(field ?? '').split(/[\s,]+/)) {
    const n = normNum(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** The "/total" part of a collector number, e.g. "4/102" → "102". */
export function numberTotal(n: string): string {
  const parts = normNumber(n).split('/');
  return parts.length > 1 ? parts[1] : '';
}

/** Numerator only ("44/102" → "44", "44" → "44"). */
const numerator = (n: string) => normNum(n).split('/')[0];

/** Same card number, allowing a bare numerator ("44") against "44/102". */
export function numMatch(a: string, b: string): boolean {
  const na = normNum(a);
  const nb = normNum(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (!na.includes('/') || !nb.includes('/')) && numerator(na) === numerator(nb);
}

/**
 * Two numbers name different sets when both carry a set total and the totals
 * differ ("5/102" vs "5/130" — Base Set vs Base Set 2). Used to stop the
 * matcher confidently accepting a same-numbered card from the wrong set.
 */
export function numberingOk(a: string, b: string): boolean {
  const ta = numberTotal(a);
  const tb = numberTotal(b);
  return !(ta && tb && ta !== tb);
}

/** "lob-en1" → "lob-1": Yu-Gi-Oh region infixes (EN/E/F/G…) name the same
 * card — a label read "LOB-001" must match the catalog's "LOB-EN001". */
const stripRegion = (n: string): string =>
  n.replace(/^([a-z]{2,6})-?(?:en|jp|ja|kr|ae|au|e|f|g|i|s|p)-?(\d)/, '$1-$2');

export function numberScore(a: string, b: string): number {
  const na = normNumber(a);
  const nb = normNumber(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (stripRegion(na) === stripRegion(nb)) return 0.9;
  const la = na.split('/')[0];
  const lb = nb.split('/')[0];
  if (la && la === lb) {
    // Same collector number but different set totals → different card (a
    // Base Set #5/102 is not Base Set 2 #5/130). Weak signal, not strong.
    return numberingOk(a, b) ? 0.85 : 0.4;
  }
  if (na.includes(nb) || nb.includes(na)) return 0.6;
  return 0;
}

/** Search names look like "Charizard - 4/102 (CoroCoro Promo)". */
export function splitProductName(productName: string): { name: string; number: string } {
  const m = productName.match(/^(.*?)\s+-\s+([^()]*\d[^()]*?)\s*(\(.*\))?\s*$/);
  if (m) return { name: [m[1], m[3]].filter(Boolean).join(' ').trim(), number: m[2].trim() };
  return { name: productName, number: '' };
}

// ── Scoring ─────────────────────────────────────────────────────────────────

// Art-variant designators that name a SEPARATE product ("Zoro-Juurou" vs
// "Zoro-Juurou (Special Alternate Art)", One Piece "(SP)" specials): agreement
// between the read printing and the product name sways sibling ranking.
const ART_VARIANT = /(special )?alternate art|manga|parallel|full art|secret|\bsp\b/i;

/** Score a resolved ProductMatch (from search or catalog) against the read. */
function scoreMatch(card: ResolveRequestCard, m: ProductMatch): { score: number; setSim: number } {
  const n = nameSim(card.name, m.name);
  const parts: { w: number; s: number }[] = [{ w: 0.5, s: n }];
  if (card.number) parts.push({ w: 0.35, s: numberScore(card.number, m.number) });
  let setSim = 0;
  if (card.setName || card.setCode) {
    // Set-code match tolerates composite catalog codes ("OP15" ⊂ "OP15-EB04")
    // and a trailing language marker on the read ("SWSH07 EN" → "swsh07").
    //
    // What it must NOT tolerate is the read code merely CONTAINING a shorter
    // catalogue code: "PRE" (Prismatic Evolutions) contains "PR" (WoTC Promo),
    // and a perfect set score there returned a $50.56 promo Eevee for a $0.21
    // card — auto-accepted, because setSim 1.0 also satisfies the guards that
    // would otherwise flag it for the dealer to check. Lorcana is worse: its
    // codes are bare digits, so "14" contains "1". Real collisions found
    // across the live catalogue include SSP⊃SS, SFA⊃SF, DRI⊃DR, PAR⊃AR,
    // TTBB24⊃TTBB, SHFSV⊃SHF, CRZGG⊃CRZ and SWSH12TG⊃SWSH12 — a minimum
    // length would not have saved any of them.
    const qCode = card.setCode ? normText(card.setCode).replace(/\s+/g, '') : '';
    const gCode = m.groupCode ? normText(m.groupCode).replace(/\s+/g, '') : '';
    const qBare = qCode.replace(/(en|jp|jpn|kr|fr|de|it|es|pt|zh|tc|sc)$/, '');
    const codeHit =
      !!qCode && !!gCode && (qCode === gCode || qBare === gCode || gCode.includes(qCode));
    setSim = Math.max(card.setName ? nameSim(card.setName, m.groupName) : 0, codeHit ? 1 : 0);
    parts.push({ w: 0.15, s: setSim });
  }
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  let score = parts.reduce((a, p) => a + p.w * p.s, 0) / totalW;
  // Oversize/promo reprint trap (e.g. jumbo "Charizard 4/102"): discount unless
  // the identified set actually agrees.
  if (/jumbo|world championship|oversize/i.test(m.groupName) && setSim < 0.8) score *= 0.75;
  // Alt-art siblings: reads that name a variant should prefer the variant
  // product and vice versa (base card outranks alt-art on pure name match).
  const wantsVariant = ART_VARIANT.test(card.printing ?? '');
  const isVariant = ART_VARIANT.test(m.name);
  if (wantsVariant !== isVariant) score -= 0.07;
  else if (wantsVariant && isVariant) score += 0.05;
  // WOTC vintage editions: TCGplayer splits Base Set-era cards into a plain
  // "Base Set" product (Unlimited — one "Normal" subtype) and a "Base Set
  // (Shadowless)" product carrying the "1st Edition" + shadowless printings.
  // A read of "1st edition"/"shadowless" must prefer the product that actually
  // OFFERS that printing, or an $85 1st-ed prices as the $4 Unlimited. (Set
  // name alone can't tell them apart — "Base Set" exactly matches the wrong
  // group.) pickSubType then selects the exact printing within the product.
  const wantsEarlyPrint = /1st ed|first ed|shadowless/i.test(
    `${card.printing ?? ''} ${card.setName ?? ''}`,
  );
  if (wantsEarlyPrint && m.subTypes.some((s) => /1st ed|shadowless/i.test(s.name))) {
    score += 0.08;
  }
  return { score, setSim };
}

// WOTC-era Pokémon sets where the same card exists across unlimited /
// shadowless / 1st-edition printings AND TCGplayer's search routinely fails to
// surface them all. For these we pull candidates straight from the catalog so
// the user can pick the right printing after a wrong guess.
const VINTAGE_GROUP_NAMES = [
  'Base Set', 'Base Set (Shadowless)', 'Base Set 2', 'Jungle', 'Fossil',
  'Team Rocket', 'Gym Heroes', 'Gym Challenge', 'Neo Genesis',
  'Neo Discovery', 'Neo Revelation', 'Neo Destiny', 'Legendary Collection',
];
const VINTAGE_GROUP_SET = new Set(VINTAGE_GROUP_NAMES.map(normText));
const VINTAGE_TOTALS = new Set(['64', '62', '102', '110', '111', '130', '132', '75', '66', '105', '109']);

function looksVintage(card: ResolveRequestCard): boolean {
  if (VINTAGE_TOTALS.has(numberTotal(card.number ?? ''))) return true;
  return /base set|jungle|fossil|team rocket|gym (heroes|challenge)|neo |legendary collection|shadowless/i.test(
    card.setName ?? '',
  );
}

export type Matcher = ReturnType<typeof createMatch>;

export function createMatch(_ctx: PricingCtx, deps: { csv: TcgCsv; live: TcgLive }) {
  const { csv, live } = deps;

  /**
   * Same-named products across the vintage Pokémon sets, read from the catalog.
   * This is what surfaces (say) Jungle Clefable and its 1st-Edition/Unlimited
   * printings when TCGplayer search only returns the Base Set 2 reprint.
   */
  async function catalogNameCandidates(
    card: ResolveRequestCard,
    categoryId: number,
  ): Promise<ProductMatch[]> {
    let all: CsvGroup[];
    try {
      all = await csv.groups(categoryId);
    } catch {
      return [];
    }
    const targets = all.filter((g) => VINTAGE_GROUP_SET.has(normText(g.name)));
    const perGroup = await Promise.all(
      targets.map(async (g): Promise<ProductMatch[]> => {
        let prods;
        try {
          prods = await csv.products(categoryId, g.groupId);
        } catch {
          return [];
        }
        const named = prods
          .map((p) => ({ p, s: nameSim(card.name, p.name) }))
          .filter((x) => x.s >= 0.8)
          .sort((a, b) => b.s - a.s)
          .slice(0, 2);
        if (!named.length) return [];
        let priceRows: CsvPrice[] = [];
        try {
          priceRows = await csv.prices(categoryId, g.groupId);
        } catch {
          // subtypes optional
        }
        return named.map(({ p }) => {
          const subs = priceRows
            .filter((r) => r.productId === p.productId)
            .map((r) => ({ name: r.subTypeName, marketPrice: saneMarketPrice(r).price }));
          return {
            productId: p.productId,
            name: p.name,
            categoryId,
            groupId: g.groupId,
            groupName: g.name,
            groupCode: g.abbreviation,
            number: extValue(p, 'Number'),
            rarity: extValue(p, 'Rarity'),
            imageUrl: p.imageUrl || cdnImage(p.productId),
            url: p.url || productUrl(p.productId),
            subTypes: subs.length ? subs : [{ name: 'Market', marketPrice: null }],
            score: 0,
          };
        });
      }),
    );
    return perGroup.flat();
  }

  /**
   * Search with several query phrasings and merge the hits. TCGplayer's fuzzy
   * search ranks reprints whose *product name* contains the number (e.g.
   * Celebrations "Charizard - 4/102") above the original card, so a plain
   * "name + number" query alone can miss the printing the user actually has.
   */
  async function gatherHits(
    card: ResolveRequestCard,
    game: Game | undefined,
  ): Promise<SearchHit[] | null> {
    const lines = linesFor(game, card.language);
    const queries = [[card.name, card.number].filter(Boolean).join(' ')];
    if (card.setName) queries.push(`${card.name} ${card.setName}`);
    else if (card.number) queries.push(card.name);
    let sawSuccess = false;
    const merged = new Map<number, SearchHit>();
    for (const q of queries) {
      const hits = await live.searchProducts(q, lines, 12);
      if (hits === null) continue;
      sawSuccess = true;
      for (const h of hits) if (!merged.has(h.productId)) merged.set(h.productId, h);
    }
    return sawSuccess ? [...merged.values()] : null;
  }

  // ── Match construction ────────────────────────────────────────────────────

  /** Cheap match from a search hit alone — no catalog fetches. */
  async function lightMatch(hit: SearchHit, score: number): Promise<ProductMatch> {
    // Resolve the category from the hit's own product line — works for every
    // TCGplayer game (Pokemon Japan, Dragon Ball, Digimon, …), not just the enum.
    const categoryId = await csv.categoryIdForLine(hit.productLineName);
    const split = splitProductName(hit.productName);
    return {
      productId: hit.productId,
      name: split.name || hit.productName,
      categoryId,
      groupId: null,
      groupName: hit.setName,
      groupCode: hit.setCode || undefined,
      number: hit.number || split.number,
      rarity: hit.rarityName,
      imageUrl: cdnImage(hit.productId),
      url: productUrl(hit.productId),
      subTypes: [{ name: 'Market', marketPrice: hit.marketPrice }],
      score: r3(score),
    };
  }

  /**
   * Add catalog data (printing variants + per-variant market prices, canonical
   * number/rarity/image) to a light match. Never throws — returns the input
   * unchanged on failure.
   */
  async function enrichMatch(
    light: ProductMatch,
    setCode?: string,
    setIdHint?: number | null,
  ): Promise<ProductMatch> {
    try {
      const categoryId = light.categoryId;
      if (categoryId == null) return light;
      let groupId = light.groupId;
      if (groupId == null && setIdHint != null) {
        const all = await csv.groups(categoryId);
        if (all.some((g) => g.groupId === setIdHint)) groupId = setIdHint;
      }
      if (groupId == null) {
        const g = await csv.findGroup(categoryId, light.groupName, setCode);
        groupId = g?.groupId ?? null;
      }
      if (groupId == null) return light;
      let subTypes = await csv.subTypesFor(categoryId, groupId, light.productId);
      let row = await csv.productRow(categoryId, groupId, light.productId);
      // findGroup trusts the caller's setCode ahead of the product's own group
      // name, so a misread code binds the match to a set the product isn't even
      // in — which silently costs it its printing list (no 1st Edition option)
      // and its canonical number. The product not being found in the group is
      // proof the group is wrong: fall back to the name, which came from the
      // search hit rather than from a model's guess.
      if (!row && setCode) {
        const byName = await csv.findGroup(categoryId, light.groupName);
        if (byName && byName.groupId !== groupId) {
          const retry = await csv.productRow(categoryId, byName.groupId, light.productId);
          if (retry) {
            groupId = byName.groupId;
            row = retry;
            subTypes = await csv.subTypesFor(categoryId, groupId, light.productId);
          }
        }
      }
      return {
        ...light,
        groupId,
        subTypes: subTypes.length ? subTypes : light.subTypes,
        imageUrl: row?.imageUrl || light.imageUrl,
        url: row?.url || light.url,
        number: row ? extValue(row, 'Number') || light.number : light.number,
        rarity: row ? extValue(row, 'Rarity') || light.rarity : light.rarity,
      };
    } catch (err) {
      console.error('[match] enrich failed for', light.productId, err);
      return light;
    }
  }

  // ── Fallback: match against the tcgcsv catalog (needs game + set) ─────────

  async function catalogResolve(
    card: ResolveRequestCard,
    game: Game,
  ): Promise<ResolveResult | null> {
    const categoryId = await csv.categoryIdForGame(game);
    const group = await csv.findGroup(categoryId, card.setName, card.setCode);
    if (!group) return null;
    const prods = await csv.products(categoryId, group.groupId);
    const scored = prods
      .map((p) => {
        const num = extValue(p, 'Number');
        const parts = [{ w: 0.55, s: nameSim(card.name, p.name) }];
        if (card.number) parts.push({ w: 0.45, s: numberScore(card.number, num) });
        const totalW = parts.reduce((a, x) => a + x.w, 0);
        return { p, num, score: parts.reduce((a, x) => a + x.w * x.s, 0) / totalW };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
    if (!scored.length || scored[0].score < 0.5) return null;
    const candidates: ProductMatch[] = [];
    for (const { p, num, score } of scored) {
      candidates.push({
        productId: p.productId,
        name: p.name,
        categoryId,
        groupId: group.groupId,
        groupName: group.name,
        groupCode: group.abbreviation,
        number: num,
        rarity: extValue(p, 'Rarity'),
        imageUrl: p.imageUrl || cdnImage(p.productId),
        url: p.url || productUrl(p.productId),
        subTypes: await csv.subTypesFor(categoryId, group.groupId, p.productId),
        score: r3(score),
      });
    }
    return {
      cell: card.cell ?? 0,
      status: scored[0].score >= 0.75 ? 'matched' : 'uncertain',
      best: candidates[0],
      candidates,
      note: 'matched via set catalog (search unavailable)',
    };
  }

  // ── Public entry points ───────────────────────────────────────────────────

  async function resolveCard(card: ResolveRequestCard): Promise<ResolveResult> {
    const game = KNOWN_GAMES.includes(card.game as Game) ? (card.game as Game) : undefined;
    const none = (note: string): ResolveResult => ({
      cell: card.cell ?? 0,
      status: 'none',
      best: null,
      candidates: [],
      note,
    });
    if (!card.name?.trim()) return none('no card name to search for');
    // TCGplayer doesn't carry sports cards — price them from
    // sportscardspro.com's eBay-solds data instead (priceGraded).
    if (card.game === 'sports') return none('sports card — priced from eBay sold listings');

    const hits = await gatherHits(card, game);
    const searchHits = (hits ?? []).filter((h) => !h.sealed);

    // Name-gate: a fuzzy search for "Clefable Base Set (Shadowless)" happily
    // returns random Shadowless cards (Bulbasaur, a theme deck, …) — drop any
    // hit whose name doesn't actually resemble the card we read.
    const nameOk = (productName: string) =>
      Math.max(
        nameSim(card.name, productName),
        nameSim(card.name, splitProductName(productName).name),
      ) >= 0.5;

    // Score EVERY name-gated hit (≤24 across the query phrasings). Capping the
    // pool used to slice off the name+set query's results entirely: the
    // name+number query's 12 reprints came first, so "Sol Ring Commander 2021"
    // and "Blue-Eyes LOB-001" lost to junk before scoring even ran.
    const hitMeta = new Map<number, { setCode?: string; setId: number | null }>();
    const searchMatches = await Promise.all(
      searchHits
        .filter((h) => nameOk(h.productName))
        .map(async (h) => {
          const m = await lightMatch(h, 0);
          hitMeta.set(m.productId, { setCode: h.setCode, setId: h.setId });
          return m;
        }),
    );

    // Vintage Pokémon: augment with catalog siblings so every printing (Base
    // Set / Shadowless / Jungle / 1st-ed / unlimited) is offered even though
    // search hides most of them.
    let catalogMatches: ProductMatch[] = [];
    if (card.game === 'pokemon' && looksVintage(card)) {
      catalogMatches = await catalogNameCandidates(card, await csv.categoryIdForGame('pokemon'));
    }

    // Catalog matches first: when a product turns up in both, the catalog copy
    // carries the real printing list (1st Edition / Unlimited …) and its group,
    // whereas the search copy only has a single aggregate "Market" price.
    const byId = new Map<number, ProductMatch>();
    for (const m of [...catalogMatches, ...searchMatches]) {
      if (!byId.has(m.productId)) byId.set(m.productId, m);
    }
    const pool = [...byId.values()];

    if (!pool.length) {
      if (game) {
        const viaCatalog = await catalogResolve(card, game);
        if (viaCatalog) return viaCatalog;
      }
      return none(
        hits === null
          ? 'TCGplayer search is unavailable right now — retry, or search manually'
          : 'no matching cards found — try manual search',
      );
    }

    const scored = pool
      .map((m) => ({ m, ...scoreMatch(card, m) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    // Enrich the winner if it came from search (catalog matches already carry
    // their group + printings). Runners-up stay light until picked.
    const top = scored[0];
    const meta = hitMeta.get(top.m.productId);
    const best =
      top.m.groupId != null
        ? { ...top.m, score: r3(top.score) }
        : {
            ...(await enrichMatch(top.m, meta?.setCode ?? card.setCode, meta?.setId)),
            score: r3(top.score),
          };
    const candidates = [best, ...scored.slice(1).map((x) => ({ ...x.m, score: r3(x.score) }))];

    const s0 = scored[0].score;
    const s1 = scored[1]?.score ?? 0;
    // Never auto-accept a hit whose set or numbering disagrees with what was
    // read — same name + number in a different set is usually a reprint at a
    // very different price (Base Set vs Base Set 2, shadowless, jumbo, …).
    const setProvided = Boolean(card.setName || card.setCode);
    const setAgrees = !setProvided || scored[0].setSim >= 0.5;
    const numbersOk = numberingOk(card.number ?? '', scored[0].m.number);
    // A strongly-agreeing set name is enough to accept even when a sibling
    // printing scores almost as high (Base Set Charizard vs its Shadowless twin).
    const strongSet = setProvided && scored[0].setSim >= 0.8;
    const matched =
      s0 >= 0.78 && setAgrees && numbersOk && (strongSet || s0 - s1 >= 0.08 || s1 < 0.7);
    return {
      cell: card.cell ?? 0,
      status: matched ? 'matched' : 'uncertain',
      best,
      candidates,
    };
  }

  /**
   * Resolve a pasted TCGplayer product URL. There is no public by-id lookup,
   * but product URLs carry a name slug — search for the slug words and pick
   * the hit with the exact product id.
   */
  async function matchFromProductId(productId: number, slug?: string): Promise<ProductMatch | null> {
    if (!slug) return null;
    const hits = await live.searchProducts(slug.replace(/-/g, ' '), undefined, 24);
    const hit = hits?.find((h) => h.productId === productId);
    if (!hit) return null;
    return enrichMatch(await lightMatch(hit, 1), hit.setCode, hit.setId);
  }

  /** Manual search box: free text, a TCGplayer URL, or a bare product id. */
  async function manualSearch(
    q: string,
    game?: Game,
  ): Promise<{ results: ProductMatch[]; note?: string }> {
    const urlMatch = q.match(/product\/(\d+)(?:\/([a-z0-9-]+))?/i);
    if (urlMatch) {
      const byId = await matchFromProductId(Number(urlMatch[1]), urlMatch[2]);
      if (byId) return { results: [byId] };
      return { results: [], note: 'Could not look up that product link — try searching by name.' };
    }
    // Split a trailing collector number out of the free text. TCGplayer's
    // search breaks when a number like "97/97" is appended to a name — it
    // returns same-numbered cards from OTHER sets (or nothing), dropping the
    // named card entirely. So we also search by name alone and re-rank by name
    // + number ourselves, which surfaces "Rayquaza ex #97/97" without the set.
    const tokens = q.split(/\s+/).filter(Boolean);
    const isNumTok = (t: string) => /\d/.test(t) && /^[a-z]{0,4}\d[\w/-]*$/i.test(t);
    const name = tokens.filter((t) => !isNumTok(t)).join(' ');
    const number = tokens.filter(isNumTok).join(' ');

    const lines = linesFor(game);
    const queries = [q];
    if (name && name !== q) queries.push(name);
    const merged = new Map<number, SearchHit>();
    let reachable = false;
    for (const query of queries) {
      const hits = await live.searchProducts(query, lines, 20);
      if (hits === null) continue;
      reachable = true;
      for (const h of hits) if (!h.sealed && !merged.has(h.productId)) merged.set(h.productId, h);
    }
    if (!reachable) return { results: [], note: 'TCGplayer search is unavailable right now.' };

    let pool = [...merged.values()];
    // Re-rank by name + number when a name was given; otherwise keep
    // TCGplayer's order (a bare "97/97" has nothing better to sort by).
    if (name) {
      pool = pool
        .map((h) => {
          const nm = nameSim(name, splitProductName(h.productName).name || h.productName);
          const num = number ? numberScore(number, h.number) : 0;
          return { h, score: 0.7 * nm + 0.3 * num };
        })
        .sort((a, b) => b.score - a.score)
        .map((s) => s.h);
    }
    const results = await Promise.all(pool.slice(0, 10).map((h) => lightMatch(h, 0)));
    return { results };
  }

  return { resolveCard, manualSearch, enrichMatch, lightMatch };
}
