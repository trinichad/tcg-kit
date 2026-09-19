'use strict';

var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/catalog/catalogues.ts
var INDEX_GAMES = [
  "pokemon",
  "pokemon-japan",
  "onepiece",
  "dragonball",
  // Dragon Ball Super CCG (2017+, Masters era)
  "dragonball-fusion",
  // Fusion World (current)
  "dragonball-z",
  // Panini DBZ TCG (2014–17)
  "magic",
  "yugioh",
  "lorcana"
];
var CATEGORY_ID = {
  pokemon: 3,
  "pokemon-japan": 85,
  onepiece: 68,
  dragonball: 27,
  "dragonball-fusion": 80,
  "dragonball-z": 23,
  magic: 1,
  yugioh: 2,
  lorcana: 71
};
var LANGUAGE = {
  3: "English",
  85: "Japanese",
  68: "English",
  27: "English",
  80: "English",
  23: "English",
  1: "English",
  2: "English",
  71: "English"
};
var FAMILY = {
  3: "pokemon",
  85: "pokemon",
  68: "onepiece",
  27: "dragonball",
  80: "dragonball-fusion",
  23: "dragonball-z",
  1: "magic",
  2: "yugioh",
  71: "lorcana"
};
var OFF_LANGUAGE_PENALTY = 8;
function languagePrior(categoryId, preferCategory) {
  return categoryId !== preferCategory && FAMILY[categoryId] === FAMILY[preferCategory] ? OFF_LANGUAGE_PENALTY : 0;
}
function gamesForHint(hint) {
  switch (hint) {
    case "auto":
      return INDEX_GAMES;
    case "pokemon":
      return ["pokemon", "pokemon-japan"];
    case "dragonball":
      return ["dragonball", "dragonball-fusion", "dragonball-z"];
    case "onepiece":
    case "magic":
    case "yugioh":
    case "lorcana":
      return [hint];
    default:
      return [];
  }
}
function baseCardName(name) {
  const base = name.replace(/\s*[([].*?[)\]]\s*/g, " ").replace(/\s+-\s+.*$/, " ").replace(/\s+/g, " ").trim().toLowerCase();
  return base || name.trim().toLowerCase();
}
function variantSuffix(name) {
  const m = name.match(/[([]|\s+-\s+/);
  return m ? name.slice(m.index).trim() : "";
}

// src/recognize/cardindex.ts
var MANIFEST_FILE = "manifest.json";

// src/catalog/printings/onepiece.ts
var onepiece_exports = {};
__export(onepiece_exports, {
  FOIL_ONLY_RARITIES: () => FOIL_ONLY_RARITIES,
  ONEPIECE_PRINTINGS: () => ONEPIECE_PRINTINGS,
  ONEPIECE_RARITIES: () => ONEPIECE_RARITIES,
  SAMPLED: () => SAMPLED,
  VARIANT_TAGS: () => VARIANT_TAGS,
  resolvePrinting: () => resolvePrinting
});
var ONEPIECE_PRINTINGS = ["Normal", "Foil"];
var ONEPIECE_RARITIES = ["L", "C", "UC", "R", "SR", "SEC", "DON!!"];
var FOIL_ONLY_RARITIES = ["SR", "SEC"];
var VARIANT_TAGS = ["Parallel", "Box Topper", "Alternate Art", "Manga"];
var SAMPLED = {
  categoryId: 68,
  groupId: 3188,
  groupName: "Romance Dawn",
  abbreviation: "OP01",
  publishedOn: "2022-12-02",
  sampledOn: "2026-09-18",
  products: 163,
  priceRows: 166
};
function resolvePrinting(subTypes, want = "Normal") {
  if (!subTypes.length) return null;
  if (subTypes.includes(want)) return { printing: want, fallback: false };
  return { printing: subTypes[0], fallback: true };
}

// src/catalog/printings/pokemon.ts
var pokemon_exports = {};
__export(pokemon_exports, {
  BASE_SET_GROUP_ID: () => BASE_SET_GROUP_ID,
  BASE_SET_SHADOWLESS_GROUP_ID: () => BASE_SET_SHADOWLESS_GROUP_ID,
  EDITIONS: () => EDITIONS,
  FINISHES: () => FINISHES,
  POKEMON_PRINTINGS: () => POKEMON_PRINTINGS,
  defaultPrinting: () => defaultPrinting,
  fallbackChain: () => fallbackChain,
  hasFirstEdition: () => hasFirstEdition,
  isWotcProduct: () => isWotcProduct,
  normNum: () => normNum,
  numMatch: () => numMatch,
  numberTokens: () => numberTokens,
  parseOwned: () => parseOwned,
  resolvePrinting: () => resolvePrinting2,
  wantedPrinting: () => wantedPrinting,
  wantsShadowlessGroup: () => wantsShadowlessGroup
});
var POKEMON_PRINTINGS = [
  "Normal",
  "Holofoil",
  "Reverse Holofoil",
  "1st Edition",
  "1st Edition Holofoil",
  "Unlimited",
  "Unlimited Holofoil"
];
var BASE_SET_GROUP_ID = 604;
var BASE_SET_SHADOWLESS_GROUP_ID = 1663;
var EDITIONS = ["1st Edition", "Shadowless", "Unlimited"];
var FINISHES = ["Reverse Holo", "Rainbow Rare", "Full Art", "Gold", "Holo"];
var TAG_RE = /\b(1st edition|shadowless|unlimited|reverse holo|rainbow rare|full art|holo|gold)\b/gi;
function normNum(s) {
  const v = String(s ?? "").trim().toLowerCase();
  if (!v || v === "unknown") return "";
  const m = v.match(/^0*([a-z]*\d+[a-z]*)\s*\/\s*0*([a-z]*\d+[a-z]*)$/);
  if (m) return `${m[1].replace(/^0+(?=\d)/, "")}/${m[2].replace(/^0+(?=\d)/, "")}`;
  if (!/^[a-z]*\d+[a-z]*$/.test(v)) return "";
  return v.replace(/^0+(?=\d)/, "");
}
function numberTokens(field) {
  const out = [];
  for (const t of String(field ?? "").split(/[\s,]+/)) {
    const n = normNum(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
var numerator = (n) => normNum(n).split("/")[0];
function numMatch(a, b) {
  const na = normNum(a);
  const nb = normNum(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (!na.includes("/") || !nb.includes("/")) && numerator(na) === numerator(nb);
}
function parseOwned(ownedCardNumber) {
  const raw = String(ownedCardNumber ?? "");
  let edition = "";
  let finish = "";
  for (const e of EDITIONS) if (new RegExp(`\\b${e}\\b`, "i").test(raw)) edition = e;
  for (const f of FINISHES) {
    if (new RegExp(`\\b${f}\\b`, "i").test(raw)) {
      finish = f;
      break;
    }
  }
  const number = numberTokens(raw.replace(TAG_RE, " "))[0] ?? "";
  return { number, edition, finish };
}
function isWotcProduct(subTypes) {
  return subTypes.some((s) => /^(1st Edition|Unlimited)/.test(s));
}
function hasFirstEdition(subTypes) {
  return subTypes.some((s) => /^1st Edition/.test(s));
}
function wantsShadowlessGroup(edition, plainProductSubTypes) {
  return edition === "Shadowless" || edition === "1st Edition" && !hasFirstEdition(plainProductSubTypes);
}
function wantedPrinting({ wotc, edition, isHolo, finish }) {
  if (wotc) {
    return edition === "1st Edition" ? isHolo ? "1st Edition Holofoil" : "1st Edition" : isHolo ? "Unlimited Holofoil" : "Unlimited";
  }
  return finish === "Reverse Holo" ? "Reverse Holofoil" : isHolo ? "Holofoil" : "Normal";
}
function fallbackChain(want, subTypes) {
  return [want, want.replace(/ Holofoil$/, ""), "Normal", subTypes[0]].filter(Boolean);
}
function resolvePrinting2(subTypes, opts) {
  const want = wantedPrinting(opts);
  const printing = fallbackChain(want, subTypes).find((s) => subTypes.includes(s)) ?? null;
  if (!printing) return null;
  return { printing, fallback: printing !== want };
}
function defaultPrinting(subTypes) {
  return resolvePrinting2(subTypes, {
    wotc: isWotcProduct(subTypes),
    edition: "",
    isHolo: false,
    finish: ""
  });
}

// src/catalog/index.ts
var GAMES = {
  pokemon: { enabled: true, categoryId: 3, printings: POKEMON_PRINTINGS },
  onepiece: { enabled: false, categoryId: 68, printings: ONEPIECE_PRINTINGS }
};
var INDEX_FILES = [
  MANIFEST_FILE,
  ...INDEX_GAMES.flatMap((g) => [`${g}.json`, `${g}.bin`])
];
function indexFilesFor(games) {
  return [MANIFEST_FILE, ...games.flatMap((g) => [`${g}.json`, `${g}.bin`])];
}
function manifestFor(manifest, games) {
  const keep = new Set(games);
  const filtered = {};
  for (const [game, entry] of Object.entries(manifest.games)) {
    if (keep.has(game)) filtered[game] = entry;
  }
  const lastRun = manifest.lastRun ? {
    ...manifest.lastRun,
    upcoming: manifest.lastRun.upcoming.filter((u) => keep.has(u.game)),
    byGame: Object.fromEntries(
      Object.entries(manifest.lastRun.byGame).filter(([g]) => keep.has(g))
    )
  } : null;
  return {
    ...manifest,
    total: Object.values(filtered).reduce((n, g) => n + g.count, 0),
    games: filtered,
    lastRun
  };
}

exports.CATEGORY_ID = CATEGORY_ID;
exports.FAMILY = FAMILY;
exports.GAMES = GAMES;
exports.INDEX_FILES = INDEX_FILES;
exports.INDEX_GAMES = INDEX_GAMES;
exports.LANGUAGE = LANGUAGE;
exports.OFF_LANGUAGE_PENALTY = OFF_LANGUAGE_PENALTY;
exports.baseCardName = baseCardName;
exports.gamesForHint = gamesForHint;
exports.indexFilesFor = indexFilesFor;
exports.languagePrior = languagePrior;
exports.manifestFor = manifestFor;
exports.onepiecePrintings = onepiece_exports;
exports.pokemonPrintings = pokemon_exports;
exports.variantSuffix = variantSuffix;
//# sourceMappingURL=index.cjs.map
//# sourceMappingURL=index.cjs.map