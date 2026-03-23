import type { Plugin } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { createClwnd, setSharedClient, trace } from "./provider.ts";

const SOCK_PATH = (process.env.CLWND_SOCKET ??
  (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/clwnd/clwnd.sock` : "/tmp/clwnd/clwnd.sock")) + ".http";

// ─── Daemon ↔ Plugin Channel ───────────────────────────────────────────────

type ChannelHandler = (payload: any) => Promise<any>;
const channelHandlers = new Map<string, ChannelHandler>();

function onDaemonMessage(type: string, handler: ChannelHandler): void {
  channelHandlers.set(type, handler);
}

async function startCallbackServer(): Promise<string> {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("", { status: 405 });
      try {
        const body = await req.json() as { type: string; id: string; payload: any };
        trace("channel.recv", { type: body.type, id: body.id });
        const handler = channelHandlers.get(body.type);
        if (!handler) return Response.json({ error: `no handler for ${body.type}` }, { status: 404 });
        const result = await handler(body.payload);
        return Response.json({ id: body.id, result });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 500 });
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  trace("channel.started", { url });

  try {
    await fetch("http://localhost/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      unix: SOCK_PATH,
    } as RequestInit);
    trace("channel.registered", { url });
  } catch (e) {
    trace("channel.register.failed", { err: String(e) });
  }

  return url;
}

// ─── Permission Ask State ──────────────────────────────────────────────────
// When the daemon holds a permission_prompt MCP call and sends permission_ask
// on the stream, the provider emits a permission tool call for clwnd_permission.
// OC executes it → the plugin tool's execute() fires → calls ctx.ask() →
// TUI dialog → user responds → we resolve the pending permission here →
// daemon unblocks permission_prompt → Claude CLI proceeds.

interface PendingPermission {
  resolve: (decision: "allow" | "deny") => void;
  tool: string;
  path?: string;
  askId: string;
}

const pendingPermission: { current: PendingPermission | null } = { current: null };

function registerPermissionHandler(): void {
  onDaemonMessage("permission-ask", async (payload: {
    id: string;
    sessionId: string;
    tool: string;
    path?: string;
    input: Record<string, unknown>;
  }) => {
    trace("permission.ask", { id: payload.id, tool: payload.tool, path: payload.path });

    // Wait for the plugin tool to resolve this via ctx.ask()
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      pendingPermission.current = {
        resolve,
        tool: payload.tool,
        path: payload.path,
        askId: payload.id,
      };

      // Timeout after 5 min — deny by default
      setTimeout(() => {
        if (pendingPermission.current?.askId === payload.id) {
          pendingPermission.current = null;
          trace("permission.timeout", { id: payload.id });
          resolve("deny");
        }
      }, 300_000);
    });

    trace("permission.decided", { id: payload.id, decision });
    return { decision };
  });
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  registerPermissionHandler();
  startCallbackServer().catch(() => {});

  return {
    models: {
      clwnd: provider,
    },
    "chat.headers": async (ctx, output) => {
      output.headers["x-clwnd-agent"] = typeof ctx.agent === "string"
        ? ctx.agent
        : (ctx.agent as any)?.name ?? JSON.stringify(ctx.agent);
    },
    // Plugin tool for permission prompts. The provider emits a permission tool call
    // to this tool with providerExecuted: false. OC executes it via
    // resolveTools() → execute() → ctx.ask() → TUI permission dialog.
    tool: {
      clwnd_permission: tool({
        description: "Permission prompt for clwnd file system operations",
        args: {
          tool: tool.schema.string().describe("Tool name requesting permission"),
          path: tool.schema.string().optional().describe("File path"),
          askId: tool.schema.string().optional().describe("Permission ask ID"),
        },
        async execute(args, ctx) {
          trace("clwnd_permission.execute", { tool: args.tool, path: args.path });

          // Call ctx.ask() — this triggers OC's PermissionNext.ask() → TUI dialog
          await ctx.ask({
            permission: args.tool === "edit" || args.tool === "write" ? "edit" : args.tool,
            patterns: [args.path ?? "*"],
            metadata: { tool: args.tool, filepath: args.path },
            always: [args.path ?? "*"],
          });

          // User approved. Tell daemon to unblock the permission_prompt MCP.
          const askId = args.askId;
          trace("clwnd_permission.approved", { tool: args.tool, askId });
          if (askId) {
            try {
              const resp = await fetch("http://localhost/permission-result", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ askId, decision: "allow" }),
                unix: SOCK_PATH,
              } as RequestInit);
              trace("clwnd_permission.resolved", { askId, status: resp.status });
            } catch (e) {
              trace("clwnd_permission.resolve.failed", { askId, err: String(e) });
            }
          }

          return `Permission granted for ${args.tool}`;
        },
      }),
    },
  };
};

export { createClwnd };
