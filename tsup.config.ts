import { defineConfig } from "tsup";

// Three entry points, each importable on its own:
//   @holo/tcg-kit/pricing   — server-side only (provider headers + secrets)
//   @holo/tcg-kit/recognize — isomorphic (browser Web Worker + Node)
//   @holo/tcg-kit/catalog   — maps + index helpers
export default defineConfig({
  entry: {
    "pricing/index": "src/pricing/index.ts",
    "recognize/index": "src/recognize/index.ts",
    "catalog/index": "src/catalog/index.ts",
  },
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
  platform: "neutral",
  splitting: false,
  treeshake: true,
});
