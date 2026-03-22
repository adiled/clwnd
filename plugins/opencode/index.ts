import type { Plugin } from "@opencode-ai/plugin";
import { createClwnd, trace } from "./provider.ts";

const SOCK_PATH = (process.env.CLWND_SOCKET ??
  (process.env.XDG_RUNTIME_DIR ? `${process.env.XDG_RUNTIME_DIR}/clwnd/clwnd.sock` : "/tmp/clwnd/clwnd.sock")) + ".http";

/**
 * Start a callback server so the daemon can reach us for permission asks.
 * Returns the callback URL. The daemon will POST permission requests here.
 */
async function startCallbackServer(client: any): Promise<string> {
  const server = Bun.serve({
    port: 0, // random available port
    hostname: "127.0.0.1",
    async fetch(req) {
      if (req.method !== "POST") return new Response("", { status: 405 });
      try {
        const body = await req.json() as {
          id: string;
          sessionId: string;
          tool: string;
          path?: string;
          input: Record<string, unknown>;
        };
        trace("permission.ask.received", { id: body.id, tool: body.tool, path: body.path });

        // Use OC's permission.ask mechanism — we emit a permission event
        // and wait for the user's response via the session permissions API
        let decision: "allow" | "deny" = "deny";
        try {
          // Create a permission request in OC by calling the session API
          // OC's TUI will show the permission prompt
          const permId = body.id;
          // We need to trigger OC's permission flow. The client doesn't have
          // a "create permission" API — permissions are created internally.
          // Instead, we use the permission.ask hook output to control decisions.
          // For now, store the pending request and let the permission.ask hook handle it.
          pendingPermissions.set(permId, {
            resolve: null as any,
            body,
          });

          decision = await new Promise<"allow" | "deny">((resolve) => {
            const entry = pendingPermissions.get(permId)!;
            entry.resolve = resolve;

            // Timeout after 120s — default to deny
            setTimeout(() => {
              if (pendingPermissions.has(permId)) {
                pendingPermissions.delete(permId);
                resolve("deny");
              }
            }, 120_000);
          });
        } catch (e) {
          trace("permission.ask.error", { id: body.id, err: String(e) });
        }

        trace("permission.ask.decided", { id: body.id, decision });
        return Response.json({ id: body.id, decision });
      } catch (e) {
        return Response.json({ decision: "deny" }, { status: 500 });
      }
    },
  });

  const url = `http://127.0.0.1:${server.port}`;
  trace("callback.started", { url });

  // Register with daemon
  try {
    await fetch("http://localhost/callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
      unix: SOCK_PATH,
    } as RequestInit);
    trace("callback.registered", { url });
  } catch (e) {
    trace("callback.register.failed", { err: String(e) });
  }

  return url;
}

// Pending permission requests waiting for user response
const pendingPermissions = new Map<string, {
  resolve: (decision: "allow" | "deny") => void;
  body: { id: string; sessionId: string; tool: string; path?: string; input: Record<string, unknown> };
}>();

export const clwndPlugin: Plugin = async (input) => {
  const provider = createClwnd({ client: input.client, pluginInput: input });

  // Start callback server for daemon → plugin communication
  startCallbackServer(input.client).catch(() => {});

  return {
    models: {
      clwnd: provider,
    },
    "chat.headers": async (ctx, output) => {
      output.headers["x-clwnd-agent"] = typeof ctx.agent === "string" ? ctx.agent : (ctx.agent as any)?.name ?? JSON.stringify(ctx.agent);
    },
    // Intercept OC permission checks — resolve pending permission requests
    "permission.ask": async (permission, output) => {
      // Check if this permission matches a pending request from our daemon
      // The permission.id or metadata might help match
      for (const [id, entry] of pendingPermissions) {
        // Match by tool name and path
        const toolMatch = permission.type === entry.body.tool ||
          permission.type === `mcp__clwnd__${entry.body.tool}`;
        if (toolMatch) {
          trace("permission.ask.matched", { permId: permission.id, reqId: id });
          // Let OC handle it normally — set status to "ask" so the TUI shows the prompt
          output.status = "ask";
          // When the user responds, OC will emit permission.replied
          // We'll catch that in the event hook
          pendingPermissions.get(id)!.body.input._permissionId = permission.id;
          return;
        }
      }
    },
    // Watch for permission replies to resolve pending requests
    event: async ({ event }) => {
      if (event.type === "permission.replied") {
        const props = (event as any).properties;
        const permId = props?.permissionID;
        const response = props?.response; // "once" | "always" | "reject"

        // Find matching pending request
        for (const [id, entry] of pendingPermissions) {
          if ((entry.body.input._permissionId as string) === permId) {
            const decision = response === "reject" ? "deny" : "allow";
            trace("permission.replied", { reqId: id, permId, response, decision });
            pendingPermissions.delete(id);
            entry.resolve(decision);
            return;
          }
        }
      }
    },
  };
};

// Provider loader looks for exports starting with "create".
// This is NOT a Plugin function — the plugin loader will call it
// but it returns a provider factory (not hooks), which is safely ignored.
export { createClwnd };
