import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, setSharedClient, trace } from "./provider.ts";

const SOCK_PATH = (process.env.CLWND_SOCKET ??
  (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/clwnd/clwnd.sock` : "/tmp/clwnd/clwnd.sock")) + ".http";

// ─── Daemon ↔ Plugin Channel ───────────────────────────────────────────────
// Generic bidirectional communication. The daemon POSTs typed messages to the
// plugin's callback server. Handlers are registered per message type.
// Used for: permission asks, question tool, and any future interactive flow.

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
        if (!handler) {
          trace("channel.no-handler", { type: body.type });
          return Response.json({ error: `no handler for ${body.type}` }, { status: 404 });
        }

        const result = await handler(body.payload);
        return Response.json({ id: body.id, result });
      } catch (e) {
        trace("channel.error", { err: String(e) });
        return Response.json({ error: String(e) }, { status: 500 });
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  trace("channel.started", { url });

  // Register with daemon
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

// ─── Permission Ask Handler ────────────────────────────────────────────────

function registerPermissionHandler(): void {
  // Import PermissionNext directly from OC's internals — we're inside OC's process
  let PermissionNext: any = null;
  try {
    PermissionNext = require("@/permission/next").PermissionNext;
  } catch {
    try {
      // Fallback: try relative path from opencode's node_modules
      PermissionNext = require("@opencode-ai/opencode/src/permission/next").PermissionNext;
    } catch {
      trace("permission.import.failed", { msg: "PermissionNext not available" });
    }
  }

  onDaemonMessage("permission-ask", async (payload: {
    id: string;
    sessionId: string;
    tool: string;
    path?: string;
    input: Record<string, unknown>;
  }) => {
    trace("permission.ask", { id: payload.id, tool: payload.tool, path: payload.path });

    if (!PermissionNext) {
      trace("permission.ask.no-module");
      return { decision: "deny" };
    }

    try {
      // Call PermissionNext.ask() directly — this creates a pending permission,
      // publishes permission.asked on OC's bus, and the TUI shows the prompt.
      // The returned promise resolves when the user responds.
      await PermissionNext.ask({
        sessionID: payload.sessionId,
        permission: payload.tool,
        patterns: [payload.path ?? "*"],
        metadata: payload.input,
        always: [payload.path ?? "*"],
        ruleset: [], // empty — we already evaluated the ruleset in the daemon
      });
      // If ask() resolves, user approved
      trace("permission.ask.approved", { id: payload.id });
      return { decision: "allow" };
    } catch (e: any) {
      // If ask() rejects, user denied
      trace("permission.ask.denied", { id: payload.id, err: e?.message });
      return { decision: "deny" };
    }
  });
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  // Start the daemon ↔ plugin channel
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
  };
};

// Provider loader looks for exports starting with "create".
export { createClwnd };
