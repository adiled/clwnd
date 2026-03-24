import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createClwnd, setSharedClient, setLogClient, hum, trace } from "./provider.ts";

// ─── Model Registry ─────────────────────────────────────────────────────────

function loadRegistry(): Record<string, any> {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    // dist/index.js → ../../models.json (plugins/opencode/dist → project root)
    const candidates = [
      join(dir, "..", "..", "..", "models.json"),  // deployed: src/plugins/opencode/dist → src/
      join(dir, "..", "..", "models.json"),         // dev: plugins/opencode/dist → root
      join(dir, "..", "models.json"),               // flat
    ];
    for (const p of candidates) {
      try { return JSON.parse(readFileSync(p, "utf8")); } catch {}
    }
    return {};
  } catch {
    return {};
  }
}

function pluginRef(): string {
  return `file://${fileURLToPath(import.meta.url)}`;
}

async function syncConfig(client: any): Promise<void> {
  const registry = loadRegistry();
  const ref = pluginRef();

  // Build desired model config
  const models: Record<string, any> = {};
  for (const [id, entry] of Object.entries(registry) as [string, any][]) {
    models[id] = {
      id,
      name: entry.name,
      tool_call: entry.tool_call ?? true,
      limit: entry.limit,
      provider: { npm: ref },
    };
  }

  // Discover a free model for small tasks (title gen, compaction)
  let smallModel: string | undefined;
  try {
    const providers = await client.provider.list();
    const all = providers?.data?.all ?? [];
    for (const p of all) {
      if (p.id === "opencode-clwnd") continue;
      for (const [mid, m] of Object.entries(p.models) as [string, any][]) {
        if (m.cost && m.cost.input === 0 && m.cost.output === 0 && m.tool_call) {
          smallModel = `${p.id}/${mid}`;
          trace("small.discovered", { model: smallModel, provider: p.id });
          break;
        }
      }
      if (smallModel) break;
    }
  } catch {}

  // Only update if config differs — avoids OC restart loop on config change
  try {
    const current = await client.config.get();
    const currentConfig = current?.data as Record<string, any> ?? {};
    const currentProvider = currentConfig?.provider?.["opencode-clwnd"];
    const currentSmall = currentConfig?.small_model;

    const wantedProvider = { npm: ref, models };
    const needsProviderUpdate = JSON.stringify(currentProvider) !== JSON.stringify(wantedProvider);
    const needsSmallUpdate = smallModel && currentSmall !== smallModel;

    if (needsProviderUpdate || needsSmallUpdate) {
      const patch: Record<string, any> = {};
      if (needsProviderUpdate) patch.provider = { "opencode-clwnd": wantedProvider };
      if (needsSmallUpdate) patch.small_model = smallModel;
      await client.config.update({ body: patch });
      trace("config.synced", { models: Object.keys(models).length, smallModel, updated: true });
    } else {
      trace("config.synced", { updated: false });
    }
  } catch (e) {
    trace("config.sync.failed", { err: String(e) });
  }
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  setLogClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  // Sync provider models + small_model via OC API
  syncConfig(input.client).catch(() => {});

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
