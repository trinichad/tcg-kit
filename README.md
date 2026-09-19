# @holo/tcg-kit

Reusable TCG tooling for Holo Hunting apps, in three entry points:

| Import | Runs in | What |
|---|---|---|
| `@holo/tcg-kit/pricing` | server only | market value by TCGplayer product id: tcgcsv (bulk), TCGplayer live (exact per-condition, paced), PriceCharting (graded); resolve name/set/number → product; tiers + % buffer |
| `@holo/tcg-kit/recognize` | browser worker + Node | camera frame → card → perceptual hash → nearest match in the card index |
| `@holo/tcg-kit/catalog` | anywhere | category/set maps, per-game printing tables, the card index data (`data/cardindex`) and the weekly updater |

## Provenance
Extracted, with the algorithms kept intact, from:
- **BinderPricer** `e995c9e` — `server/core/*` (pricing), `shared/*` (recognition, catalogues), `scripts/*` + `.github/workflows` (index updater, canary, battery), `public/cardindex` (index data).
- **PokedexDebut** `87268c9` — TCGplayer `infinite-api` per-SKU market source, condition-ladder scaling, number/variant normalizers, LINK GREEN probes.

## Consuming
Private repo → install from git with a token available to the installer:
```json
"@holo/tcg-kit": "github:trinichad/tcg-kit#v0.1.0"
```
`dist/` is committed, so no build step runs on install. Import `/pricing` only from server code.


## `@holo/tcg-kit/pricing` — market value (server-side only)

```ts
import { createPricing, withBuffer, assignTier, toCents } from "@holo/tcg-kit/pricing";

const pricing = createPricing({
  userAgent: "MyApp/1.0 (+https://example.com)",   // identifying UA — tcgcsv/PriceCharting block browser UAs
  cache: myTursoCacheStore,                          // optional; default in-memory (200 entries, never caches null)
  tokens: { pricecharting, psa, ebay: { clientId, clientSecret } },   // all optional; enable extra sources
});

// name/set/number → TCGplayer product → printing → all five conditions
const card = await pricing.lookupPrice({ game: "pokemon", name: "Charizard", setName: "Base Set", number: "4/102", printing: "Holofoil" });
// card.match.productId === 42382, card.quotes.NM.price === 882.02, card.confidence === "exact"

const value = withBuffer(toCents(card.quotes.NM.price), 5);            // +5% → 92621 cents
const { tier, nearBoundary } = assignTier(value, tiers, { marginPct: 10 });
```

**Resolve once, price by id forever.** `resolveCard`/`search` are the fuzzy, expensive step (they
refuse to guess: `status: "uncertain"` + candidates). Persist `productId` + `subType` and re-price
with `price` / `priceAll` / `priceMany` — deterministic and cheap.

| Method | Purpose |
|---|---|
| `search(q, game?)` | free text, a tcgplayer.com URL, or a bare product id |
| `resolveCard(q)` / `resolveMany(qs)` | name / set / number / printing → `ProductMatch` (name 0.5 · number 0.35 · set 0.15, with the set-code collision guards) |
| `price(ref)` / `priceAll(ref)` | one condition / all five, by `productId` + `subType` |
| `priceMany(refs)` | bulk; respects provider pacing; never throws per item |
| `groupPrices(categoryId, groupId)` | **the bulk path**: every product in a set in one tcgcsv call, `saneMarketPrice` applied |
| `priceGraded(q)` | PSA / BGS / CGC / SGC / TAG slabs via PriceCharting (+ eBay comps with a key) |
| `lookupPrice(q)` | resolve → `pickSubType` → `priceAll`, with a confidence |
| `crossCheck(game, name)` | Scryfall (MTG) / YGOPRODeck (YGO) sanity check |
| `healthcheck()` | LINK GREEN probes for every provider |

**Sources, in the order `quote()` trusts them:** `tcg_market` (TCGplayer per-SKU market — exact per
printing × condition; **paced: one request at a time, ≥1.2 s apart**) → `sales` (recent exact-condition
solds, outliers outside 0.4×–3× dropped) → `sales_adj` → `market` / `market_adj` (tcgcsv product market
× condition factor) → `ask` (floor guard). When any rung has a `tcg_market`, missing rungs are `scaled`
from the nearest TCGplayer rung and clamped between trusted neighbours; otherwise the ladder is forced
monotonic by weighted isotonic regression. **Nothing "corrects" a TCGplayer number.**

