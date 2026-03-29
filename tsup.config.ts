import { defineConfig } from "tsup";
export default defineConfig({
  entry: { index: "daemon/daemon.ts" },
  outDir: "dist/daemon",
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["bun", "bun:sqlite"],
});
