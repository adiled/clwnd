import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { createClwnd, setSharedClient, setSharedPluginInput, setLogClient, hum, trace, log } from "./provider.ts";
import { loadConfig, type ClwndConfig } from "../../lib/config.ts";
import { duskIn } from "../../lib/hum.ts";

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
  setSharedPluginInput(input);
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
        body: { title: "clwnd updated", message: `v${lastVersion} → v${version} ~ clwnd`, variant: "success", duration: 5000 },
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
      // The sentinel's ears — hum every session event to the daemon
      const etype = event.type;
      const props = (event as any).properties ?? {};

      // Message events — daemon tracks full conversation across all providers
      if (etype === "message.updated" && props.info) {
        const sid = props.info.sessionID ?? props.info.metadata?.sessionID;
        const role = props.info.role;
        const model = props.info.modelID ?? props.info.metadata?.assistant?.modelID;
        const provider = props.info.providerID ?? props.info.metadata?.assistant?.providerID;
        const messageId = props.info.id;
        const parentId = props.info.parentID;
        const completed = props.info.metadata?.time?.completed;
        if (sid && role) {
          hum({ chi: "petal-cell", sid, event: etype, role, model, provider, messageId, parentId, completed });
        }
      }

      // OC-handled compaction: opt-in via clwnd.json
      if (loadConfig().ocCompaction && etype === "session.compacted") {
        const sid = props.sessionID;
        if (sid) {
          // Deduplicate — multiple plugin instances receive the same event
          const key = `compacted:${sid}`;
          if ((globalThis as any)[key]) return;
          (globalThis as any)[key] = true;
          setTimeout(() => delete (globalThis as any)[key], 5000);

          trace("session.compacted", { sid });
          hum({ chi: "cancel", sid, reason: "compaction", dusk: duskIn(5_000) });
        }
      }
    },
    "chat.headers": async (ctx, output) => {
      output.headers["x-clwnd-agent"] = typeof ctx.agent === "string"
        ? ctx.agent
        : (ctx.agent as any)?.name ?? JSON.stringify(ctx.agent);
    },
    // Custom tools registered with OC's tool registry. Each one delegates
    // to clwnd's daemon via the same MCP HTTP endpoint that Claude CLI uses
    // — JSON-RPC POST to http://127.0.0.1:29147/s/<sid> with method
    // tools/call. No new transport, no new vocabulary: plugin tools and
    // Claude CLI tools share the exact same executeTool() dispatch.
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

          const t0 = Date.now();
          await ctx.ask({
            permission: args.tool === "do_code" || args.tool === "do_noncode" ? "edit" : args.tool,
            patterns: [args.path ?? "*"],
            metadata: { tool: args.tool, filepath: args.path },
            always: [args.path ?? "*"],
          });
          const elapsed = Date.now() - t0;

          // Return askId in result — provider's doStream releases the hold
          // AFTER registering its listener, so Claude's post-permission events are captured
          const askId = args.askId;
          trace("permission.tool.approved", { tool: args.tool, askId, elapsed, autoAllowed: elapsed < 100 });

          return JSON.stringify({ granted: true, tool: args.tool, askId });
        },
      }),
      do_code: tool({
        description: `Author code in a code file via AST-grounded operations. Accepts: .ts/.tsx/.js/.jsx/.py/.go/.rs/.java/.cpp/... (code files only; non-code is rejected — use do_noncode for that). Five operations:
- operation: 'create', new_source: '<code>'  — create a new file with new_source as its content. Re-parsed for syntax, rejected if invalid.
- operation: 'replace', symbol: 'Class.method', new_source: '<full new source of that symbol>'  — byte-range splice replacing the symbol with new_source. Re-parsed.
- operation: 'replace', new_source: '<whole file>'  — full-file rewrite, re-parsed.
- operation: 'insert_after' | 'insert_before', symbol: 'NAME', new_source: '<new code block>'  — add a new symbol adjacent to an anchor. Re-parsed.
- operation: 'delete', symbol: 'NAME'  — remove a symbol. Re-parsed.
Before calling do_code on an existing file, run read(file_path) or read(file_path, symbol: '...') first — clwnd's staleness guard rejects edits whose baseline is older than the current mtime. There is no old_string/new_string vocabulary here — this is NOT a string replace tool.`,
        args: {
          file_path: tool.schema.string().describe("Absolute path to the code file"),
          operation: tool.schema.enum(["create", "replace", "insert_before", "insert_after", "delete"]).optional().describe("Operation to perform (default: replace)"),
          symbol: tool.schema.string().optional().describe("Target symbol name (required for insert/delete, optional for replace)"),
          new_source: tool.schema.string().optional().describe("New source code (required for create/replace/insert)"),
        },
        async execute(args, ctx) {
          return callClwndTool("do_code", args, ctx.sessionID);
        },
      }),
      do_noncode: tool({
        description: `Author non-code files (configs, docs, JSON, YAML, Markdown, txt, …). Rejects any file with a code extension — use do_code for those. Modes:
- mode: 'write' (default) — create or overwrite with content
- mode: 'append' — add content to the end of an existing file
- mode: 'prepend' — add content to the start of an existing file
For existing files, read(file_path) first so clwnd's staleness guard knows your baseline.`,
        args: {
          file_path: tool.schema.string().describe("Absolute path to the non-code file"),
          content: tool.schema.string().describe("Content to write/append/prepend"),
          mode: tool.schema.enum(["write", "append", "prepend"]).optional().describe("Write mode (default: write)"),
        },
        async execute(args, ctx) {
          return callClwndTool("do_noncode", args, ctx.sessionID);
        },
      }),
    },
  };
};

// Dispatch a tool call to clwnd's daemon MCP endpoint. Same transport and
// JSON-RPC shape Claude CLI uses when it calls mcp__clwnd__<tool>. The port
// is pinned (29147) so there's no discovery ceremony — if you change the
// port in daemon.ts, change it here too.
const CLWND_MCP_PORT = parseInt(process.env.CLWND_MCP_PORT ?? "29147") || 29147;
const CLWND_MCP_HOST = process.env.CLWND_MCP_HOST ?? "127.0.0.1";

async function callClwndTool(name: string, args: Record<string, unknown>, sessionID: string): Promise<string> {
  const url = `http://${CLWND_MCP_HOST}:${CLWND_MCP_PORT}/s/${sessionID}`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return `Error: clwnd MCP endpoint returned HTTP ${response.status}`;
    const data = await response.json() as {
      result?: { content?: Array<{ type: string; text?: string }>; isError?: boolean };
      error?: { message: string };
    };
    if (data.error) return `Error: ${data.error.message}`;
    const content = data.result?.content ?? [];
    return content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") || "(no output)";
  } catch (e) {
    return `Error: failed to reach clwnd daemon at ${url} — ${e instanceof Error ? e.message : String(e)}`;
  }
}

export { createClwnd } from "./provider.ts";
