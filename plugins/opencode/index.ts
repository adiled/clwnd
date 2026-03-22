import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, trace } from "./provider.ts";

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

// Pending requests waiting for async resolution (e.g., user interaction)
const pendingRequests = new Map<string, {
  resolve: (result: any) => void;
  type: string;
  payload: any;
}>();

function resolvePending(id: string, result: any): boolean {
  const entry = pendingRequests.get(id);
  if (!entry) return false;
  pendingRequests.delete(id);
  entry.resolve(result);
  return true;
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
  onDaemonMessage("permission-ask", async (payload: {
    id: string;
    sessionId: string;
    tool: string;
    path?: string;
    input: Record<string, unknown>;
  }) => {
    trace("permission.ask", { id: payload.id, tool: payload.tool, path: payload.path });

    // Store as pending — resolved when OC's permission.ask hook or event fires
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      pendingRequests.set(payload.id, {
        resolve,
        type: "permission-ask",
        payload,
      });

      // Timeout: default to deny after 120s
      setTimeout(() => {
        if (pendingRequests.has(payload.id)) {
          pendingRequests.delete(payload.id);
          trace("permission.timeout", { id: payload.id });
          resolve("deny");
        }
      }, 120_000);
    });

    return { decision };
  });
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
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
    // OC asks us about a permission — match against pending requests
    "permission.ask": async (permission, output) => {
      for (const [id, entry] of pendingRequests) {
        if (entry.type !== "permission-ask") continue;
        const toolMatch = permission.type === entry.payload.tool ||
          permission.type === `mcp__clwnd__${entry.payload.tool}`;
        if (toolMatch) {
          trace("permission.ask.matched", { permId: permission.id, reqId: id });
          output.status = "ask";
          entry.payload._permissionId = permission.id;
          return;
        }
      }
    },
    // Watch for permission replies and resolve pending requests
    event: async ({ event }) => {
      if (event.type === "permission.replied") {
        const props = (event as any).properties;
        const permId = props?.permissionID;
        const response = props?.response; // "once" | "always" | "reject"

        for (const [id, entry] of pendingRequests) {
          if (entry.type === "permission-ask" && entry.payload._permissionId === permId) {
            const decision = response === "reject" ? "deny" : "allow";
            trace("permission.replied", { reqId: id, response, decision });
            resolvePending(id, decision);
            return;
          }
        }
      }
    },
  };
};

// Provider loader looks for exports starting with "create".
export { createClwnd };