`confidenceOf(quote)`: `exact` (tcg_market, graded, or ≥2 exact-condition solds) · `estimated`
(scaled / factor-adjusted) · `low` (bare product market, single sale, ask). **Never tier a card on
`low` without a human look** — bare product `market` can sit 3–10× above every condition rung.

Scripts: `npm run canary` (26 live assertions — the daily regression signal), `npm run battery`
(50 raw + 50 graded), `npm run probes` (LINK GREEN), `npm run demo`.

**Caveats the code carries honestly:** the TCGplayer sold/ask/SKU endpoints and PriceCharting's pages
are unofficial and can change without notice — a broken scrape returns 200 with no data, which is why
the canary exists. eBay numbers are asks, not sales. PriceCharting scraping of sportscardspro does not
work from datacenter IPs (needs the paid token). Graded coverage has holes for some modern cards.

## `@holo/tcg-kit/recognize` — scanning

Isomorphic, zero dependencies, no Node built-ins: runs in a browser Web Worker or in Node.
The hasher is byte-identical to BinderPricer's (29 bytes per card: pHash + dHash + art-pHash +
colour), so the shipped index matches what it produces — the integration test fetches real
card images and gets distance 0 against the index.

```ts
// worker.ts
import { createScanner } from "@holo/tcg-kit/recognize";
import { gamesForHint } from "@holo/tcg-kit/catalog";

const scanner = await createScanner({
  load: async (file) => {                 // 'manifest.json' | 'pokemon.bin?v=…' | 'pokemon.json?v=…'
    const r = await fetch(`/cardindex/${file}`, { cache: file.startsWith("manifest") ? "no-cache" : "default" });
    if (!r.ok) throw new Error(`${file}: http ${r.status}`);
    return file.includes(".json") ? r.text() : r.arrayBuffer();
  },
  games: gamesForHint("pokemon"),
  preferGame: "pokemon",                  // language prior when both Pokémon catalogues are loaded
});
self.onmessage = async (e) =>             // main thread transfers one ImageData at a time
  self.postMessage(await scanner.matchFrame(new Uint8ClampedArray(e.data.buffer), e.data.width, e.data.height));
```

`matchFrame` = detect card outline → rectify → hash → nearest neighbours (`{ detected, quad, matches }`);
`matchCard` for an already-cropped card; `hash` returns the raw 29 bytes for callers that cache.
`matches[0].confidence` is the same number BinderPricer's worker reports.

## `@holo/tcg-kit/catalog` — maps, printings, index data

- `CATEGORY_ID`, `INDEX_GAMES`, `LANGUAGE`, `FAMILY`, `languagePrior`, `gamesForHint` — verbatim from BinderPricer.
- `GAMES` registry: `pokemon` (enabled, category 3) and `onepiece` (category 68, **disabled** until its
  sibling-product selection is built — on One Piece, alternate/parallel art is a separate *product*, not
  a printing; tcgcsv reports only `Normal` and `Foil` sub-types).
- `pokemonPrintings` — TCGplayer printing vocabulary, `parseOwned("044/102 1st Edition Reverse Holo")`,
  Shadowless group handling, and the fallback chain (`want → want − " Holofoil" → Normal → first`).
- `INDEX_FILES` / `indexFilesFor(games)` / `manifestFor(manifest, games)` — what to copy for a consumer.

**Shipping the index to an app:** copy `data/cardindex/*` (16 MB, or just the games you need) into the
app's `public/cardindex/`. From inside this repo: `npm run copy-index -- <destDir> --games pokemon`.
From a consumer: the files are resolvable as `@holo/tcg-kit/data/cardindex/<file>`.

## Index updater

`npm run update-index` (also `.github/workflows/update-index.yml`, Mondays 09:23 UTC) fingerprints new
TCGplayer products incrementally and commits `data/cardindex` as the repository owner. Safety rules —
unreleased sets skipped, identical-image clusters dropped, a 404'd set keeps its cards, no-op runs leave
`manifest.json` byte-identical — are pinned by `npm run index-check` (38 offline assertions).

## Status
**v0.1.0 — Phase 1 complete.** typecheck clean · 82 unit tests · canary 26 pass / 0 fail / 2 skip (sports fixtures need a PriceCharting token) · probes LINK GREEN · recognizer integration test distance 0 on real card images. Consumers: the Holo Hunting site (Phase 2). Design: Holo repo `architecture/rip-game-backoffice.md`.
