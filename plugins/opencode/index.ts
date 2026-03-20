import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, ClwndModel } from "./provider.ts";

export const clwndPlugin: Plugin = async () => ({
  models: {
    clwnd: createClwnd(),
  },
});

export { createClwnd, ClwndModel };
