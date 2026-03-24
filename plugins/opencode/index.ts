import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createClwnd, setSharedClient, setLogClient, hum, trace } from "./provider.ts";

// ─── Small Model Discovery ──────────────────────────────────────────────────
// Provider config lives in opencode.json (managed by install script).
// Plugin only discovers a free model for small tasks at runtime.

async function syncSmallModel(client: any): Promise<void> {
  try {
    const current = await client.config.get();
    const currentSmall = (current?.data as any)?.small_model;
    if (currentSmall) return; // user or prior run already set it

    const providers = await client.provider.list();
    const all = (providers?.data as any)?.all ?? [];
    for (const p of all) {
      if (p.id === "opencode-clwnd") continue;
      for (const [mid, m] of Object.entries(p.models) as [string, any][]) {
        if (m.cost && m.cost.input === 0 && m.cost.output === 0 && m.tool_call) {
          const pick = `${p.id}/${mid}`;
          await client.config.update({ body: { small_model: pick } });
          trace("small.synced", { model: pick });
          return;
        }
      }
    }
  } catch (e) {
    trace("small.sync.failed", { err: String(e) });
  }
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  setLogClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  // Discover free model for title gen / compaction
  syncSmallModel(input.client).catch(() => {});

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
