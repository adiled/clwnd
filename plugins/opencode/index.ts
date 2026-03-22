import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, ClwndModel } from "./provider.ts";

export const clwndPlugin: Plugin = async (input) => {
  const provider = createClwnd({ client: input.client, pluginInput: input });

  return {
    models: {
      clwnd: provider,
    },
  };
};

export { createClwnd, ClwndModel };
