import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, ClwndModel } from "./provider.ts";

export const clwndPlugin: Plugin = async (input) => {
  // Pass the OpenCode client to the provider so it can query session permissions
  const provider = createClwnd({ client: input.client });

  return {
    models: {
      clwnd: provider,
    },
  };
};

export { createClwnd, ClwndModel };
