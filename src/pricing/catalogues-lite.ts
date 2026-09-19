// Catalogue constants live in src/catalog (single source of truth). This module
// only re-exports the two names the pricing engine needs so its internal imports
// stay stable; the catalog entry point exposes the full set.
export { CATEGORY_ID, INDEX_GAMES, type IndexGame } from "../catalog/catalogues";
