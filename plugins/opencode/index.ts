import type { Plugin } from "@opencode-ai/plugin";
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

interface PendingPermission {
  resolve: (decision: "allow" | "deny") => void;
  tool: string;
  path?: string;
  sessionId: string;
  timestamp: number;
}

const pendingPermission: { current: PendingPermission | null } = { current: null };

function registerPermissionHandler(client: any, serverUrl: URL): void {
  onDaemonMessage("permission-ask", async (payload: {
    id: string;
    sessionId: string;
    tool: string;
    path?: string;
    input: Record<string, unknown>;
  }) => {
    trace("permission.ask", { id: payload.id, tool: payload.tool, path: payload.path });

    // Show toast telling user to /allow or /deny (fire and forget — don't block)
    const pathDisplay = payload.path ?? "*";
    client.tui.showToast({
      body: {
        title: "Permission required",
        message: `${payload.tool} on ${pathDisplay} — type /allow or /deny`,
        variant: "warning" as const,
        duration: 30000,
      },
    }).then(() => trace("permission.toast.shown")).catch((e: any) => trace("permission.toast.failed", { err: String(e) }));

    // Wait for /allow or /deny command, or timeout/interruption
    const decision = await new Promise<"allow" | "deny">((resolve) => {
      pendingPermission.current = {
        resolve,
        tool: payload.tool,
        path: payload.path,
        sessionId: payload.sessionId,
        timestamp: Date.now(),
      };

      // Timeout after 120s — deny by default
      setTimeout(() => {
        if (pendingPermission.current?.timestamp === Date.now()) {
          // Stale check — only timeout if this is still the same request
        }
        if (pendingPermission.current?.resolve === resolve) {
          pendingPermission.current = null;
          trace("permission.timeout", { id: payload.id });
          resolve("deny");
        }
      }, 120_000);
    });

    trace("permission.decided", { id: payload.id, decision });
    return { decision };
  });
}

// ─── Plugin ────────────────────────────────────────────────────────────────

export const clwndPlugin: Plugin = async (input) => {
  setSharedClient(input.client);
  const provider = createClwnd({ client: input.client, pluginInput: input });

  registerPermissionHandler(input.client, input.serverUrl);
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
    // Intercept /allow and /deny commands
    "command.execute.before": async (input, output) => {
      const cmd = input.command;
      if (cmd === "allow" || cmd === "deny") {
        const pending = pendingPermission.current;
        if (pending) {
          const decision = cmd === "allow" ? "allow" : "deny";
          trace("permission.command", { cmd, tool: pending.tool, decision });
          pendingPermission.current = null;
          pending.resolve(decision as "allow" | "deny");
          // Clear parts so nothing gets sent to the model
          output.parts = [];
        } else {
          trace("permission.command.no-pending", { cmd });
          // No pending permission — clear parts, show toast
          try {
            await input.client?.tui?.showToast?.({
              body: { message: "No pending permission request", variant: "info" as const, duration: 3000 },
            });
          } catch {}
          output.parts = [];
        }
      }
    },
    // If user sends a regular message while permission is pending, auto-deny
    "chat.message": async (ctx, output) => {
      if (pendingPermission.current) {
        trace("permission.interrupted", { by: "chat.message" });
        const pending = pendingPermission.current;
        pendingPermission.current = null;
        pending.resolve("deny");
      }
    },
  };
};

export { createClwnd };
