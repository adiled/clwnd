import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createClwnd, setSharedClient, setLogClient, hum, trace } from "./provider.ts";

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  setLogClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  return {
    models: {
      clwnd: provider,
    },
    "chat.headers": async (ctx, output) => {
      output.headers["x-clwnd-agent"] = typeof ctx.agent === "string"
        ? ctx.agent
        : (ctx.agent as any)?.name ?? JSON.stringify(ctx.agent);
    },
    // Permission tool — provider emits clwnd_permission with providerExecuted: false.
    // OC executes via resolveTools() → ctx.ask() → TUI permission dialog.
    tool: {
      clwnd_permission: tool({
        description: "Permission prompt for clwnd file system operations",
        args: {
          tool: tool.schema.string().describe("Tool name requesting permission"),
          path: tool.schema.string().optional().describe("File path"),
          askId: tool.schema.string().optional().describe("Permission ask ID"),
        },
        async execute(args, ctx) {
          trace("permission.tool.invoked", { tool: args.tool, path: args.path });

          await ctx.ask({
            permission: args.tool === "edit" || args.tool === "write" ? "edit" : args.tool,
            patterns: [args.path ?? "*"],
            metadata: { tool: args.tool, filepath: args.path },
            always: [args.path ?? "*"],
          });

          // User approved — release the permit hold via hum
          const askId = args.askId;
          trace("permission.tool.approved", { tool: args.tool, askId });
          if (askId) {
            hum({ chi: "release-permit", askId, decision: "allow" });
          }

          return `Permission granted for ${args.tool}`;
        },
      }),
    },
  };
};

export { createClwnd };
