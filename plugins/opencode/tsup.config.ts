import { defineConfig } from "tsup";
export default defineConfig([
  // Server plugin (provider + tools)
  {
    entry: { index: "index.ts" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node18",
    dts: false,
    external: ["bun"],
    noExternal: [/@ai-sdk\/.*/],
  },
  // TUI plugin (sidebar widget)
  {
    entry: { tui: "tui.tsx" },
    outDir: "dist",
    format: "esm",
    platform: "node",
    target: "node18",
    dts: false,
    external: ["solid-js", "@opencode-ai/plugin", "@opentui/core", "@opentui/solid", "bun"],
    esbuildOptions(options) {
      // Preserve JSX for Solid — OC's runtime handles the transform
      options.jsx = "preserve";
    },
  },
]);
