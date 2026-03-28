import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createClwnd, setSharedClient, setLogClient, hum, trace, log, resetTurnsSent } from "./provider.ts";
import { loadConfig, type ClwndConfig } from "../../lib/config.ts";

// ─── Small Model Discovery ──────────────────────────────────────────────────
// Provider config lives in opencode.json (managed by install script).
// Plugin only discovers a free model for small tasks at runtime.

async function syncSmallModel(client: any, cfg: ClwndConfig): Promise<void> {
  try {
    const current = await client.config.get();
    const currentSmall = (current?.data as any)?.small_model;
    if (currentSmall) return; // user or prior run already set it

    // Use clwnd.json configured model if set
    if (cfg.smallModel) {
      await client.config.update({ body: { small_model: cfg.smallModel } });
      log("small.synced", { model: cfg.smallModel, source: "config" });
      return;
    }

    // Auto-discover a free model
    const providers = await client.provider.list();
    const all = (providers?.data as any)?.all ?? [];
    for (const p of all) {
      if (p.id === "opencode-clwnd") continue;
      for (const [mid, m] of Object.entries(p.models) as [string, any][]) {
        if (m.cost && m.cost.input === 0 && m.cost.output === 0 && m.tool_call) {
          const pick = `${p.id}/${mid}`;
          await client.config.update({ body: { small_model: pick } });
          log("small.synced", { model: pick, source: "auto" });
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

  log("plugin.loaded", { directory: input.directory });

  // Toast version update on first load after upgrade
  try {
    const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
    const version = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version ?? "unknown";
    const stateDir = `${process.env.XDG_STATE_HOME || process.env.HOME + "/.local/state"}/clwnd`;
    const versionFile = join(stateDir, "last-plugin-version");
    let lastVersion = "";
    try { lastVersion = readFileSync(versionFile, "utf8").trim(); } catch {}
    if (lastVersion && lastVersion !== version) {
      input.client.tui.showToast({
        body: { title: "clwnd updated", message: `v${lastVersion} → v${version}`, variant: "success", duration: 5000 },
      }).catch(() => {});
    }
    try { mkdirSync(stateDir, { recursive: true }); writeFileSync(versionFile, version); } catch {}
  } catch {}

  // Delay to avoid config update triggering OC reload during startup
  const cfg = loadConfig();
  setTimeout(() => syncSmallModel(input.client, cfg).catch(() => {}), 10000);

  return {
    models: {
      clwnd: provider,
    },
    event: async ({ event }) => {
      // OC-handled compaction: opt-in via clwnd.json { "ocCompaction": true }
      // When off (default), Claude CLI handles its own context management.
      if (loadConfig().ocCompaction && event.type === "session.compacted") {
        const sid = (event as any).properties?.sessionID;
        if (sid) {
          // Deduplicate — multiple plugin instances receive the same event
          const key = `compacted:${sid}`;
          if ((globalThis as any)[key]) return;
          (globalThis as any)[key] = true;
          setTimeout(() => delete (globalThis as any)[key], 5000);

          trace("session.compacted", { sid });
          resetTurnsSent(sid);
          hum({ chi: "cancel", sid });
        }
      }
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
