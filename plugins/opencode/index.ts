import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd } from "./provider.ts";

export const clwndPlugin: Plugin = async (input) => {
  const provider = createClwnd({ client: input.client, pluginInput: input });

  return {
    models: {
      clwnd: provider,
    },
    "chat.headers": async (ctx, output) => {
      output.headers["x-clwnd-agent"] = typeof ctx.agent === "string" ? ctx.agent : (ctx.agent as any)?.name ?? JSON.stringify(ctx.agent);
    },
  };
};

// Provider loader looks for exports starting with "create".
// This is NOT a Plugin function — the plugin loader will call it
// but it returns a provider factory (not hooks), which is safely ignored.
export { createClwnd };
