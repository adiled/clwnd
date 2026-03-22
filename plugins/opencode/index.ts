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
  // Find PermissionNext and GlobalBus from OC's loaded modules.
  // We're inside OC's Bun process — all modules are in memory.
  let PermissionNext: any = null;
  let GlobalBus: any = null;

  // Scan require.cache for OC's internal modules
  try {
    const cache = require.cache;
    const cacheKeys = cache ? Object.keys(cache) : [];
    trace("cache.scan", { count: cacheKeys.length });
    // Log a sample of keys to understand the module system
    const interesting = cacheKeys.filter(k => k.includes("bus") || k.includes("permission") || k.includes("event") || k.includes("opencode"));
    trace("cache.interesting", { keys: interesting.slice(0, 10).join("|") || "none" });

    if (cache) {
      for (const [key, mod] of Object.entries(cache as Record<string, any>)) {
        const exports = mod?.exports ?? mod;
        if (!exports || typeof exports !== "object") continue;
        if (!PermissionNext && exports.PermissionNext?.ask) {
          PermissionNext = exports.PermissionNext;
          trace("permission.found.cache", { key });
        }
        if (!GlobalBus && exports.GlobalBus?.emit) {
          GlobalBus = exports.GlobalBus;
          trace("globalbus.found.cache", { key });
        }
        // Also check default export
        if (!PermissionNext && exports.default?.PermissionNext?.ask) {
          PermissionNext = exports.default.PermissionNext;
          trace("permission.found.cache.default", { key });
        }
        if (!GlobalBus && exports.default?.GlobalBus?.emit) {
          GlobalBus = exports.default.GlobalBus;
          trace("globalbus.found.cache.default", { key });
        }
        if (PermissionNext && GlobalBus) break;
      }
    }
  } catch (e) {
    trace("cache.scan.error", { err: String(e) });
  }

  // Fallback: try Bun's internal module resolution
  if (!PermissionNext || !GlobalBus) {
    const paths = [
      "src/permission/next",
      "@/permission/next",
      "src/bus/global",
      "@/bus/global",
    ];
    for (const p of paths) {
      try {
        const mod = require(p);
        if (!PermissionNext && mod.PermissionNext?.ask) {
          PermissionNext = mod.PermissionNext;
          trace("permission.found.require", { path: p });
        }
        if (!GlobalBus && mod.GlobalBus?.emit) {
          GlobalBus = mod.GlobalBus;
          trace("globalbus.found.require", { path: p });
        }
      } catch {}
    }
  }

  // Path C: Try dynamic import() — Bun may resolve embedded modules differently
  if (!PermissionNext) {
    const dynamicPaths = [
      // Bun single-file executable paths
      "$bunfs/root/src/permission/next",
      "$bunfs/root/src/permission/next.ts",
      // Process main module relative
      "../../src/permission/next",
    ];
    for (const p of dynamicPaths) {
      try {
        const mod = require(p);
        if (mod?.PermissionNext?.ask) {
          PermissionNext = mod.PermissionNext;
          trace("permission.found.dynamic", { path: p });
          break;
        }
      } catch {}
    }
  }

  if (!GlobalBus) {
    const busPaths = [
      "$bunfs/root/src/bus/global",
      "$bunfs/root/src/bus/global.ts",
      "../../src/bus/global",
    ];
    for (const p of busPaths) {
      try {
        const mod = require(p);
        if (mod?.GlobalBus?.emit) {
          GlobalBus = mod.GlobalBus;
          trace("globalbus.found.dynamic", { path: p });
          break;
        }
      } catch {}
    }
  }

  if (!PermissionNext) trace("permission.not-found");
  if (!GlobalBus) trace("globalbus.not-found");

  onDaemonMessage("permission-ask", async (payload: {
    id: string;
    sessionId: string;
    tool: string;
    path?: string;
    input: Record<string, unknown>;
  }) => {
    trace("permission.ask", { id: payload.id, tool: payload.tool, path: payload.path });

    if (!PermissionNext && !GlobalBus) {
      trace("permission.ask.no-module");
      return { decision: "deny" };
    }

    // Path A: PermissionNext.ask() — creates pending, emits event, awaits user response
    if (PermissionNext) {
      try {
        await PermissionNext.ask({
          sessionID: payload.sessionId,
          permission: payload.tool,
          patterns: [payload.path ?? "*"],
          metadata: payload.input,
          always: [payload.path ?? "*"],
          ruleset: [], // empty — daemon already evaluated
        });
        trace("permission.ask.approved", { id: payload.id });
        return { decision: "allow" };
      } catch (e: any) {
        trace("permission.ask.denied", { id: payload.id, err: e?.message });
        return { decision: "deny" };
      }
    }

    // Path B: GlobalBus.emit — emit the event directly, poll for reply
    // This creates no pending state in PermissionNext, so we must handle
    // the reply ourselves via SSE subscription
    trace("permission.ask.globalbus-fallback", { id: payload.id });
    return { decision: "deny" }; // TODO: implement GlobalBus fallback
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
