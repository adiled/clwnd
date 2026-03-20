import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "index.ts" },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node18",
  dts: false,
  external: ["bun"],
  noExternal: [/@ai-sdk\/.*/],
});
