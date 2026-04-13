import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "index.ts" },
  format: "esm",
  platform: "node",
  target: "node18",
  external: ["@ai-sdk/provider", "@ai-sdk/provider-utils", "@opencode-ai/plugin", "@opencode-ai/sdk"],
});
