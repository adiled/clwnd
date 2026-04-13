import { defineConfig } from "tsup";
// Only build the server plugin. TUI plugin is raw .tsx — OC transpiles
// it at runtime via Bun. No build step needed or wanted.
export default defineConfig({
  entry: { index: "index.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node18",
  dts: false,
  external: [],
  noExternal: [/@ai-sdk\/.*/],
});
