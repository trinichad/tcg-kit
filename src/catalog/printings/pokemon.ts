// Pokémon: which TCGplayer *printing* (subTypeName) a given copy of a card is.
//
// Distilled from PokedexDebut's `execution/pricing/variant.mjs`
// (architecture/pricing.md §1), with the parts that depended on that project's
// index shape (`card.tcgplayer[]`, Firestore rows) lifted out — what's left is
// the vocabulary and the deterministic rules, as pure functions over the two
// things every consumer already has: the product's `subTypes` array from
// tcgcsv, and whatever the user typed in a card-number field.
//
// No LLM anywhere in this path, and no I/O — a printing is decided, not
// guessed, so the same input always prices the same way.

/**
 * Every subTypeName TCGplayer uses for a Pokémon single.
 *
 * Three eras, and a product carries the vocabulary of exactly one of them:
 *   modern  — Normal / Holofoil / Reverse Holofoil
 *   WOTC    — 1st Edition / 1st Edition Holofoil / Unlimited / Unlimited Holofoil
 *   Base Set shadowed (group 604) — Normal / Holofoil, like a modern set
 *
 * "Shadowless" is NOT a subTypeName. It is a separate TCGplayer group
 * ("Base Set (Shadowless)", 1663) holding its own products, which then carry
 * the WOTC subTypes above. See `wantsShadowlessGroup`.
 */
export const POKEMON_PRINTINGS = [
  'Normal',
  'Holofoil',
  'Reverse Holofoil',
  '1st Edition',
  '1st Edition Holofoil',
  'Unlimited',
  'Unlimited Holofoil',
] as const;

export type PokemonPrinting = (typeof POKEMON_PRINTINGS)[number];

/** Base Set, shadowed. The ordinary Base Set products live here. */
export const BASE_SET_GROUP_ID = 604;
/** "Base Set (Shadowless)" — its own group, its own products, WOTC subTypes. */
export const BASE_SET_SHADOWLESS_GROUP_ID = 1663;

/** Edition tags a user can append to a card number. */
export const EDITIONS = ['1st Edition', 'Shadowless', 'Unlimited'] as const;
export type PokemonEdition = (typeof EDITIONS)[number] | '';

/**
 * Finish tags, **compound names first** so "Holo" never matches inside
 * "Reverse Holo" — the first match wins and the order is the rule.
 *
 * Rainbow Rare / Full Art / Gold describe a different card NUMBER, not a
 * printing of this one, so they are parsed (to be stripped out of the number)
 * and then ignored by the printing rules.
 */
export const FINISHES = ['Reverse Holo', 'Rainbow Rare', 'Full Art', 'Gold', 'Holo'] as const;
export type PokemonFinish = (typeof FINISHES)[number] | '';

const TAG_RE = /\b(1st edition|shadowless|unlimited|reverse holo|rainbow rare|full art|holo|gold)\b/gi;

// ── card numbers ────────────────────────────────────────────────────────────

/** "044/102" ≡ "44/102"; "TG18/TG30" keeps its letters; "" / "Unknown" → "". */
export function normNum(s: unknown): string {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v || v === 'unknown') return '';
  const m = v.match(/^0*([a-z]*\d+[a-z]*)\s*\/\s*0*([a-z]*\d+[a-z]*)$/);
  if (m) return `${m[1].replace(/^0+(?=\d)/, '')}/${m[2].replace(/^0+(?=\d)/, '')}`;
  if (!/^[a-z]*\d+[a-z]*$/.test(v)) return ''; // not a card number at all
  return v.replace(/^0+(?=\d)/, '');
}

/**
 * An index number field may list several cards ("53/111, 54/111", "AR1, AR2 …",
 * "18/106 19/106"): each is its own TCGplayer product. Normalised,
 * de-duplicated, in the order written.
 */
