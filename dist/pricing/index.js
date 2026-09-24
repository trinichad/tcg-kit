// src/pricing/cache.ts
function createMemoryCache(opts = {}) {
  const maxEntries = opts.maxEntries ?? 200;
  const store = /* @__PURE__ */ new Map();
  function evictIfNeeded() {
    if (store.size <= maxEntries) return;
    const byExp = [...store.entries()].sort((a, b) => a[1].exp - b[1].exp);
    for (const [key] of byExp.slice(0, Math.ceil(maxEntries / 5))) store.delete(key);
  }
  return {
    async get(key) {
      const hit = store.get(key);
      if (!hit) return void 0;
      if (hit.exp <= Date.now()) {
        store.delete(key);
        return void 0;
      }
      return hit.value;
    },
    async set(key, value, ttlMs) {
      store.set(key, { exp: Date.now() + ttlMs, value });
      evictIfNeeded();
    }
  };
}
function createCached(store) {
  const inflight = /* @__PURE__ */ new Map();
  return async function cached(key, ttlMs, fn) {
    const hit = await store.get(key);
    if (hit !== void 0) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;
    const p = (async () => {
      try {
        const value = await fn();
        if (value !== null) await store.set(key, value, ttlMs);
        return value;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  };
}

// src/pricing/util.ts
function round2(n) {
  return Math.round(n * 100) / 100;
}
function median(nums) {
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
var sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function createLimiter(max) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= max) await new Promise((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}
function createFetchRetry(fetchImpl) {
  return async function fetchRetry(url, init = {}, retries = 2) {
    const { timeoutMs = 2e4, ...rest } = init;
    for (let attempt = 0; ; attempt++) {
      try {
        const r = await fetchImpl(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
        if ((r.status === 429 || r.status >= 500) && attempt < retries) {
          const retryAfter = Number(r.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1e3 : 600 * (attempt + 1) * (attempt + 1);
          await sleep(Math.min(backoff, 5e3));
          continue;
        }
        return r;
      } catch (err) {
        if (attempt < retries) {
          await sleep(500 * (attempt + 1));
          continue;
        }
        throw err;
      }
    }
  };
}
async function limitMap(items, limit, fn) {
  const results = new Array(items.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = await fn(items[i], i);
      } catch (err) {
        console.error("[limitMap] item failed:", err);
        results[i] = null;
      }
    }
  });
  await Promise.all(workers);
  return results;
}

// src/pricing/context.ts
var DEFAULT_USER_AGENT = "HoloTcgKit/0.1 (+https://holohuntingtcg.com)";
var DEFAULT_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
var SKU_DEFAULT_MIN_INTERVAL_MS = 1200;
var SKU_DEFAULT_COOLDOWN_MS = 8 * 60 * 1e3;
function createContext(config = {}) {
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("tcg-kit/pricing: no fetch available \u2014 pass config.fetch");
  }
  return {
    fetch: fetchImpl,
    fetchRetry: createFetchRetry(fetchImpl),
    cached: createCached(config.cache ?? createMemoryCache()),
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    chromeUserAgent: config.chromeUserAgent ?? DEFAULT_CHROME_USER_AGENT,
    tokens: {
      pricecharting: config.tokens?.pricecharting?.trim() || void 0,
      psa: config.tokens?.psa?.trim() || void 0,
      ebay: config.tokens?.ebay
    },
    sku: {
      minIntervalMs: config.sku?.minIntervalMs ?? SKU_DEFAULT_MIN_INTERVAL_MS,
      cooldownMs: config.sku?.cooldownMs ?? SKU_DEFAULT_COOLDOWN_MS
    },
    // Bound concurrent calls (fetchRetry handles 429/5xx backoff). These
    // endpoints haven't rate-limited in practice, but a full binder page fans
    // out many search/listing/sales calls at once — cap the burst as a safety
    // net. Higher than PriceCharting's cap since this is the high-frequency
    // raw-pricing path.
    limitTcgLive: createLimiter(config.concurrency?.tcglive ?? 6),
    // Politeness gate. PriceCharting returns 429 to a burst of rapid scrapes —
    // a slab-heavy page fires several graded lookups at once, and without this
    // the later ones silently degrade to "set price manually".
    limitPriceCharting: createLimiter(config.concurrency?.pricecharting ?? 2),
    now: config.now ?? Date.now
  };
}

// src/pricing/helpers.ts
function imageUrl(productId, size = "200w") {
  return `https://tcgplayer-cdn.tcgplayer.com/product/${productId}_${size}.jpg`;
}
function toCents(usd) {
  return Math.floor(usd * 100 + 0.5);
}
function fromCents(cents) {
  return cents / 100;
}
function withBuffer(cents, pct) {
  return Math.floor(cents * (1 + pct / 100) + 0.5);
}
function assignTier(valueCents, rules, opts = {}) {
  if (valueCents == null || !Number.isFinite(valueCents)) {
    return { tier: null, nearBoundary: false };
  }
  const tier = rules.find(
    (r) => (r.minCents == null || valueCents >= r.minCents) && (r.maxCents == null || valueCents <= r.maxCents)
  ) ?? null;
  if (!tier) return { tier: null, nearBoundary: false };
  const margin = opts.marginPct ?? 10;
  const near = (bound) => bound != null && Math.abs(valueCents - bound) <= Math.abs(bound) * (margin / 100);
  return { tier, nearBoundary: near(tier.minCents) || near(tier.maxCents) };
}
function confidenceOf(quote) {
  if (quote.source === "tcg_market") return "exact";
  if (quote.source === "graded") return "exact";
  if (quote.source === "sales" && quote.salesUsed >= 2) return "exact";
  if (quote.source === "sales_adj" || quote.source === "scaled" || quote.source === "market_adj") {
    return "estimated";
  }
  return "low";
}

// src/pricing/providers/tcgcsv.ts
var BASE = "https://tcgcsv.com/tcgplayer";
var HOUR = 36e5;
var FALLBACK_CATEGORY = {
  magic: 1,
  yugioh: 2,
  pokemon: 3,
  dragonball: 27,
  // Dragon Ball Super CCG (Masters); Fusion World=80, DBZ=23
  onepiece: 68,
  lorcana: 71
};
var GAME_PATTERNS = {
  pokemon: /^pokemon$/i,
  magic: /^magic/i,
  yugioh: /yugioh|yu-gi-oh/i,
  lorcana: /lorcana/i,
  onepiece: /one piece/i,
  dragonball: /^dragon ball super ccg$/i
};
var normLine = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
function gameForProductLine(line) {
  for (const [game, re] of Object.entries(GAME_PATTERNS)) {
    if (re.test(line)) return game;
  }
  return null;
}
function extValue(product, name) {
  return product.extendedData?.find((d) => d.name === name)?.value ?? "";
}
function normSet(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
}
var real = (n) => n != null && n > 0 && n !== 1e5 ? n : null;
function saneMarketPrice(row) {
  const market = real(row.marketPrice);
  const low = real(row.lowPrice);
  const mid = real(row.midPrice);
  if (market == null) {
    return low != null || mid != null ? { price: mid ?? low, adjusted: true } : { price: null, adjusted: false };
  }
  if (low != null && market < low * 0.5) {
    return { price: mid ?? low, adjusted: true };
  }
  return { price: market, adjusted: false };
}
function createTcgCsv(ctx) {
  async function getJson(url) {
    const r = await ctx.fetch(url, {
      headers: { "user-agent": ctx.userAgent, accept: "application/json" },
      signal: AbortSignal.timeout(2e4)
    });
    if (!r.ok) throw new Error(`tcgcsv ${r.status} for ${url}`);
    return r.json();
  }
  async function getResults(url) {
    const body = await getJson(url);
    return body.results ?? [];
  }
  const categories = () => ctx.cached("csv:categories", 24 * HOUR, () => getResults(`${BASE}/categories`));
  const groups = (categoryId) => ctx.cached(
    `csv:groups:${categoryId}`,
    12 * HOUR,
    () => getResults(`${BASE}/${categoryId}/groups`)
  );
  const products = (categoryId, groupId) => ctx.cached(
    `csv:products:${categoryId}:${groupId}`,
    24 * HOUR,
    () => getResults(`${BASE}/${categoryId}/${groupId}/products`)
  );
  const prices = (categoryId, groupId) => ctx.cached(
    `csv:prices:${categoryId}:${groupId}`,
    4 * HOUR,
    () => getResults(`${BASE}/${categoryId}/${groupId}/prices`)
  );
  async function categoryIdForGame(game) {
    const pattern = GAME_PATTERNS[game];
    if (pattern) {
      try {
        const cats = await categories();
        const hit = cats.find((c) => pattern.test(c.name) || pattern.test(c.displayName ?? ""));
        if (hit) return hit.categoryId;
      } catch {
      }
    }
    return FALLBACK_CATEGORY[game] ?? 0;
  }
  async function categoryIdForLine(line) {
    const want = normLine(line);
    if (!want) return null;
    try {
      const cats = await categories();
      const hit = cats.find((c) => normLine(c.name) === want || normLine(c.displayName ?? "") === want) ?? cats.find(
        (c) => normLine(c.displayName ?? "").includes(want) || want.includes(normLine(c.name))
      );
      return hit?.categoryId ?? null;
    } catch {
      return null;
    }
  }
  async function findGroup(categoryId, setName, setCode) {
    const all = await groups(categoryId);
    const code = (setCode ?? "").trim().toLowerCase();
    if (code) {
      const byCode = all.find((g) => (g.abbreviation ?? "").toLowerCase() === code);
      if (byCode) return byCode;
    }
    const name = normSet(setName ?? "");
    if (!name) return null;
    const exact = all.find((g) => normSet(g.name) === name);
    if (exact) return exact;
    const loose = all.filter((g) => {
      const gn = normSet(g.name);
      return gn.includes(name) || name.includes(gn);
    }).sort((a, b) => a.name.length - b.name.length);
    return loose[0] ?? null;
  }
  async function subTypesFor(categoryId, groupId, productId) {
    const rows = await prices(categoryId, groupId);
    return rows.filter((r) => r.productId === productId).map((r) => ({ name: r.subTypeName, marketPrice: saneMarketPrice(r).price }));
  }
  async function productRow(categoryId, groupId, productId) {
    const rows = await products(categoryId, groupId);
    return rows.find((p) => p.productId === productId) ?? null;
  }
  async function groupPrices(categoryId, groupId) {
    const rows = await prices(categoryId, groupId);
    return rows.map((r) => {
      const sane = saneMarketPrice(r);
      return {
        productId: r.productId,
        subType: r.subTypeName,
        market: sane.price,
        low: real(r.lowPrice),
        mid: real(r.midPrice),
        high: real(r.highPrice),
        adjusted: sane.adjusted
      };
    });
  }
  return {
    categories,
    groups,
    products,
    prices,
    categoryIdForGame,
    categoryIdForLine,
    findGroup,
    subTypesFor,
    productRow,
    groupPrices
  };
}

// src/pricing/providers/tcglive.ts
var MIN = 6e4;
var PRODUCT_LINE = {
  pokemon: ["pokemon"],
  magic: ["magic"],
  yugioh: ["yugioh"],
  lorcana: ["disney lorcana"],
  onepiece: ["one piece card game"],
  dragonball: [
    "dragon ball super ccg",
    "dragon ball super: masters",
    "dragon ball super fusion world",
    "dragon ball super: fusion world",
    "dragon ball z tcg"
  ],
  sports: []
  // not on TCGplayer — priced via sportscardspro.com instead
};
function linesFor(game, language) {
  if (!game) return void 0;
  const lines = [...PRODUCT_LINE[game] ?? []];
  if (game === "pokemon" && language && /japan/i.test(language)) lines.push("pokemon japan");
  return lines.length ? lines : void 0;
}
function sellerText(c) {
  return [c?.title, c?.description].filter(Boolean).join(" ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}
function createTcgLive(ctx) {
  const headers = (extra = {}) => ({
    "user-agent": ctx.chromeUserAgent,
    accept: "application/json",
    origin: "https://www.tcgplayer.com",
    referer: "https://www.tcgplayer.com/",
    ...extra
  });
  async function postJson(url, body) {
    return ctx.limitTcgLive(async () => {
      try {
        const r = await ctx.fetchRetry(url, {
          method: "POST",
          headers: headers({ "content-type": "application/json" }),
          body: JSON.stringify(body)
        });
        if (!r.ok) {
          console.error(`[tcglive] ${r.status} from ${url}`);
          return null;
        }
        return await r.json();
      } catch (err) {
        console.error(`[tcglive] request failed: ${url}`, err);
        return null;
      }
    });
  }
  async function rawSearch(q, lines, size) {
    const url = `https://mp-search-api.tcgplayer.com/v1/search/request?q=${encodeURIComponent(q)}&isList=false`;
    const filters = { term: {}, range: {}, match: {} };
    if (lines?.length) filters.term.productLineName = lines;
    const body = {
      algorithm: "revenue_synonym_v2",
      from: 0,
      size,
      filters,
      listingSearch: {
        context: { cart: {} },
        filters: {
          term: { sellerStatus: "Live", channelId: 0 },
          range: { quantity: { gte: 1 } },
          exclude: { channelExclusion: 0 }
        }
      },
      context: { cart: {}, shippingCountry: "US" },
      settings: { useFuzzySearch: true, didYouMean: {} },
      sort: {}
    };
    const resp = await postJson(url, body);
    if (!resp) return null;
    return resp.results?.[0]?.results ?? [];
  }
  async function searchProducts(q, lines, size = 12) {
    const key = `search:${lines?.join("|") ?? "all"}:${size}:${q.toLowerCase()}`;
    return ctx.cached(key, 5 * MIN, async () => {
      let raw = await rawSearch(q, lines, size);
      if (raw === null) return null;
      if (raw.length === 0 && lines?.length) raw = await rawSearch(q, void 0, size) ?? [];
      return raw.filter((h) => typeof h.productId === "number").map((h) => ({
        productId: h.productId,
        productName: h.productName ?? "",
        setName: h.setName ?? "",
        setCode: h.setCode ?? "",
        setId: typeof h.setId === "number" ? h.setId : null,
        productLineName: h.productLineName ?? "",
        rarityName: h.rarityName ?? "",
        number: h.customAttributes?.number ?? "",
        marketPrice: typeof h.marketPrice === "number" ? h.marketPrice : null,
        lowestPrice: typeof h.lowestPrice === "number" ? h.lowestPrice : null,
        sealed: h.sealed === true
      }));
    });
  }
  async function currentListings(productId) {
    return ctx.cached(`listings:${productId}`, 10 * MIN, async () => {
      const page = (from) => postJson(
        `https://mp-search-api.tcgplayer.com/v1/product/${productId}/listings`,
        {
          filters: {
            term: { sellerStatus: "Live", channelId: 0 },
            range: { quantity: { gte: 1 } },
            exclude: { channelExclusion: 0 }
          },
          from,
          size: 50,
          sort: { field: "price+shipping", order: "asc" },
          context: { shippingCountry: "US", cart: {} }
        }
      );
      const first = await page(0);
      if (!first) return null;
      const head = first.results?.[0];
      let raw = head?.results ?? [];
      if (raw.length === 50 && (head?.totalResults ?? 0) > 50) {
        const second = await page(50);
        raw = raw.concat(second?.results?.[0]?.results ?? []);
      }
      return raw.filter((l) => typeof l.price === "number").map((l) => ({
        price: l.price,
        shipping: typeof l.shippingPrice === "number" ? l.shippingPrice : null,
        condition: l.condition ?? "",
        variant: l.printing ?? "",
        quantity: l.quantity ?? 1,
        custom: l.listingType === "custom",
        title: l.listingType === "custom" ? sellerText(l.customData) : ""
      }));
    });
  }
  async function latestSales(productId, conditionId) {
    return ctx.cached(`sales:${productId}:${conditionId ?? "all"}`, 10 * MIN, async () => {
      const resp = await postJson(
        `https://mpapi.tcgplayer.com/v2/product/${productId}/latestsales?mpfev=3000`,
        {
          conditions: conditionId ? [conditionId] : [],
          languages: [],
          variants: [],
          listingType: "All",
          offset: 0,
          limit: 25
        }
      );
      if (!resp) return null;
      return (resp.data ?? []).filter((s) => typeof s.purchasePrice === "number").map((s) => ({
        date: s.orderDate ?? "",
        price: s.purchasePrice,
        condition: s.condition ?? "",
        variant: s.variant ?? "",
        custom: s.listingType === "ListingWithPhotos",
        title: s.listingType === "ListingWithPhotos" ? (s.title ?? "").slice(0, 200) : ""
      }));
    });
  }
  return { headers, searchProducts, currentListings, latestSales };
}

// src/pricing/match.ts
var KNOWN_GAMES = ["pokemon", "magic", "yugioh", "lorcana", "onepiece", "dragonball"];
var cdnImage = (productId) => imageUrl(productId, "200w");
var productUrl = (productId) => `https://www.tcgplayer.com/product/${productId}`;
var r3 = (n) => Math.round(n * 1e3) / 1e3;
function normText(s) {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9\s/]+/g, " ").replace(/\s+/g, " ").trim();
}
function tokenSet(s) {
  return new Set(normText(s).split(" ").filter(Boolean));
}
function nameSim(a, b) {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const A = tokenSet(a);
  const B = tokenSet(b);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const dice = 2 * inter / (A.size + B.size);
  const contains = na.includes(nb) || nb.includes(na) ? 0.85 : 0;
  const ja = na.replace(/[\s/]+/g, "");
  const jb = nb.replace(/[\s/]+/g, "");
  const squashed = Math.min(ja.length, jb.length) >= 5 && (ja.includes(jb) || jb.includes(ja)) ? 0.85 : 0;
  return Math.max(dice, contains, squashed);
}
function normNumber(n) {
  return n.toLowerCase().replace(/\s+/g, "").replace(/\d+/g, (d) => String(parseInt(d, 10)));
}
function normNum(s) {
  const v = normNumber(String(s ?? "").trim());
  if (!v || v === "unknown") return "";
  const m = v.match(/^([a-z]*\d+[a-z]*)\/([a-z]*\d+[a-z]*)$/);
  if (m) return `${m[1]}/${m[2]}`;
  return /^[a-z]*\d+[a-z]*$/.test(v) ? v : "";
}
function numberTokens(field) {
  const out = [];
  for (const t of String(field ?? "").split(/[\s,]+/)) {
    const n = normNum(t);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}
function numberTotal(n) {
  const parts = normNumber(n).split("/");
  return parts.length > 1 ? parts[1] : "";
}
var numerator = (n) => normNum(n).split("/")[0];
function numMatch(a, b) {
  const na = normNum(a);
  const nb = normNum(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return (!na.includes("/") || !nb.includes("/")) && numerator(na) === numerator(nb);
}
function numberingOk(a, b) {
  const ta = numberTotal(a);
  const tb = numberTotal(b);
  return !(ta && tb && ta !== tb);
}
var stripRegion = (n) => n.replace(/^([a-z]{2,6})-?(?:en|jp|ja|kr|ae|au|e|f|g|i|s|p)-?(\d)/, "$1-$2");
function numberScore(a, b) {
  const na = normNumber(a);
  const nb = normNumber(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (stripRegion(na) === stripRegion(nb)) return 0.9;
  const la = na.split("/")[0];
  const lb = nb.split("/")[0];
  if (la && la === lb) {
    return numberingOk(a, b) ? 0.85 : 0.4;
  }
  if (na.includes(nb) || nb.includes(na)) return 0.6;
  return 0;
}
function splitProductName(productName) {
  const m = productName.match(/^(.*?)\s+-\s+([^()]*\d[^()]*?)\s*(\(.*\))?\s*$/);
  if (m) return { name: [m[1], m[3]].filter(Boolean).join(" ").trim(), number: m[2].trim() };
  return { name: productName, number: "" };
}
var ART_VARIANT = /(special )?alternate art|manga|parallel|full art|secret|\bsp\b/i;
function scoreMatch(card, m) {
  const n = nameSim(card.name, m.name);
  const parts = [{ w: 0.5, s: n }];
  if (card.number) parts.push({ w: 0.35, s: numberScore(card.number, m.number) });
  let setSim = 0;
  if (card.setName || card.setCode) {
    const qCode = card.setCode ? normText(card.setCode).replace(/\s+/g, "") : "";
    const gCode = m.groupCode ? normText(m.groupCode).replace(/\s+/g, "") : "";
    const qBare = qCode.replace(/(en|jp|jpn|kr|fr|de|it|es|pt|zh|tc|sc)$/, "");
    const codeHit = !!qCode && !!gCode && (qCode === gCode || qBare === gCode || gCode.includes(qCode));
    setSim = Math.max(card.setName ? nameSim(card.setName, m.groupName) : 0, codeHit ? 1 : 0);
    parts.push({ w: 0.15, s: setSim });
  }
  const totalW = parts.reduce((a, p) => a + p.w, 0);
  let score = parts.reduce((a, p) => a + p.w * p.s, 0) / totalW;
  if (/jumbo|world championship|oversize/i.test(m.groupName) && setSim < 0.8) score *= 0.75;
  const wantsVariant = ART_VARIANT.test(card.printing ?? "");
  const isVariant = ART_VARIANT.test(m.name);
  if (wantsVariant !== isVariant) score -= 0.07;
  else if (wantsVariant && isVariant) score += 0.05;
  const wantsEarlyPrint = /1st ed|first ed|shadowless/i.test(
    `${card.printing ?? ""} ${card.setName ?? ""}`
  );
  if (wantsEarlyPrint && m.subTypes.some((s) => /1st ed|shadowless/i.test(s.name))) {
    score += 0.08;
  }
  return { score, setSim };
}
var VINTAGE_GROUP_NAMES = [
  "Base Set",
  "Base Set (Shadowless)",
  "Base Set 2",
  "Jungle",
  "Fossil",
  "Team Rocket",
  "Gym Heroes",
  "Gym Challenge",
  "Neo Genesis",
  "Neo Discovery",
  "Neo Revelation",
  "Neo Destiny",
  "Legendary Collection"
];
var VINTAGE_GROUP_SET = new Set(VINTAGE_GROUP_NAMES.map(normText));
var VINTAGE_TOTALS = /* @__PURE__ */ new Set(["64", "62", "102", "110", "111", "130", "132", "75", "66", "105", "109"]);
function looksVintage(card) {
  if (VINTAGE_TOTALS.has(numberTotal(card.number ?? ""))) return true;
  return /base set|jungle|fossil|team rocket|gym (heroes|challenge)|neo |legendary collection|shadowless/i.test(
    card.setName ?? ""
  );
}
function createMatch(_ctx, deps) {
  const { csv, live } = deps;
  async function catalogNameCandidates(card, categoryId) {
    let all;
    try {
      all = await csv.groups(categoryId);
    } catch {
      return [];
    }
    const targets = all.filter((g) => VINTAGE_GROUP_SET.has(normText(g.name)));
    const perGroup = await Promise.all(
      targets.map(async (g) => {
        let prods;
        try {
          prods = await csv.products(categoryId, g.groupId);
        } catch {
          return [];
        }
        const named = prods.map((p) => ({ p, s: nameSim(card.name, p.name) })).filter((x) => x.s >= 0.8).sort((a, b) => b.s - a.s).slice(0, 2);
        if (!named.length) return [];
        let priceRows = [];
        try {
          priceRows = await csv.prices(categoryId, g.groupId);
        } catch {
        }
        return named.map(({ p }) => {
          const subs = priceRows.filter((r) => r.productId === p.productId).map((r) => ({ name: r.subTypeName, marketPrice: saneMarketPrice(r).price }));
          return {
            productId: p.productId,
            name: p.name,
            categoryId,
            groupId: g.groupId,
            groupName: g.name,
            groupCode: g.abbreviation,
            number: extValue(p, "Number"),
            rarity: extValue(p, "Rarity"),
            imageUrl: p.imageUrl || cdnImage(p.productId),
            url: p.url || productUrl(p.productId),
            subTypes: subs.length ? subs : [{ name: "Market", marketPrice: null }],
            score: 0
          };
        });
      })
    );
    return perGroup.flat();
  }
  async function gatherHits(card, game) {
    const lines = linesFor(game, card.language);
    const queries = [[card.name, card.number].filter(Boolean).join(" ")];
    if (card.setName) queries.push(`${card.name} ${card.setName}`);
    else if (card.number) queries.push(card.name);
    let sawSuccess = false;
    const merged = /* @__PURE__ */ new Map();
    for (const q of queries) {
      const hits = await live.searchProducts(q, lines, 12);
      if (hits === null) continue;
      sawSuccess = true;
      for (const h of hits) if (!merged.has(h.productId)) merged.set(h.productId, h);
    }
    return sawSuccess ? [...merged.values()] : null;
  }
  async function lightMatch(hit, score) {
    const categoryId = await csv.categoryIdForLine(hit.productLineName);
    const split = splitProductName(hit.productName);
    return {
      productId: hit.productId,
      name: split.name || hit.productName,
      categoryId,
      groupId: null,
      groupName: hit.setName,
      groupCode: hit.setCode || void 0,
      number: hit.number || split.number,
      rarity: hit.rarityName,
      imageUrl: cdnImage(hit.productId),
      url: productUrl(hit.productId),
      subTypes: [{ name: "Market", marketPrice: hit.marketPrice }],
      score: r3(score)
    };
  }
  async function enrichMatch(light, setCode, setIdHint) {
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
        number: row ? extValue(row, "Number") || light.number : light.number,
        rarity: row ? extValue(row, "Rarity") || light.rarity : light.rarity
      };
    } catch (err) {
      console.error("[match] enrich failed for", light.productId, err);
      return light;
    }
  }
  async function catalogResolve(card, game) {
    const categoryId = await csv.categoryIdForGame(game);
    const group = await csv.findGroup(categoryId, card.setName, card.setCode);
    if (!group) return null;
    const prods = await csv.products(categoryId, group.groupId);
    const scored = prods.map((p) => {
      const num2 = extValue(p, "Number");
      const parts = [{ w: 0.55, s: nameSim(card.name, p.name) }];
      if (card.number) parts.push({ w: 0.45, s: numberScore(card.number, num2) });
      const totalW = parts.reduce((a, x) => a + x.w, 0);
      return { p, num: num2, score: parts.reduce((a, x) => a + x.w * x.s, 0) / totalW };
    }).sort((a, b) => b.score - a.score).slice(0, 4);
    if (!scored.length || scored[0].score < 0.5) return null;
    const candidates = [];
    for (const { p, num: num2, score } of scored) {
      candidates.push({
        productId: p.productId,
        name: p.name,
        categoryId,
        groupId: group.groupId,
        groupName: group.name,
        groupCode: group.abbreviation,
        number: num2,
        rarity: extValue(p, "Rarity"),
        imageUrl: p.imageUrl || cdnImage(p.productId),
        url: p.url || productUrl(p.productId),
        subTypes: await csv.subTypesFor(categoryId, group.groupId, p.productId),
        score: r3(score)
      });
    }
    return {
      cell: card.cell ?? 0,
      status: scored[0].score >= 0.75 ? "matched" : "uncertain",
      best: candidates[0],
      candidates,
      note: "matched via set catalog (search unavailable)"
    };
  }
  async function resolveCard(card) {
    const game = KNOWN_GAMES.includes(card.game) ? card.game : void 0;
    const none = (note) => ({
      cell: card.cell ?? 0,
      status: "none",
      best: null,
      candidates: [],
      note
    });
    if (!card.name?.trim()) return none("no card name to search for");
    if (card.game === "sports") return none("sports card \u2014 priced from eBay sold listings");
    const hits = await gatherHits(card, game);
    const searchHits = (hits ?? []).filter((h) => !h.sealed);
    const nameOk = (productName) => Math.max(
      nameSim(card.name, productName),
      nameSim(card.name, splitProductName(productName).name)
    ) >= 0.5;
    const hitMeta = /* @__PURE__ */ new Map();
    const searchMatches = await Promise.all(
      searchHits.filter((h) => nameOk(h.productName)).map(async (h) => {
        const m = await lightMatch(h, 0);
        hitMeta.set(m.productId, { setCode: h.setCode, setId: h.setId });
        return m;
      })
    );
    let catalogMatches = [];
    if (card.game === "pokemon" && looksVintage(card)) {
      catalogMatches = await catalogNameCandidates(card, await csv.categoryIdForGame("pokemon"));
    }
    const byId = /* @__PURE__ */ new Map();
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
        hits === null ? "TCGplayer search is unavailable right now \u2014 retry, or search manually" : "no matching cards found \u2014 try manual search"
      );
    }
    const scored = pool.map((m) => ({ m, ...scoreMatch(card, m) })).sort((a, b) => b.score - a.score).slice(0, 5);
    const top = scored[0];
    const meta = hitMeta.get(top.m.productId);
    const best = top.m.groupId != null ? { ...top.m, score: r3(top.score) } : {
      ...await enrichMatch(top.m, meta?.setCode ?? card.setCode, meta?.setId),
      score: r3(top.score)
    };
    const candidates = [best, ...scored.slice(1).map((x) => ({ ...x.m, score: r3(x.score) }))];
    const s0 = scored[0].score;
    const s1 = scored[1]?.score ?? 0;
    const setProvided = Boolean(card.setName || card.setCode);
    const setAgrees = !setProvided || scored[0].setSim >= 0.5;
    const numbersOk = numberingOk(card.number ?? "", scored[0].m.number);
    const strongSet = setProvided && scored[0].setSim >= 0.8;
    const matched = s0 >= 0.78 && setAgrees && numbersOk && (strongSet || s0 - s1 >= 0.08 || s1 < 0.7);
    return {
      cell: card.cell ?? 0,
      status: matched ? "matched" : "uncertain",
      best,
      candidates
    };
  }
  async function matchFromGroup(productId, categoryId, groupId) {
    const row = await csv.productRow(categoryId, groupId, productId);
    if (!row) return null;
    const group = (await csv.groups(categoryId)).find((g) => g.groupId === groupId);
    const subTypes = await csv.subTypesFor(categoryId, groupId, productId);
    const split = splitProductName(row.name);
    return {
      productId,
      name: split.name || row.cleanName || row.name,
      categoryId,
      groupId,
      groupName: group?.name ?? "",
      groupCode: group?.abbreviation || void 0,
      number: extValue(row, "Number") || split.number,
      rarity: extValue(row, "Rarity"),
      imageUrl: row.imageUrl || cdnImage(productId),
      url: row.url || productUrl(productId),
      subTypes: subTypes.length ? subTypes : [{ name: "Market", marketPrice: null }],
      score: 1
    };
  }
  async function matchFromProductId(productId, slug) {
    if (!slug) return null;
    const hits = await live.searchProducts(slug.replace(/-/g, " "), void 0, 24);
    const hit = hits?.find((h) => h.productId === productId);
    if (!hit) return null;
    return enrichMatch(await lightMatch(hit, 1), hit.setCode, hit.setId);
  }
  async function manualSearch(q, game) {
    const urlMatch = q.match(/product\/(\d+)(?:\/([a-z0-9-]+))?/i);
    if (urlMatch) {
      const byId = await matchFromProductId(Number(urlMatch[1]), urlMatch[2]);
      if (byId) return { results: [byId] };
      return { results: [], note: "Could not look up that product link \u2014 try searching by name." };
    }
    const tokens = q.split(/\s+/).filter(Boolean);
    const isNumTok = (t) => /\d/.test(t) && /^[a-z]{0,4}\d[\w/-]*$/i.test(t);
    const name = tokens.filter((t) => !isNumTok(t)).join(" ");
    const number = tokens.filter(isNumTok).join(" ");
    const lines = linesFor(game);
    const queries = [q];
    if (name && name !== q) queries.push(name);
    const merged = /* @__PURE__ */ new Map();
    let reachable = false;
    for (const query of queries) {
      const hits = await live.searchProducts(query, lines, 20);
      if (hits === null) continue;
      reachable = true;
      for (const h of hits) if (!h.sealed && !merged.has(h.productId)) merged.set(h.productId, h);
    }
    if (!reachable) return { results: [], note: "TCGplayer search is unavailable right now." };
    let pool = [...merged.values()];
    if (name) {
      pool = pool.map((h) => {
        const nm = nameSim(name, splitProductName(h.productName).name || h.productName);
        const num2 = number ? numberScore(number, h.number) : 0;
        return { h, score: 0.7 * nm + 0.3 * num2 };
      }).sort((a, b) => b.score - a.score).map((s) => s.h);
    }
    const results = await Promise.all(pool.slice(0, 10).map((h) => lightMatch(h, 0)));
    return { results };
  }
  return { resolveCard, manualSearch, enrichMatch, lightMatch, matchFromGroup };
}

// src/pricing/providers/pricecharting.ts
var HOUR2 = 36e5;
var HOST_URL = {
  tcg: "https://www.pricecharting.com",
  sports: "https://www.sportscardspro.com"
};
var BUCKETS = [
  ["used_price", "Ungraded"],
  ["complete_price", "Grade 7"],
  ["new_price", "Grade 8"],
  ["graded_price", "Grade 9"],
  ["box_only_price", "Grade 9.5"],
  ["manual_only_price", "PSA 10"]
];
var money = (s) => {
  const n = parseFloat(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
var unescapeHtml = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
function parseGrades(html) {
  const grades = {};
  for (const [id, label] of BUCKETS) {
    const m = html.match(
      new RegExp(`id="${id}"[\\s\\S]{0,300}?class="price js-price"[^>]*>\\s*([^<]+)`)
    );
    const value = m && money(m[1]);
    if (value != null && grades[label] == null) grades[label] = value;
  }
  for (const m of html.matchAll(
    /<t[dh][^>]*>\s*((?:PSA|BGS|CGC|SGC|TAG)\s?10|Grade\s?[\d.]+)\s*<\/t[dh]>[\s\S]{0,220}?(?:class="price js-price[^"]*"[^>]*>\s*([^<]+)|<\/tr>)/g
  )) {
    const label = m[1].replace(/\s+/g, " ").trim();
    const value = m[2] ? money(m[2]) : null;
    if (value != null && grades[label] == null) grades[label] = value;
  }
  return grades;
}
function parseSales(html) {
  const labelByBucket = /* @__PURE__ */ new Map();
  for (const m of html.matchAll(/<option value="completed-auctions-([a-z-]+)">\s*([^<(]+?)\s*\(\d+\)/g)) {
    labelByBucket.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  const out = {};
  for (const sec of html.matchAll(/<div class="completed-auctions-([a-z-]+)"[\s\S]*?<\/table>/g)) {
    const label = labelByBucket.get(sec[1]);
    if (!label || out[label]) continue;
    const rows = [];
    for (const r of sec[0].matchAll(
      /<td class="date">([\d-]+)<\/td>[\s\S]*?<a[^>]*class="js-(\w+)-completed-sale"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?class="js-price"[^>]*>\s*([^<]+)/g
    )) {
      const price = money(r[5]);
      if (price == null) continue;
      rows.push({
        date: r[1],
        source: r[2].toLowerCase(),
        url: r[3] ? unescapeHtml(r[3]) : void 0,
        title: unescapeHtml(r[4].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(),
        price
      });
      if (rows.length >= 12) break;
    }
    if (rows.length) out[label] = rows;
  }
  return out;
}
var VARIANT_WORDS = ["shadowless", "1st edition", "first edition", "reverse", "holo", "promo", "delta", "staff", "jumbo", "error", "japanese", "korean", "chinese", "alternate art", "manga", "sp"];
var STRICT_WORDS = ["shadowless", "edition", "japanese", "korean", "chinese"];
function scorePcHit(query, hit) {
  const segs = hit.productSlug.split("-").filter(Boolean);
  const lastSeg = segs.pop() ?? "";
  const prevSeg = segs[segs.length - 1] ?? "";
  const slugNumber = /\d/.test(lastSeg) ? lastSeg : "";
  const slugNumbers = slugNumber ? [slugNumber] : [];
  if (slugNumber && /^[a-z]{1,5}\d{1,3}$/.test(prevSeg)) {
    slugNumbers.push(`${prevSeg}-${slugNumber}`);
  }
  const hitName = slugNumbers.length ? hit.productName.replace(
    new RegExp(`\\s*${slugNumbers[slugNumbers.length - 1].replace("-", "\\s*")}\\s*$`, "i"),
    ""
  ) : hit.productName;
  let score = 0.55 * nameSim(query.name, hitName);
  if (query.number) {
    const qNum = normNumber(query.number).split("/")[0];
    let numCredit = 0;
    for (const sn of slugNumbers) {
      const sNum = normNumber(sn);
      if (!qNum || !sNum) continue;
      if (sNum === qNum) numCredit = Math.max(numCredit, 0.25);
      else if (qNum.replace(/[a-z]/g, "") === sNum.replace(/[a-z]/g, "") && qNum.replace(/[a-z]/g, "")) {
        numCredit = Math.max(numCredit, 0.15);
      }
    }
    score += numCredit;
  }
  let setSim = 0;
  if (query.setName) {
    setSim = nameSim(query.setName, hit.setName);
    score += 0.12 * setSim;
    if (setSim < 0.25) score -= 0.15;
  }
  let wanted = `${query.variant ?? ""} ${query.setName ?? ""}`.toLowerCase();
  if (/1st edition|first edition/.test(wanted)) wanted = wanted.replace(/shadowless/g, "");
  if (/\bsp\b|special\s*(?:alt|art)/.test(wanted)) {
    wanted = wanted.replace(/alternate art|alt art/g, " ") + " sp";
  }
  const hitText = `${hit.setName} ${hit.productName}`.toLowerCase().replace(/\balt art\b/g, "alternate art");
  const has = (text, w) => w === "sp" ? /(?:^|[^a-z])sp(?:[^a-z]|$)/.test(text) : text.includes(w);
  for (const word of VARIANT_WORDS) {
    const wantIt = has(wanted, word.replace("first", "1st")) || has(wanted, word);
    const hasIt = has(hitText, word);
    if (wantIt && hasIt) score += 0.1;
    else if (wantIt !== hasIt && STRICT_WORDS.some((s) => word.includes(s))) score -= 0.18;
  }
  const ART_MARKERS = ["sp", "alternate art", "manga", "parallel", "full art", "secret"];
  const wantsArt = ART_MARKERS.some((w) => has(wanted, w));
  const hitArt = ART_MARKERS.some((w) => has(hitText, w));
  if (!wantsArt && hitArt) score -= 0.08;
  return score;
}
function gradeLabelFor(grader, grade, grades) {
  const g = grader.toUpperCase();
  const n = parseFloat(grade);
  if (!Number.isFinite(n)) return null;
  if (n === 10) {
    const exact = `${g} 10`;
    if (grades[exact] != null) return { label: exact };
    if (grades["PSA 10"] != null) return { label: "PSA 10", note: `${g} 10 priced at the PSA 10 value` };
    return null;
  }
  const tryLabels = (v) => [`Grade ${v}`, `Grade ${v.toFixed(1)}`];
  for (const label of tryLabels(n)) if (grades[label] != null) return { label };
  for (let v = Math.floor(n * 2) / 2; v >= 1; v -= 0.5) {
    for (const label of tryLabels(v)) {
      if (grades[label] != null) {
        return { label, note: `no ${grader} ${grade} value \u2014 using ${label}` };
      }
    }
  }
  return null;
}
var API_GRADE_KEYS = [
  ["loose-price", "Ungraded"],
  ["cib-price", "Grade 7"],
  ["new-price", "Grade 8"],
  ["graded-price", "Grade 9"],
  ["box-only-price", "Grade 9.5"],
  ["manual-only-price", "PSA 10"],
  ["bgs-10-price", "BGS 10"],
  ["condition-17-price", "CGC 10"],
  ["condition-18-price", "SGC 10"]
];
function createPriceCharting(ctx) {
  async function getHtml(url) {
    return ctx.limitPriceCharting(async () => {
      try {
        const r = await ctx.fetchRetry(url, {
          headers: { "user-agent": ctx.userAgent, accept: "text/html" }
        });
        if (!r.ok) {
          console.error(`[pricecharting] ${r.status} for ${url}`);
          return null;
        }
        return await r.text();
      } catch (err) {
        console.error(`[pricecharting] fetch failed: ${url}`, err);
        return null;
      }
    });
  }
  async function pcSearch(q, host = "tcg") {
    const base = HOST_URL[host];
    return ctx.cached(`pc:search:${host}:${q.toLowerCase()}`, 6 * HOUR2, async () => {
      const html = await getHtml(`${base}/search-products?q=${encodeURIComponent(q)}&type=prices`);
      if (html === null) return null;
      const seen = /* @__PURE__ */ new Set();
      const hits = [];
      for (const m of html.matchAll(/href="(?:https:\/\/www\.(?:pricecharting|sportscardspro)\.com)?(\/game\/([\w%.-]+)\/([\w%.-]+))"/g)) {
        if (seen.has(m[1])) continue;
        seen.add(m[1]);
        hits.push({
          url: `${base}${m[1]}`,
          setSlug: m[2],
          productSlug: m[3],
          setName: decodeURIComponent(m[2]).replace(/-/g, " "),
          productName: decodeURIComponent(m[3]).replace(/-/g, " ")
        });
        if (hits.length >= 25) break;
      }
      return hits;
    });
  }
  async function pcData(productUrl2) {
    return ctx.cached(`pc:data:${productUrl2}`, 6 * HOUR2, async () => {
      const html = await getHtml(productUrl2);
      if (html === null) return null;
      return { url: productUrl2, grades: parseGrades(html), sales: parseSales(html) };
    });
  }
  async function pcPrices(productUrl2) {
    const data = await pcData(productUrl2);
    return data && { url: data.url, grades: data.grades };
  }
  async function findPcProduct(query, host = "tcg") {
    const v = (query.variant ?? "").toLowerCase();
    const rarity = /\bsp\b|special\s*(?:alt|art)/.test(v) ? "sp" : /alternate art|alt art/.test(v) ? "alternate art" : /manga/.test(v) ? "manga" : "";
    const variantWords = host === "sports" ? (query.variant ?? "").replace(/\b(normal|base|unlimited)\b/gi, "").trim() : [
      ...(query.variant ?? "").match(/japanese|korean|chinese|vietnamese/gi) ?? [],
      .../1st edition|first edition/i.test(query.variant ?? "") ? ["1st edition"] : [],
      rarity
    ].filter(Boolean).join(" ");
    const q = [query.name, variantWords, query.number?.split("/")[0], query.setName].filter(Boolean).join(" ");
    let hits = await pcSearch(q, host);
    if (hits && hits.length === 0) {
      hits = await pcSearch([query.name, query.setName].filter(Boolean).join(" "), host);
    }
    if (!hits || hits.length === 0) return null;
    const segs = (h) => h.productSlug.split("-").filter(Boolean).length;
    const scored = hits.map((hit) => ({ hit, score: scorePcHit(query, hit) })).sort((a, b) => b.score - a.score || segs(a.hit) - segs(b.hit));
    return scored[0].score >= 0.45 ? scored[0].hit : null;
  }
  async function pcApiData(query, host, tokenOverride) {
    const token = (tokenOverride ?? "").trim() || (ctx.tokens.pricecharting ?? "").trim();
    if (!token) return null;
    const q = [query.name, query.variant, query.number?.split("/")[0], query.setName].filter(Boolean).join(" ");
    const key = `pc:api:${host}:${q.toLowerCase()}`;
    return ctx.cached(key, 6 * HOUR2, async () => {
      try {
        const r = await ctx.fetch(
          `https://www.pricecharting.com/api/product?t=${encodeURIComponent(token)}&q=${encodeURIComponent(q)}`,
          {
            headers: { "user-agent": ctx.userAgent, accept: "application/json" },
            signal: AbortSignal.timeout(2e4)
          }
        );
        if (!r.ok) {
          console.error(`[pricecharting] api ${r.status}`);
          return null;
        }
        const data = await r.json();
        if (data.status === "error" || !data["product-name"]) return null;
        if (nameSim(query.name, String(data["product-name"])) < 0.5) return null;
        const grades = {};
        for (const [k, label] of API_GRADE_KEYS) {
          const cents = Number(data[k]);
          if (Number.isFinite(cents) && cents > 0) grades[label] = Math.round(cents) / 100;
        }
        if (!Object.keys(grades).length) return null;
        const url = `${HOST_URL[host]}/search-products?q=${encodeURIComponent(q)}&type=prices`;
        return { url, grades, sales: {} };
      } catch (err) {
        console.error("[pricecharting] api request failed", err);
        return null;
      }
    });
  }
  const hasToken = (override) => Boolean((override ?? "").trim() || (ctx.tokens.pricecharting ?? "").trim());
  return { pcSearch, pcData, pcPrices, findPcProduct, pcApiData, hasToken };
}

// src/pricing/graded.ts
function createGradedPricer(_ctx, deps) {
  const { pc, psa: psaApi, ebay } = deps;
  async function priceGraded(q) {
    const name = (q.name ?? "").trim();
    if (!name) throw new Error("priceGraded: name required");
    const grader = (q.grader ?? "").trim().toUpperCase() || "RAW";
    let grade = (q.grade ?? "").trim();
    const lockGrade = q.lockGrade === true;
    const host = (q.game ?? "").trim().toLowerCase() === "sports" ? "sports" : "tcg";
    let psa = null;
    let note;
    const cert = (q.cert ?? "").trim();
    if (grader === "PSA") {
      let error = void 0;
      if (q.psa && typeof q.psa.subject === "string" && q.psa.subject) psa = q.psa;
      const clientError = q.psaError;
      if (!psa && clientError) error = clientError;
      if (!psa && !clientError && cert) {
        const userToken = (q.psaToken ?? "").trim();
        const hadToken = psaApi.hasToken(userToken);
        ({ psa, error } = await psaApi.psaCertDetailed(cert, userToken || void 0));
        if (!hadToken) error = void 0;
      }
      if (psa?.grade && psa.grade !== grade) {
        if (lockGrade) {
          note = `heads up: PSA cert ${psa.cert} is graded ${psa.gradeDescription}`;
        } else {
          note = `grade corrected to ${psa.gradeDescription} per PSA cert ${psa.cert}`;
          grade = psa.grade;
        }
      } else if (!psa && cert && error) {
        note = error === "quota" ? `PSA daily call limit reached \u2014 cert ${cert} not verified this time; priced from the label read` : error === "auth" ? "PSA rejected the token \u2014 re-check it in Settings; priced from the label read" : error === "notfound" ? `PSA has no record of cert ${cert} \u2014 double-check the cert number` : `couldn't reach PSA to verify cert ${cert} \u2014 priced from the label read`;
      }
    }
    const empty = {
      productId: 0,
      subType: grader === "RAW" ? "Raw" : `${grader} ${grade}`,
      condition: "NM",
      price: null,
      source: "none",
      estimated: false,
      salesUsed: 0,
      marketPrice: null,
      sales: [],
      url: "",
      psa: psa ?? void 0
    };
    const pickNumber = psa?.cardNumber || (q.number ?? "").trim();
    const query = {
      // PSA's record is authoritative for who/what the card is; keep the
      // AI-read set name for context (PSA's brand strings are terse).
      name: psa ? psa.subject.replace(/[/]+/g, " ") : name,
      setName: (q.setName ?? "").trim() || void 0,
      number: pickNumber || void 0,
      variant: [(q.variant ?? "").trim(), psa?.variety ?? "", psa?.year ?? ""].filter(Boolean).join(" ") || void 0
    };
    const pcToken = (q.pcToken ?? "").trim();
    const tryEbay = async () => {
      const g = grader !== "RAW" ? `${grader} ${grade}` : "";
      const coreNum = (pickNumber || "").split("/")[0];
      const plainSet = (query.setName ?? "").replace(/^[A-Z0-9]{2,6}\s*[:\-–]\s*/i, "").replace(/\s*\(.*?\)\s*/g, " ").trim();
      const asks = (coreNum ? await ebay.ebayAsks([query.name, coreNum, g].filter(Boolean).join(" ")) : null) ?? (plainSet ? await ebay.ebayAsks([query.name, plainSet, g].filter(Boolean).join(" ")) : null) ?? await ebay.ebayAsks([query.name, g].filter(Boolean).join(" "));
      if (!asks) return null;
      return {
        ...empty,
        price: asks.median,
        source: "ebay",
        marketPrice: asks.median,
        subType: grader === "RAW" ? "Raw" : `${grader} ${grade}`,
        gradeLabel: grader === "RAW" ? void 0 : `${grader} ${grade}`,
        note: [note, `no sold price guide \u2014 median of ${asks.count} current eBay asks (from ${asks.low})`].filter(Boolean).join(" \xB7 "),
        sourceUrl: asks.url,
        url: asks.url
      };
    };
    let data = null;
    const product = await pc.findPcProduct(query, host);
    if (product) data = await pc.pcData(product.url);
    if (!data) data = await pc.pcApiData(query, host, pcToken || void 0);
    if (!data) {
      const viaEbay = await tryEbay();
      if (viaEbay) return viaEbay;
      const hint = host === "sports" && !pc.hasToken(pcToken) ? "sports lookups need a PriceCharting API token \u2014 add one to the pricing config, or open the eBay solds link and set the price manually" : "no eBay price-guide match found \u2014 set a price manually";
      return { ...empty, note: hint, sourceUrl: product?.url };
    }
    let label;
    if (grader === "RAW") {
      label = "Ungraded";
    } else {
      const resolved = gradeLabelFor(grader, grade, data.grades);
      if (!resolved) {
        const viaEbay = await tryEbay();
        if (viaEbay) return viaEbay;
        return {
          ...empty,
          note: [note, `no ${grader} ${grade} value in the price guide \u2014 set a price manually`].filter(Boolean).join(" \xB7 ") || void 0,
          sourceUrl: data.url
        };
      }
      label = resolved.label;
      note = [note, resolved.note].filter(Boolean).join(" \xB7 ") || void 0;
    }
    const sales = (data.sales[label] ?? []).filter((s) => s.source === "ebay").slice(0, 5).map((s) => ({
      date: s.date,
      price: s.price,
      condition: "eBay",
      variant: label,
      title: s.title,
      url: s.url
    }));
    const price = data.grades[label] ?? null;
    return {
      ...empty,
      price,
      source: price != null ? "graded" : "none",
      marketPrice: price,
      subType: grader === "RAW" ? "Raw" : `${grader} ${grade}`,
      gradeLabel: label,
      // The whole ladder, so a RAW lookup can show "what it'd be worth graded".
      grades: data.grades,
      sourceUrl: data.url,
      url: data.url,
      note,
      sales
    };
  }
  return { priceGraded };
}

// src/pricing/pricing.ts
var FACTOR = {
  NM: 1,
  LP: 0.85,
  MP: 0.7,
  HP: 0.55,
  DM: 0.4
};
var CONDITION_NAME = {
  NM: "Near Mint",
  LP: "Lightly Played",
  MP: "Moderately Played",
  HP: "Heavily Played",
  DM: "Damaged"
};
var CONDITION_ID = { NM: 1, LP: 2, MP: 3, HP: 4, DM: 5 };
var CODE_BY_NAME = Object.fromEntries(
  Object.entries(CONDITION_NAME).map(([code, name]) => [name, code])
);
var norm = (s) => s.toLowerCase().replace(/\s+/g, " ").trim();
var ALL_CONDITIONS = Object.keys(CONDITION_ID);
var TRUSTED = /* @__PURE__ */ new Set(["tcg_market", "sales", "ask"]);
var SALE_HALF_LIFE_DAYS = 14;
var STALE_MARKET_AGE_DAYS = 30;
var ASK_DISCOUNT = 0.9;
var ASK_FULL_WEIGHT_AT = 3;
var ASK_TRUST_FROM = 2;
var BAD_SALE_BELOW_ASK = 0.4;
var DAY_MS = 864e5;
var NOT_THE_PRODUCT = /\b(spanish|espa[ñn]ol|japanese|japan|jpn|german|deutsch|french|fran[cç]ais|italian|italiano|portuguese|portugu[eê]s|korean|chinese|thai|indonesian|russian|latam|latin american|slab|slabbed|graded|proxy|signed|autographed?)\b|\b(psa|bgs|cgc|sgc|ace|tag)\s*\d{1,2}(?:\.5)?\b/i;
var notTheProduct = (e) => e.custom === true && NOT_THE_PRODUCT.test(e.title ?? "");
function askPool(eligible, soldLevel, soldWeight) {
  const honest = eligible.filter((l) => !notTheProduct(l));
  const standard = honest.filter((l) => !l.custom);
  let pool = standard.length ? standard : honest;
  const byPrice = [...pool].sort((a, b) => a.price - b.price);
  if (byPrice.length >= 2 && soldLevel != null && soldWeight >= 1 && byPrice[0].price < soldLevel * 0.75 && byPrice[0].price < byPrice[1].price * 0.8) {
    pool = pool.filter((l) => l !== byPrice[0]);
  }
  return pool;
}
function saleAgeDays(date, now) {
  const t = Date.parse(date);
  return Number.isFinite(t) ? Math.max(0, (now - t) / DAY_MS) : SALE_HALF_LIFE_DAYS;
}
var recencyWeight = (ageDays) => 0.5 ** (ageDays / SALE_HALF_LIFE_DAYS);
function weightedMedian(items) {
  const sorted = [...items].sort((a, b) => a.value - b.value);
  const half = sorted.reduce((sum, i) => sum + i.weight, 0) / 2;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i].weight;
    if (acc > half + 1e-9) return sorted[i].value;
    if (Math.abs(acc - half) <= 1e-9) {
      return i + 1 < sorted.length ? (sorted[i].value + sorted[i + 1].value) / 2 : sorted[i].value;
    }
  }
  return sorted[sorted.length - 1].value;
}
function askFloorOf(listings) {
  const ps = listings.map((l) => l.price).sort((a, b) => a - b);
  if (!ps.length) return null;
  return ps.length >= 2 && ps[0] < ps[1] / 10 ? ps[1] : ps[0];
}
function blendLevels(levels) {
  const total = levels.reduce((sum, l) => sum + l.weight, 0);
  if (levels.every((l) => l.value > 0)) {
    return Math.exp(levels.reduce((sum, l) => sum + l.weight * Math.log(l.value), 0) / total);
  }
  return levels.reduce((sum, l) => sum + l.weight * l.value, 0) / total;
}
var fmtAge = (days) => days < 1 ? "today" : days < 2 ? "yesterday" : `${Math.round(days)} days ago`;
var plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
function variantMatcher(subType) {
  const wantVariant = norm(subType);
  return (v) => !wantVariant || wantVariant === "market" || norm(v) === wantVariant;
}
function withoutOutliers(sales, valueOf) {
  if (sales.length < 4) return sales;
  const centre = weightedMedian(sales.map((s) => ({ value: valueOf(s), weight: 1 })));
  if (!(centre > 0)) return sales;
  const kept = sales.filter((s) => valueOf(s) >= centre * 0.4 && valueOf(s) <= centre * 3);
  return kept.length >= 2 ? kept : sales;
}
function assess(params, ev) {
  const { condition } = params;
  const subType = params.subType ?? "";
  const n = Math.min(Math.max(params.salesCount || 3, 1), 10);
  const variantOk = variantMatcher(subType);
  const weightOf = (s) => recencyWeight(saleAgeDays(s.date, ev.now));
  const newestOf = (sales) => Math.min(...sales.map((s) => saleAgeDays(s.date, ev.now)));
  let soldLevel = null;
  let soldWeight = 0;
  let salesUsed = 0;
  let newestSaleDays = null;
  let source = "none";
  let exactUsed = false;
  let shown = [];
  let asOf;
  const exact = ev.exact.filter(
    (s) => variantOk(s.variant) && s.condition === CONDITION_NAME[condition] && !notTheProduct(s)
  );
  if (ev.market && ev.market.market > 0) {
    const units = [];
    for (const day of ev.market.sales ?? []) {
      for (let i = 0; i < day.quantity && units.length < n; i++) units.push(saleAgeDays(day.date, ev.now));
    }
    soldLevel = ev.market.market;
    soldWeight = units.length ? units.reduce((sum, age) => sum + recencyWeight(age), 0) : recencyWeight(STALE_MARKET_AGE_DAYS);
    salesUsed = ev.market.sold;
    newestSaleDays = units.length ? Math.min(...units) : STALE_MARKET_AGE_DAYS;
    source = "tcg_market";
    exactUsed = true;
    asOf = ev.market.asOf;
    shown = exact;
  } else if (exact.length) {
    const take = withoutOutliers(exact, (s) => s.price).slice(0, n);
    soldLevel = weightedMedian(take.map((s) => ({ value: s.price, weight: weightOf(s) })));
    soldWeight = take.reduce((sum, s) => sum + weightOf(s), 0);
    salesUsed = take.length;
    newestSaleDays = newestOf(take);
    source = "sales";
    exactUsed = true;
    shown = exact;
  } else {
    const usable = ev.mixed.filter((s) => variantOk(s.variant) && !notTheProduct(s));
    shown = usable;
    const known = usable.filter((s) => CODE_BY_NAME[s.condition]);
    if (known.length >= 2) {
      const nmEquivalent = (s) => s.price / FACTOR[CODE_BY_NAME[s.condition]];
      const take = withoutOutliers(known, nmEquivalent).slice(0, Math.max(n, 5));
      soldLevel = weightedMedian(
        take.map((s) => ({ value: nmEquivalent(s) * FACTOR[condition], weight: weightOf(s) }))
      );
      soldWeight = take.reduce((sum, s) => sum + weightOf(s), 0) / 2;
      salesUsed = take.length;
      newestSaleDays = newestOf(take);
      source = "sales_adj";
    }
  }
  let marketPrice = null;
  let publishedMarket = null;
  let marketNote;
  let listedLow = null;
  let listedMid = null;
  const wantVariant = norm(subType);
  const row = ev.rows.find((r) => norm(r.subTypeName) === wantVariant) ?? ev.rows.find((r) => r.marketPrice != null);
  if (row) {
    const sane = saneMarketPrice(row);
    marketPrice = sane.price;
    publishedMarket = row.marketPrice != null && row.marketPrice > 0 && row.marketPrice !== 1e5 ? row.marketPrice : null;
    listedLow = row.lowPrice != null && row.lowPrice !== 1e5 ? row.lowPrice : null;
    listedMid = row.midPrice != null && row.midPrice !== 1e5 ? row.midPrice : null;
    if (sane.adjusted) {
      marketNote = `TCGplayer's published market price ($${row.marketPrice}) looks stale for this printing \u2014 using current listing prices instead`;
    }
  }
  const eligible = ev.listings.filter(
    (l) => variantOk(l.variant) && l.condition === CONDITION_NAME[condition] && l.price < 1e5
  );
  const listings = eligible.slice(0, 5);
  const pool = askPool(eligible, soldLevel, soldWeight);
  const askFloor = askFloorOf(pool);
  const askWeight = askFloor == null ? 0 : Math.min(pool.length, ASK_FULL_WEIGHT_AT) / ASK_FULL_WEIGHT_AT * Math.min(1, askFloor / ASK_TRUST_FROM);
  const delivered = askFloorOf(pool.map((l) => ({ price: l.price + (l.shipping ?? 0) })));
  const askCap = delivered != null && delivered >= ASK_TRUST_FROM ? delivered : null;
  return {
    params,
    soldLevel,
    soldWeight,
    salesUsed,
    newestSaleDays,
    exactUsed,
    source,
    shown,
    marketPrice,
    publishedMarket,
    marketNote,
    listedLow,
    listedMid,
    listings,
    askFloor,
    askWeight,
    askCap,
    askCount: pool.length,
    asOf
  };
}
function corroborationFor(a, others) {
  const factor = FACTOR[a.params.condition];
  const solds = others.filter((o) => o.exactUsed && o.soldLevel != null).map((o) => ({
    value: o.soldLevel / FACTOR[o.params.condition],
    weight: Math.max(o.soldWeight, 1e-6)
  }));
  if (solds.length) return weightedMedian(solds) * factor;
  return a.publishedMarket == null ? null : a.publishedMarket * factor;
}
function finish(a, corroboration) {
  const { productId, condition } = a.params;
  const subType = a.params.subType ?? "";
  let { soldLevel, soldWeight, salesUsed, newestSaleDays, source, askWeight, askCap } = a;
  const { askFloor, marketPrice, listings, askCount } = a;
  const fromTcg = a.source === "tcg_market";
  let wishNote;
  if (askFloor != null && askCount === 1 && corroboration != null && askFloor > corroboration * 3) {
    wishNote = `the one live ${condition} ask ($${round2(askFloor)}) is far above what other conditions sell for \u2014 ignored`;
    askWeight = 0;
    askCap = null;
  }
  let guardNote;
  if (soldLevel != null && askFloor != null && askFloor > 50 && salesUsed <= 2 && soldLevel < askFloor * BAD_SALE_BELOW_ASK && (corroboration == null || soldLevel < corroboration * BAD_SALE_BELOW_ASK)) {
    guardNote = `ignored a lone $${round2(soldLevel)} figure far below the $${round2(askFloor)} live asks \u2014 priced at the current ask level`;
    soldLevel = null;
    soldWeight = 0;
    salesUsed = 0;
    newestSaleDays = null;
  }
  const askLevel = askFloor == null || askWeight <= 0 ? null : Math.max(askFloor * ASK_DISCOUNT, Math.min(askFloor, soldLevel ?? 0));
  if (soldLevel != null && askLevel != null && askLevel > 0) {
    const freshness = Math.min(1, soldWeight);
    askWeight *= 1 - freshness * (1 - Math.min(1, soldLevel / askLevel));
  }
  let price = null;
  let estimated = false;
  let blendNote;
  const weight = soldWeight + askWeight;
  if (soldLevel != null || askLevel != null) {
    const levels = [];
    if (soldLevel != null) levels.push({ value: soldLevel, weight: soldWeight });
    if (askLevel != null) levels.push({ value: askLevel, weight: askWeight });
    price = round2(blendLevels(levels));
    const capped = askCap != null && price > askCap;
    if (capped) price = round2(askCap);
    const askLed = soldLevel == null || askWeight > soldWeight && soldWeight < 0.5 && askLevel - soldLevel >= soldLevel * 0.05;
    const what = fromTcg ? `TCGplayer's ${condition} market` : plural(salesUsed, `${condition} sold`);
    const age = newestSaleDays == null ? "" : fromTcg && newestSaleDays >= STALE_MARKET_AGE_DAYS ? " (no sale in the last month)" : ` (newest ${fmtAge(newestSaleDays)})`;
    if (soldLevel == null) {
      source = "ask";
      blendNote = `no ${condition} solds of this printing on record \u2014 priced just under the cheapest live ask ($${round2(askFloor)})`;
    } else if (askLed) {
      source = "ask";
      blendNote = `${what}${age} at $${round2(soldLevel)} \u2014 too old or too few to outweigh the live ${condition} asks from $${round2(askFloor)}`;
    } else if (capped) {
      blendNote = `${what}${age} at $${round2(soldLevel)} sits above the cheapest live ${condition} ask \u2014 held at that ask ($${round2(askCap)}${askCap !== askFloor ? " delivered" : ""}) so it can't be beaten online`;
    } else if (askLevel != null && Math.abs(price - soldLevel) >= soldLevel * 0.05) {
      blendNote = `${what}${age} at $${round2(soldLevel)}, live ${condition} asks from $${round2(askFloor)} \u2014 blended`;
    }
    estimated = !TRUSTED.has(source) || source === "ask";
  } else if (marketPrice != null) {
    price = round2(marketPrice * FACTOR[condition]);
    source = condition === "NM" ? "market" : "market_adj";
    estimated = condition !== "NM";
  }
  const basis = {
    soldLevel: soldLevel == null ? null : round2(soldLevel),
    soldWeight: round2(soldWeight),
    newestSaleDays: newestSaleDays == null ? null : Math.round(newestSaleDays),
    askFloor: askFloor == null ? null : round2(askFloor),
    askWeight: round2(askWeight),
    askCap: askCap == null ? null : round2(askCap)
  };
  return {
    quote: {
      productId,
      subType,
      condition,
      price,
      source,
      estimated,
      salesUsed,
      marketPrice,
      sales: a.shown.slice(0, 5),
      url: `https://www.tcgplayer.com/product/${productId}`,
      asOf: a.asOf,
      note: guardNote ?? blendNote ?? wishNote ?? a.marketNote,
      listings,
      listedLow: a.listedLow,
      listedMid: a.listedMid,
      basis
    },
    weight,
    anchor: price != null && (a.exactUsed || askWeight > 0)
  };
}
function priceFromEvidence(params, ev) {
  const a = assess(params, ev);
  return finish(a, corroborationFor(a, []));
}
function ladderFromEvidence(base, evidence) {
  const assessed = ALL_CONDITIONS.map((condition) => assess({ ...base, condition }, evidence[condition]));
  const priced = assessed.map(
    (a) => finish(
      a,
      corroborationFor(
        a,
        assessed.filter((o) => o !== a)
      )
    )
  );
  return assembleLadder(priced);
}
function assembleLadder(priced) {
  const anchors = priced.filter((p) => p.anchor && p.quote.price != null);
  if (anchors.length) {
    const salesUsed = anchors.reduce((a, p) => a + p.quote.salesUsed, 0);
    priced.forEach((p, i) => {
      if (p.anchor) return;
      const q = p.quote;
      const above = priced.slice(0, i).reverse().find((o) => o.anchor && o.quote.price != null);
      const below = priced.slice(i + 1).find((o) => o.anchor && o.quote.price != null);
      const ref = above ?? below;
      let price = ref.quote.price * FACTOR[q.condition] / FACTOR[ref.quote.condition];
      if (above) price = Math.min(price, above.quote.price);
      if (below) price = Math.max(price, below.quote.price);
      q.price = round2(price);
      q.estimated = true;
      q.salesUsed = ref.quote.source === "tcg_market" ? 0 : salesUsed;
      if (ref.quote.source === "tcg_market") {
        q.source = "scaled";
        q.note = `no TCGplayer market for ${q.condition} \u2014 scaled from its ${ref.quote.condition} market`;
      } else {
        q.source = "sales_adj";
        q.note = `no recent ${q.condition} solds of this printing \u2014 scaled from this printing's price in other conditions`;
      }
      p.weight = 0.5;
    });
  }
  const hasTcg = priced.some((p) => p.quote.source === "tcg_market" && p.quote.price != null);
  if (!hasTcg) {
    enforceMonotonic(priced);
  } else {
    let ceiling2 = Infinity;
    for (const p of priced) {
      const q = p.quote;
      if (q.price == null) continue;
      if (q.source === "tcg_market") {
        ceiling2 = q.price;
        continue;
      }
      if (q.price > ceiling2) {
        q.price = round2(ceiling2);
        q.note = `held under TCGplayer's price for a cleaner grade ($${round2(ceiling2)})`;
      }
    }
  }
  let ceiling = Infinity;
  let ceilingFrom = null;
  for (const p of priced) {
    const q = p.quote;
    if (q.price == null) continue;
    const floor = q.basis?.askCap ?? Infinity;
    const held = Math.min(q.price, floor, ceiling);
    if (held < q.price) {
      q.price = round2(held);
      q.note = held === floor ? `held at the cheapest live ${q.condition} ask ($${round2(floor)}) \u2014 it can't be listed for more than it can be bought for` : `held under the ${ceilingFrom} price \u2014 a cleaner copy can be bought for $${round2(ceiling)}`;
    }
    if (floor < ceiling) {
      ceiling = floor;
      ceilingFrom = q.condition;
    }
  }
  return Object.fromEntries(priced.map((p) => [p.quote.condition, p.quote]));
}
function enforceMonotonic(priced) {
  const blocks = [];
  for (const p of priced) {
    const q = p.quote;
    if (q.price == null) continue;
    const weight = p.weight > 0 ? p.weight : 0.5;
    blocks.push({ weighted: weight * q.price, weight, members: [q] });
    while (blocks.length >= 2) {
      const last = blocks[blocks.length - 1];
      const prev = blocks[blocks.length - 2];
      if (prev.weighted / prev.weight >= last.weighted / last.weight) break;
      prev.weighted += last.weighted;
      prev.weight += last.weight;
      prev.members.push(...last.members);
      blocks.pop();
    }
  }
  for (const b of blocks) {
    if (b.members.length < 2) continue;
    const pooled = round2(b.weighted / b.weight);
    for (const q of b.members) {
      if (q.price === pooled) continue;
      const before = q.price;
      const moved = Math.abs(pooled - before) >= before * 0.05;
      q.price = pooled;
      if (moved || !q.note) {
        q.note = "levelled with neighbouring conditions \u2014 their recent solds disagreed on which grade was worth more";
      }
    }
  }
}
function createPricer(ctx, deps) {
  const { csv, live, sku } = deps;
  const now = () => typeof ctx.now === "function" ? ctx.now() : Date.now();
  async function rowsFor(params) {
    const categoryId = params.categoryId ?? null;
    const groupId = params.groupId ?? null;
    if (categoryId == null || groupId == null) return [];
    try {
      return (await csv.prices(categoryId, groupId)).filter((r) => r.productId === params.productId);
    } catch (err) {
      console.error("[pricing] market price lookup failed:", err);
      return [];
    }
  }
  async function gather(params, at, shared) {
    const { productId, condition } = params;
    const subType = params.subType ?? "";
    const variantOk = variantMatcher(subType);
    const markets = await sku.skuMarkets(productId);
    const market = sku.skuMarketFor(markets, subType, CONDITION_NAME[condition]);
    let exact = [];
    let mixed = [];
    if (!(market && market.market > 0)) {
      exact = await live.latestSales(productId, CONDITION_ID[condition]) ?? [];
      const hasExact = exact.some((s) => variantOk(s.variant) && s.condition === CONDITION_NAME[condition]);
      mixed = hasExact ? [] : await live.latestSales(productId) ?? [];
    }
    const rows = shared?.rows ?? await rowsFor(params);
    const listings = shared?.listings ?? (await live.currentListings(productId) ?? []);
    return { market, exact, mixed, listings, rows, now: at };
  }
  async function quote(params) {
    return priceFromEvidence(params, await gather(params, now())).quote;
  }
  async function quoteAll(params) {
    const at = now();
    const [rows, listings] = await Promise.all([
      rowsFor(params),
      (async () => await live.currentListings(params.productId) ?? [])()
    ]);
    const gathered = await Promise.all(
      ALL_CONDITIONS.map((condition) => gather({ ...params, condition }, at, { rows, listings }))
    );
    const evidence = Object.fromEntries(
      ALL_CONDITIONS.map((c, i) => [c, gathered[i]])
    );
    return ladderFromEvidence(params, evidence);
  }
  return { quote, quoteAll };
}

// src/pricing/providers/crosscheck.ts
var HOUR3 = 36e5;
var num = (v) => {
  const n = typeof v === "string" ? parseFloat(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};
function createCrossCheck(ctx) {
  const headers = { "user-agent": ctx.userAgent, accept: "application/json" };
  async function scryfall(name) {
    return ctx.cached(`xcheck:scry:${name.toLowerCase()}`, 6 * HOUR3, async () => {
      try {
        const r = await ctx.fetchRetry(
          `https://api.scryfall.com/cards/named?fuzzy=${encodeURIComponent(name)}`,
          { headers }
        );
        if (!r.ok) return null;
        const c = await r.json();
        if (!c.name || nameSim(name, c.name) < 0.5) return null;
        const prices = [];
        const usd = num(c.prices?.usd);
        const usdFoil = num(c.prices?.usd_foil);
        const eur = num(c.prices?.eur);
        if (usd) prices.push({ currency: "USD", price: usd, label: "market" });
        if (usdFoil) prices.push({ currency: "USD", price: usdFoil, label: "foil" });
        if (eur) prices.push({ currency: "EUR", price: eur, label: "Cardmarket" });
        if (!prices.length) return null;
        return {
          source: "Scryfall",
          matchedName: `${c.name}${c.set_name ? ` \xB7 ${c.set_name}` : ""}`,
          prices,
          url: c.scryfall_uri
        };
      } catch (err) {
        console.error("[crosscheck] scryfall failed", err);
        return null;
      }
    });
  }
  async function ygoprodeck(name) {
    return ctx.cached(`xcheck:ygo:${name.toLowerCase()}`, 6 * HOUR3, async () => {
      try {
        const r = await ctx.fetchRetry(
          `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(name)}`,
          { headers }
        );
        let card;
        if (r.ok) card = (await r.json()).data?.[0];
        if (!card) {
          const fr = await ctx.fetchRetry(
            `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(name)}`,
            { headers }
          );
          if (!fr.ok) return null;
          const list = (await fr.json()).data ?? [];
          card = list.find((c) => c.name && nameSim(name, c.name) >= 0.6) ?? list[0];
        }
        if (!card?.name || nameSim(name, card.name) < 0.5) return null;
        const p = card.card_prices?.[0];
        const prices = [];
        const tcg = num(p?.tcgplayer_price);
        const cm = num(p?.cardmarket_price);
        const ebay = num(p?.ebay_price);
        if (tcg) prices.push({ currency: "USD", price: tcg, label: "TCGplayer" });
        if (ebay) prices.push({ currency: "USD", price: ebay, label: "eBay" });
        if (cm) prices.push({ currency: "EUR", price: cm, label: "Cardmarket" });
        if (!prices.length) return null;
        return {
          source: "YGOPRODeck",
          matchedName: card.name,
          prices,
          url: `https://ygoprodeck.com/card/?search=${encodeURIComponent(card.name)}`
        };
      } catch (err) {
        console.error("[crosscheck] ygoprodeck failed", err);
        return null;
      }
    });
  }
  async function crossCheck(game, name) {
    if (!name?.trim()) return null;
    if (game === "magic") return scryfall(name);
    if (game === "yugioh") return ygoprodeck(name);
    return null;
  }
  return { crossCheck };
}

// src/pricing/providers/ebay.ts
var TOKEN_URL = "https://api.ebay.com/identity/v1/oauth2/token";
var SEARCH_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search";
var SCOPE = "https://api.ebay.com/oauth/api_scope";
var MIN2 = 6e4;
function toListing(it) {
  const price = it.price?.value ? parseFloat(it.price.value) : NaN;
  if (!Number.isFinite(price) || price <= 0) return null;
  const shipRaw = it.shippingOptions?.[0]?.shippingCost?.value;
  const shipping = shipRaw != null ? parseFloat(shipRaw) : null;
  return {
    title: it.title ?? "",
    price,
    shipping: Number.isFinite(shipping) ? shipping : null,
    condition: it.condition ?? "",
    url: it.itemWebUrl ?? ""
  };
}
var basicAuth = (id, secret) => btoa(`${id}:${secret}`);
function createEbay(ctx) {
  function creds() {
    const id = (ctx.tokens.ebay?.clientId ?? "").trim();
    const secret = (ctx.tokens.ebay?.clientSecret ?? "").trim();
    return id && secret ? { id, secret } : null;
  }
  function ebayConfigured() {
    return creds() != null;
  }
  async function token() {
    const c = creds();
    if (!c) return null;
    return ctx.cached(`ebay:token:${c.id}`, 90 * MIN2, async () => {
      try {
        const r = await ctx.fetchRetry(TOKEN_URL, {
          method: "POST",
          headers: {
            authorization: `Basic ${basicAuth(c.id, c.secret)}`,
            "content-type": "application/x-www-form-urlencoded"
          },
          body: `grant_type=client_credentials&scope=${encodeURIComponent(SCOPE)}`
        });
        if (!r.ok) {
          console.error(`[ebay] token ${r.status}`);
          return null;
        }
        const j = await r.json();
        return j.access_token ?? null;
      } catch (err) {
        console.error("[ebay] token failed", err);
        return null;
      }
    });
  }
  async function ebayAsks(query, limit = 25) {
    const q = query.replace(/&/g, " ").replace(/[^\w\s.\-/]/g, " ").replace(/\s+/g, " ").trim();
    if (!q) return null;
    const t = await token();
    if (!t) return null;
    return ctx.cached(`ebay:search:${q.toLowerCase()}`, 15 * MIN2, async () => {
      try {
        const url = `${SEARCH_URL}?q=${encodeURIComponent(q)}&limit=${limit}&filter=${encodeURIComponent("buyingOptions:{FIXED_PRICE|BEST_OFFER}")}&sort=price`;
        const r = await ctx.fetchRetry(url, {
          headers: {
            authorization: `Bearer ${t}`,
            "content-type": "application/json",
            "X-EBAY-C-MARKETPLACE-ID": "EBAY_US"
          }
        });
        if (!r.ok) {
          console.error(`[ebay] search ${r.status}`);
          return null;
        }
        const j = await r.json();
        const items = (j.itemSummaries ?? []).map(toListing).filter((x) => x != null);
        if (!items.length) return null;
        const totals = items.map((i) => i.price + (i.shipping ?? 0)).sort((a, b) => a - b);
        return {
          count: items.length,
          low: Math.round(totals[0] * 100) / 100,
          median: Math.round(totals[Math.floor(totals.length / 2)] * 100) / 100,
          items: items.slice(0, 5),
          url: `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sop=15`
        };
      } catch (err) {
        console.error("[ebay] search failed", err);
        return null;
      }
    });
  }
  return { ebayAsks, ebayConfigured };
}

// src/pricing/providers/psa.ts
var DAY = 24 * 36e5;
var str = (v) => typeof v === "string" || typeof v === "number" ? String(v).trim() : "";
function createPsa(ctx) {
  async function psaFetchCertDetailed(cert, token) {
    const clean = cert.replace(/\D/g, "");
    if (!token) return { psa: null, error: "auth" };
    if (clean.length < 7 || clean.length > 10) return { psa: null, error: "notfound" };
    try {
      const r = await ctx.fetch(`https://api.psacard.com/publicapi/cert/GetByCertNumber/${clean}`, {
        headers: { authorization: `bearer ${token}`, accept: "application/json" },
        signal: AbortSignal.timeout(15e3)
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        console.error(`[psa] ${r.status} for cert ${clean}: ${text.slice(0, 120)}`);
        if (/quota\s*exceeded/i.test(text)) return { psa: null, error: "quota" };
        if (r.status === 401 || r.status === 403 || r.status === 429) {
          return { psa: null, error: "auth" };
        }
        return { psa: null, error: "error" };
      }
      const body = await r.json();
      if (body.IsValidRequest === false) return { psa: null, error: "notfound" };
      const c = body.PSACert ?? body;
      const subject = str(c.Subject);
      if (!subject) return { psa: null, error: "notfound" };
      const gradeRaw = str(c.CardGrade);
      const gradeNum = gradeRaw.match(/\d{1,2}(\.5)?/)?.[0] ?? "";
      return {
        psa: {
          cert: str(c.CertNumber) || clean,
          grade: gradeNum,
          gradeDescription: str(c.GradeDescription) || gradeRaw,
          year: str(c.Year),
          brand: str(c.Brand),
          subject,
          cardNumber: str(c.CardNumber),
          variety: str(c.Variety),
          url: `https://www.psacard.com/cert/${clean}`
        }
      };
    } catch (err) {
      console.error(`[psa] cert lookup failed for ${clean}:`, err);
      return { psa: null, error: "error" };
    }
  }
  async function psaFetchCert(cert, token) {
    return (await psaFetchCertDetailed(cert, token)).psa;
  }
  async function psaCertDetailed(cert, tokenOverride) {
    const token = (tokenOverride ?? "").trim() || (ctx.tokens.psa ?? "").trim();
    if (!token) return { psa: null };
    const clean = cert.replace(/\D/g, "");
    if (clean.length < 7 || clean.length > 10) return { psa: null, error: "notfound" };
    let error;
    const psa = await ctx.cached(`psa:${clean}`, 30 * DAY, async () => {
      const r = await psaFetchCertDetailed(clean, token);
      error = r.error;
      return r.psa;
    });
    return psa ? { psa } : { psa: null, error: error ?? "error" };
  }
  async function psaCert(cert, tokenOverride) {
    return (await psaCertDetailed(cert, tokenOverride)).psa;
  }
  const hasToken = (override) => Boolean((override ?? "").trim() || (ctx.tokens.psa ?? "").trim());
  return { psaFetchCert, psaFetchCertDetailed, psaCert, psaCertDetailed, hasToken };
}

// src/pricing/providers/tcgplayer-sku.ts
var MIN3 = 6e4;
var SKU_BREAK = 5;
var SKU_COOLDOWNS = 2;
var normVariant = (s) => String(s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
function skuMarketFor(markets, subType, conditionName) {
  return markets?.[`${normVariant(subType)}|${conditionName}`] ?? null;
}
function createSkuMarkets(ctx) {
  const minIntervalMs = ctx.sku.minIntervalMs;
  const cooldownMs = ctx.sku.cooldownMs;
  let lastAt = 0;
  let interval = minIntervalMs;
  let inflight = Promise.resolve();
  const state = {
    requests: 0,
    failures: 0,
    consecutiveFailures: 0,
    blocked: false,
    lastStatus: null,
    cooldowns: 0
  };
  function serial(fn) {
    const run = inflight.then(fn, fn);
    inflight = run.then(
      () => void 0,
      () => void 0
    );
    return run;
  }
  async function skuGet(url) {
    return serial(async () => {
      const wait = lastAt + interval - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastAt = Date.now();
      state.requests++;
      try {
        const r = await ctx.fetchRetry(url, { headers: headers() });
        state.lastStatus = r.status;
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        state.consecutiveFailures = 0;
        return await r.json();
      } catch (err) {
        state.failures++;
        if (++state.consecutiveFailures >= SKU_BREAK) {
          if (state.cooldowns < SKU_COOLDOWNS) {
            state.cooldowns++;
            state.consecutiveFailures = 0;
            interval *= 2;
            lastAt = Date.now() + cooldownMs;
            console.error(
              `[tcgplayer-sku] price/history: ${SKU_BREAK} consecutive failures (last ${err?.message ?? err}) \u2014 cooling down ${Math.round(cooldownMs / 6e4)} min, then one request per ${(interval / 1e3).toFixed(1)} s (cool-down ${state.cooldowns}/${SKU_COOLDOWNS})`
            );
          } else if (!state.blocked) {
            state.blocked = true;
            console.error(
              `[tcgplayer-sku] price/history: ${SKU_BREAK} consecutive failures again (last ${err?.message ?? err}) \u2014 circuit open, skipping the rest of this run`
            );
          }
        }
        return null;
      }
    });
  }
  const headers = () => ({
    "user-agent": ctx.chromeUserAgent,
    accept: "application/json",
    origin: "https://www.tcgplayer.com",
    referer: "https://www.tcgplayer.com/"
  });
  async function skuMarkets(productId) {
    if (state.blocked) return null;
    return ctx.cached(`sku:${productId}`, 60 * MIN3, async () => {
      const resp = await skuGet(
        `https://infinite-api.tcgplayer.com/price/history/${productId}/detailed?range=month`
      );
      if (!resp) return null;
      const out = {};
      for (const s of resp.result ?? []) {
        if (s.language && s.language !== "English") continue;
        const latest = (s.buckets ?? []).find((b) => Number(b.marketPrice) > 0);
        if (!latest) continue;
        out[`${normVariant(s.variant)}|${s.condition}`] = {
          market: Number(latest.marketPrice),
          sold: Number(s.totalQuantitySold ?? 0),
          asOf: String(latest.bucketStartDate ?? "").slice(0, 10),
          sales: (s.buckets ?? []).filter((b) => Number(b.quantitySold) > 0).map((b) => ({
            date: String(b.bucketStartDate ?? "").slice(0, 10),
            quantity: Number(b.quantitySold)
          }))
        };
      }
      return out;
    });
  }
  return { skuMarkets, skuMarketFor, state };
}

// src/pricing/subtype.ts
function pickSubType(printing, subTypes) {
  if (!subTypes.length) return "Market";
  const names = subTypes.map((s) => s.name);
  const lower = (s) => s.toLowerCase();
  const p = lower(printing);
  const find = (pred) => names.find((n) => pred(lower(n)));
  const no1st = (n) => !n.includes("1st");
  let pick;
  if (p.includes("reverse"))
    pick = find((n) => n.includes("reverse") && no1st(n)) ?? find((n) => n.includes("reverse"));
  else if (p.includes("1st")) {
    pick = (p.includes("holo") ? find((n) => n.includes("1st") && n.includes("holo")) : find((n) => n.includes("1st") && !n.includes("holo"))) ?? find((n) => n.includes("1st"));
  } else if (p.includes("holo")) {
    pick = find((n) => n === "holofoil") ?? find((n) => n.includes("holofoil") && !n.includes("reverse") && no1st(n));
  } else if (p.includes("etched")) pick = find((n) => n.includes("etched"));
  else if (p.includes("foil"))
    pick = find((n) => n.includes("foil") && !n.includes("non") && no1st(n));
  else if (p) {
    pick = find((n) => n === "normal") ?? find((n) => n === "unlimited") ?? find((n) => n.includes("non foil"));
  }
  if (!pick) {
    pick = names.find((n) => no1st(lower(n)) && subTypes.find((s) => s.name === n)?.marketPrice != null) ?? names.find((n) => subTypes.find((s) => s.name === n)?.marketPrice != null) ?? names[0];
  }
  return pick;
}
function mergedEditions(match, candidates) {
  if (!match) return null;
  const all = [match, ...candidates];
  const shadow = all.find((p) => /\(shadowless\)/i.test(p.groupName));
  if (!shadow) return null;
  const baseName = shadow.groupName.replace(/\s*\(shadowless\)/i, "").trim().toLowerCase();
  const plain = all.find((p) => p.groupName.trim().toLowerCase() === baseName);
  const first = shadow.subTypes.find((s) => /1st/i.test(s.name));
  const shadowUnl = shadow.subTypes.find((s) => !/1st/i.test(s.name));
  const out = [];
  if (first)
    out.push({ label: "1st Edition", product: shadow, subType: first.name, price: first.marketPrice });
  if (shadowUnl)
    out.push({
      label: "Shadowless",
      product: shadow,
      subType: shadowUnl.name,
      price: shadowUnl.marketPrice
    });
  const plainSub = plain?.subTypes[0];
  if (plain && plainSub)
    out.push({ label: "Unlimited", product: plain, subType: plainSub.name, price: plainSub.marketPrice });
  return out.length >= 2 ? out : null;
}
var editionKey = (o) => `${o.product.productId}::${o.subType}`;
function currentEdition(merged, match, subType) {
  return merged.find((o) => o.product.productId === match?.productId && o.subType === subType) ?? // Same product, subType not settled yet (a scan mid-pricing): still far
  // better than defaulting to 1st Edition and showing an Unlimited price
  // next to it — a highlight that lies is worse than no highlight.
  merged.find((o) => o.product.productId === match?.productId) ?? merged[0];
}

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

// src/pricing/types.ts
var CONDITIONS = [
  { value: "NM", label: "Near Mint" },
  { value: "LP", label: "Lightly Played" },
  { value: "MP", label: "Moderately Played" },
  { value: "HP", label: "Heavily Played" },
  { value: "DM", label: "Damaged" }
];
var GRADERS = ["PSA", "CGC", "BGS", "SGC", "TAG", "ACE"];
var GRADES = ["10", "9.5", "9", "8.5", "8", "7.5", "7", "6", "5", "4", "3", "2", "1"];

// src/pricing/index.ts
function createPricing(config = {}) {
  const ctx = createContext(config);
  const csv = createTcgCsv(ctx);
  const live = createTcgLive(ctx);
  const sku = createSkuMarkets(ctx);
  const pc = createPriceCharting(ctx);
  const psa = createPsa(ctx);
  const ebay = createEbay(ctx);
  const xcheck = createCrossCheck(ctx);
  const matcher = createMatch(ctx, { csv, live });
  const pricer = createPricer(ctx, { csv, live, sku });
  const graded = createGradedPricer(ctx, { pc, psa, ebay });
  async function timed(name, fn) {
    const t0 = Date.now();
    try {
      const note = await fn();
      return { name, ok: note !== null, ms: Date.now() - t0, note: note ?? "no data" };
    } catch (err) {
      return { name, ok: false, ms: Date.now() - t0, note: String(err?.message ?? err) };
    }
  }
  return {
    search: (q, game) => matcher.manualSearch(q, game),
    resolveCard: (q) => matcher.resolveCard(q),
    async resolveMany(qs, opts) {
      const out = await limitMap(qs, opts?.concurrency ?? 4, (q) => matcher.resolveCard(q));
      return out.map(
        (r, i) => r ?? {
          cell: qs[i]?.cell ?? 0,
          status: "none",
          best: null,
          candidates: [],
          note: "resolve failed"
        }
      );
    },
    enrich: (match, setCode) => matcher.enrichMatch(match, setCode),
    productById: (productId, categoryId, groupId) => matcher.matchFromGroup(productId, categoryId, groupId),
    price: (ref) => pricer.quote(ref),
    priceAll: (ref) => pricer.quoteAll(ref),
    /**
     * Bounded-concurrency pricing. The per-SKU market endpoint paces itself
     * (one request at a time, ≥1.2s apart) regardless of what is passed here,
     * so a big batch is rate-limited by that, not by this number. Per-item
     * failures become `null` rather than rejecting the batch.
     */
    priceMany: (refs, opts) => limitMap(refs, opts?.concurrency ?? 4, (ref) => pricer.quote(ref)),
    priceGraded: (q) => graded.priceGraded(q),
    crossCheck: (game, name) => xcheck.crossCheck(game, name),
    groupPrices: (categoryId, groupId) => csv.groupPrices(categoryId, groupId),
    async lookupPrice(q) {
      const condition = q.condition ?? "NM";
      const resolved = await matcher.resolveCard(q);
      if (!resolved.best) {
        return {
          match: null,
          quotes: {},
          confidence: null,
          subType: "",
          condition,
          status: resolved.status,
          note: resolved.note
        };
      }
      const subType = pickSubType(q.printing ?? "", resolved.best.subTypes);
      const quotes = await pricer.quoteAll({
        productId: resolved.best.productId,
        categoryId: resolved.best.categoryId,
        groupId: resolved.best.groupId,
        subType
      });
      const picked = quotes[condition];
      return {
        match: resolved.best,
        quotes,
        confidence: picked ? confidenceOf(picked) : null,
        subType,
        condition,
        status: resolved.status,
        note: resolved.note ?? picked?.note
      };
    },
    /**
     * Ported from PokéDebut's Phase-L probes (execution/probe_tcgcsv.mjs and
     * probe_tcglive.mjs): the same reference product (Base Set Bulbasaur,
     * 42387) and the same "is the field we depend on actually there" checks.
     */
    healthcheck() {
      const POKEMON = 3;
      const BULBASAUR = 42387;
      return Promise.all([
        timed("tcgcsv", async () => {
          const gs = await csv.groups(POKEMON);
          const base = gs.find((g) => g.name === "Base Set");
          if (!base) return null;
          const rows = await csv.prices(POKEMON, base.groupId);
          const row = rows.find((r) => r.productId === BULBASAUR);
          if (!row || typeof row.marketPrice !== "number") return null;
          return `${gs.length} Pok\xE9mon sets; Bulbasaur ${row.subTypeName} market $${row.marketPrice}`;
        }),
        timed("tcglive search", async () => {
          const hits = await live.searchProducts("Charizard Base Set", ["pokemon"], 5);
          if (!hits?.length) return null;
          return `${hits.length} hits; top ${hits[0].productName}`;
        }),
        timed("tcgplayer-sku", async () => {
          const markets = await sku.skuMarkets(BULBASAUR);
          if (!markets) return null;
          const nm = sku.skuMarketFor(markets, "Normal", "Near Mint");
          if (!nm) return null;
          return `${Object.keys(markets).length} SKUs; Normal \xB7 Near Mint $${nm.market} (${nm.asOf})`;
        }),
        timed("pricecharting", async () => {
          const hits = await pc.pcSearch("Charizard Base Set");
          if (!hits?.length) return null;
          return `${hits.length} hits; top /${hits[0].setSlug}/${hits[0].productSlug}`;
        })
      ]);
    }
  };
}

export { ALL_CONDITIONS, ASK_DISCOUNT, ASK_TRUST_FROM, CATEGORY_ID, CONDITIONS, CONDITION_ID, CONDITION_NAME, DEFAULT_CHROME_USER_AGENT, DEFAULT_USER_AGENT, FACTOR, GRADERS, GRADES, INDEX_GAMES, NOT_THE_PRODUCT, SALE_HALF_LIFE_DAYS, SKU_DEFAULT_COOLDOWN_MS, SKU_DEFAULT_MIN_INTERVAL_MS, STALE_MARKET_AGE_DAYS, TRUSTED, askFloorOf, askPool, assembleLadder, assess, assignTier, blendLevels, confidenceOf, corroborationFor, createMemoryCache, createPricing, currentEdition, editionKey, enforceMonotonic, extValue, finish, fromCents, gameForProductLine, gradeLabelFor, imageUrl, ladderFromEvidence, median, mergedEditions, nameSim, normNum, normNumber, normText, numMatch, numberScore, numberTokens, numberTotal, numberingOk, pickSubType, priceFromEvidence, recencyWeight, round2, saleAgeDays, saneMarketPrice, scorePcHit, splitProductName, toCents, weightedMedian, withBuffer, withoutOutliers };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map