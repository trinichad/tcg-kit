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
Phase 1 in progress — `/recognize` and `/catalog` extracted and verified; `/pricing` in flight. See the Holo Hunting repo, `architecture/rip-game-backoffice.md`.