export function numberTokens(field: unknown): string[] {
  const out: string[] = [];
  for (const t of String(field ?? '').split(/[\s,]+/)) {
    const n = normNum(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/** Numerator only ("44/102" → "44", "44" → "44"). */
const numerator = (n: string) => normNum(n).split('/')[0];

/** Same card number, allowing a bare numerator ("44") against "44/102". */
export function numMatch(a: unknown, b: unknown): boolean {
  const na = normNum(a);
  const nb = normNum(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (!na.includes('/') || !nb.includes('/')) && numerator(na) === numerator(nb);
}

// ── what the user typed ─────────────────────────────────────────────────────

export interface OwnedTags {
  /** The card number with every tag stripped out; '' when there wasn't one. */
  number: string;
  edition: PokemonEdition;
  finish: PokemonFinish;
}

/**
 * Split "44/102 Unlimited Holo" into { number, edition, finish }.
 *
 * Editions are scanned without breaking, so the LAST one written wins;
 * finishes break on the first hit, and FINISHES is ordered compound-first so
 * "Reverse Holo" can never be read as "Holo".
 */
export function parseOwned(ownedCardNumber: unknown): OwnedTags {
  const raw = String(ownedCardNumber ?? '');
  let edition: PokemonEdition = '';
  let finish: PokemonFinish = '';
  for (const e of EDITIONS) if (new RegExp(`\\b${e}\\b`, 'i').test(raw)) edition = e;
  for (const f of FINISHES) {
    if (new RegExp(`\\b${f}\\b`, 'i').test(raw)) {
      finish = f;
      break;
    }
  }
  const number = numberTokens(raw.replace(TAG_RE, ' '))[0] ?? '';
  return { number, edition, finish };
}

// ── which printing ──────────────────────────────────────────────────────────

/** A product is WOTC-era when its own subTypes say so. */
export function isWotcProduct(subTypes: readonly string[]): boolean {
  return subTypes.some((s) => /^(1st Edition|Unlimited)/.test(s));
}

/** Does this product offer a 1st Edition printing of its own? */
export function hasFirstEdition(subTypes: readonly string[]): boolean {
  return subTypes.some((s) => /^1st Edition/.test(s));
}

/**
 * Should a copy tagged `edition` be priced against the **Base Set
 * (Shadowless)** group's product instead of the shadowed one?
 *
 * Shadowless copies live there, and so do 1st Edition copies — which are
 * shadowless for every Base Set card but one. The exception is why the second
 * clause exists: Machamp's stamped copy IS shadowed and TCGplayer files it as
 * its own product (42425) with a `1st Edition…` printing, so when the plain
 * product already offers 1st Edition, the copy stays there.
 */
export function wantsShadowlessGroup(
  edition: PokemonEdition,
  plainProductSubTypes: readonly string[],
): boolean {
  return (
    edition === 'Shadowless' ||
    (edition === '1st Edition' && !hasFirstEdition(plainProductSubTypes))
  );
}

export interface WantOptions {
  /** True for a WOTC-era product, or any product in the Shadowless group. */
  wotc: boolean;
  edition: PokemonEdition;
  /** The copy is a holo print — the number matched the card's Holo number, or
   *  the user tagged it "Holo". */
  isHolo: boolean;
  finish: PokemonFinish;
}

/** The printing a copy *wants*, before checking the product actually has it. */
export function wantedPrinting({ wotc, edition, isHolo, finish }: WantOptions): PokemonPrinting {
  if (wotc) {
    return edition === '1st Edition'
      ? isHolo
        ? '1st Edition Holofoil'
        : '1st Edition'
      : isHolo
        ? 'Unlimited Holofoil'
        : 'Unlimited';
  }
  return finish === 'Reverse Holo' ? 'Reverse Holofoil' : isHolo ? 'Holofoil' : 'Normal';
}

/**
 * Fallback order when the wanted printing is not one the product offers:
 * wanted → its non-holo twin (`… Holofoil` → `…`) → `Normal` → the product's
 * first printing.
 */
export function fallbackChain(want: string, subTypes: readonly string[]): string[] {
  return [want, want.replace(/ Holofoil$/, ''), 'Normal', subTypes[0]].filter(Boolean) as string[];
}

export interface PrintingChoice {
  /** The subTypeName to price against. */
  printing: string;
  /**
   * True when the chain had to fall back. Never hidden: the client shows the
   * same number, the job logs the substitution — a silent fallback is how a
   * Reverse Holo quietly gets a Normal's price.
   */
  fallback: boolean;
}

/**
 * Resolve `subTypes` + what the user typed into one printing. Returns null
 * only when the product has no printings at all.
 */
export function resolvePrinting(
  subTypes: readonly string[],
  opts: WantOptions,
): PrintingChoice | null {
  const want = wantedPrinting(opts);
  const printing = fallbackChain(want, subTypes).find((s) => subTypes.includes(s)) ?? null;
  if (!printing) return null;
  return { printing, fallback: printing !== want };
}

/** The printing an unowned / untagged copy is priced at: `Normal` when the
 *  product has one, else its first printing (a holo rare or promo → Holofoil). */
export function defaultPrinting(subTypes: readonly string[]): PrintingChoice | null {
  return resolvePrinting(subTypes, {
    wotc: isWotcProduct(subTypes),
    edition: '',
    isHolo: false,
    finish: '',
  });
}
