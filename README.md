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

## Status
Phase 1 in progress — see the Holo Hunting repo, `architecture/rip-game-backoffice.md`.
