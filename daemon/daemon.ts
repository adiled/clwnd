import { spawn, type Subprocess } from "bun";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { trace, info } from "../log.ts";

// ─── Shapes ─────────────────────────────────────────────────────────────────

interface BloomListener {
  sessionId: string;
  onRoost(claudeId: string, model: string, tools: string[]): void;
  onPetal(type: string, payload: Record<string, unknown>): void;
  onWilt(harvest: { finishReason: string; usage: Record<string, number> | undefined; providerMetadata: Record<string, unknown> }): void;
  onThorn(wound: string): void;
}

// ─── Protocol ────────────────────────────────────────────────────────────────

function encodePrompt(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

function encodeToolResult(toolUseId: string, result: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content: result }] },
  });
}

function parseLine(line: string): unknown {
  try { return JSON.parse(line); } catch { return null; }
}

// ─── ClaudeNest ──────────────────────────────────────────────────────────

interface Roost {
  proc: Subprocess;
  listeners: Map<string, BloomListener>;
  activeSid: string | null;
}

class ClaudeNest {
  private roosts = new Map<string, Roost>();

  constructor(private cliPath = "claude") {}

  awaken(poolKey: string, modelId: string, listener: BloomListener, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): void {
    let roost = this.roosts.get(poolKey);
    if (!roost) {
      roost = this.spawnProc(poolKey, modelId, claudeSessionId, permissions, systemPrompt, allowedTools, sessionCwd);
    } else {
      mcpSetPerms((permissions ?? []) as any);
      mcpSetAllowed(allowedTools);
    }
    listener.onPetal("stream_start", {});
    roost.listeners.set(listener.sessionId, listener);
  }

  murmur(sessionId: string, poolKey: string, text: string): void {
    const roost = this.roosts.get(poolKey);
    if (!roost?.proc.stdin) return;
    roost.activeSid = sessionId;
    trace("nest.murmured", { sid: sessionId, poolKey, len: text.length });
    roost.proc.stdin.write(encodePrompt(text) + "\n");
  }

  reply(sessionId: string, poolKey: string, toolUseId: string, result: string): void {
    const roost = this.roosts.get(poolKey);
    if (!roost?.proc.stdin) return;
    roost.activeSid = sessionId;
    trace("nest.replied", { sid: sessionId, toolUseId, len: result.length });
    roost.proc.stdin.write(encodeToolResult(toolUseId, result) + "\n");
  }

  hush(sessionId: string, poolKey: string): void {
    const roost = this.roosts.get(poolKey);
    if (roost) {
      roost.listeners.delete(sessionId);
      if (roost.activeSid === sessionId) roost.activeSid = null;
      trace("nest.hushed", { sid: sessionId, poolKey });
    }
  }

  fell(sessionId: string, poolKey: string): void {
    const roost = this.roosts.get(poolKey);
    if (roost) {
      roost.listeners.delete(sessionId);
      if (roost.activeSid === sessionId) roost.activeSid = null;
      if (roost.listeners.size === 0) {
        trace("nest.felled", { poolKey, pid: roost.proc.pid });
        try { roost.proc.kill(); } catch {}
        this.roosts.delete(poolKey);
      }
    }
  }

  roost(poolKey: string): Roost | undefined {
    return this.roosts.get(poolKey);
  }

  survey(): Array<{ model: string; pid?: number; sessions: string[] }> {
    const out: Array<{ model: string; pid?: number; sessions: string[] }> = [];
    for (const [id, roost] of this.roosts) {
      out.push({ model: id, pid: roost.proc.pid, sessions: Array.from(roost.listeners.keys()) });
    }
    return out;
  }

  silence(): void {
    for (const [, roost] of this.roosts) { try { roost.proc.kill(); } catch {} }
    this.roosts.clear();
  }

  private spawnProc(poolKey: string, modelId: string, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): Roost {
    // Update MCP server state for this request
    mcpSetPerms((permissions ?? []) as any);
    mcpSetAllowed(allowedTools);
    if (sessionCwd) mcpSetCwd(sessionCwd);

    // MCP config — point Claude CLI to our persistent HTTP MCP server
    const mcpConfig = JSON.stringify({
      mcpServers: {
        clwnd: { type: "http", url: MCP_URL },
      },
    });

    const cmd = [
      this.cliPath, "-p",
      "--verbose",
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--model", modelId,
      "--include-partial-messages",
      // Default permission mode — Claude CLI calls our permission_prompt MCP
      // tool for every permission decision instead of auto-approving
      "--permission-mode", "default",
      "--permission-prompt-tool", "mcp__clwnd__permission_prompt",
      // Disable built-in tools — our MCP server replaces file/bash tools,
      // and interactive tools would hang in -p mode
      "--disallowedTools", "Read,Edit,Write,Bash,Glob,Grep,ToolSearch,Agent,NotebookEdit,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree,AskUserQuestion",
      // Register our MCP server
      "--mcp-config", mcpConfig,
    ];
    // System prompt set once at spawn — persistent process keeps it
    if (systemPrompt) {
      cmd.push("--system-prompt", systemPrompt);
    }
    const spawnCwd = sessionCwd ?? process.env.CLWND_CWD ?? process.env.HOME ?? "/";
    const proc = spawn({
      cmd,
      cwd: spawnCwd,
      env: { ...process.env, TERM: "xterm-256color" },
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
    });

    const roost: Roost = { proc, listeners: new Map(), activeSid: null };
    this.roosts.set(poolKey, roost);
    info("nest.awakened", { poolKey, model: modelId, pid: proc.pid, resume: claudeSessionId ?? "none" });

    this.readStderr(proc, poolKey);

    proc.exited.then(exit => {
      trace("nest.exited", { poolKey, code: exit.exitCode });
      for (const listener of roost.listeners.values()) {
        try { listener.onThorn(`subprocess exited: code=${exit.exitCode}`); } catch {}
      }
      roost.listeners.clear();
      roost.activeSid = null;
      this.roosts.delete(poolKey);
    });

    this.readLoop(proc, poolKey, roost);
    return roost;
  }

  private readStderr(proc: Subprocess, modelId: string): void {
    if (!proc.stderr) return;
    const reader = proc.stderr.getReader();
    const dec = new TextDecoder();
    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const text = dec.decode(value!, { stream: true });
          if (text.trim()) trace("nest.stderr", { poolKey: modelId, text: text.trim() });
        }
      } catch {}
    })();
  }

  private readLoop(proc: Subprocess, poolKey: string, roost: Roost): void {
    const reader = proc.stdout!.getReader();
    const dec = new TextDecoder();
    let nectar = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          nectar += dec.decode(value!, { stream: true });
          const lines = nectar.split("\n");
          nectar = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) this.dispatchLine(poolKey, roost, parseLine(line));
          }
        }
      } catch (err) {
        trace("nest.readloop.failed", { err: String(err) });
        for (const listener of roost.listeners.values()) {
          try { listener.onThorn(`readLoop error: ${err}`); } catch {}
        }
        roost.listeners.clear();
      }
    })();
  }

  // Track whether we've seen streaming content blocks for this turn
  // to avoid duplicating text from the final assistant message
  private streamedTurn = false;

  private dispatchLine(poolKey: string, roost: Roost, raw: unknown): void {
    if (!raw || typeof raw !== "object") return;
    let msg = raw as Record<string, unknown>;

    // Unwrap stream_event wrapper from --include-partial-messages
    if (msg.type === "stream_event" && msg.event && typeof msg.event === "object") {
      msg = msg.event as Record<string, unknown>;
    }

    if (msg.type === "system" && msg.subtype === "init") {
      const sid = (msg.session_id as string) ?? "";
      const model = (msg.model as string) ?? poolKey;
      const tools = ((msg.tools as unknown[]) ?? []).map(String);
      for (const listener of roost.listeners.values()) listener.onRoost(sid, model, tools);
      return;
    }

    let listener: BloomListener | undefined;
    if (roost.activeSid) {
      listener = roost.listeners.get(roost.activeSid);
    }
    if (!listener) {
      listener = roost.listeners.values().next().value;
    }
    if (!listener) return;

    const petal = (type: string, payload: Record<string, unknown>) => listener!.onPetal(type, payload);

    trace("stream.msg.received", { type: msg.type as string, subtype: (msg.subtype as string) ?? "" });

    // Permission requests from Claude CLI's native protocol
    if (msg.type === "permission_request") {
      const requestId = msg.request_id as string;
      const toolName = ((msg.tool_name ?? "") as string).replace("mcp__clwnd__", "");
      const path = ((msg.input as Record<string, unknown>)?.file_path ?? (msg.input as Record<string, unknown>)?.path) as string | undefined;
      const action = getPermissionAction(toolName, path);
      trace("permission.request.received", { requestId, tool: toolName, path, action });

      if (action === "deny") {
        trace("permission.denied", { requestId, tool: toolName, path });
        roost.proc.stdin?.write(JSON.stringify({
          type: "permission_response",
          request_id: requestId,
          subtype: "error",
          error: "Denied by session permission rules",
        }) + "\n");
      } else if (action === "ask") {
        const askId = requestId;
        trace("permission.hold.created", { id: askId, tool: toolName, path });

        hum(roost.activeSid ?? "", { chi: "permission-ask", askId, tool: toolName, path, input: msg.input ?? {} });

        CLWND_PERMIT_HOLD.set(askId, {
          resolve: (decision) => {
            if (decision === "allow") {
              roost.proc.stdin?.write(JSON.stringify({
                type: "permission_response",
                request_id: requestId,
                subtype: "success",
                response: { updated_input: {}, permission_updates: [] },
              }) + "\n");
            } else {
              roost.proc.stdin?.write(JSON.stringify({
                type: "permission_response",
                request_id: requestId,
                subtype: "error",
                error: "Denied by user",
              }) + "\n");
            }
          },
          tool: toolName,
          path,
          sessionId: roost.activeSid ?? "",
        });

        setTimeout(() => {
          if (CLWND_PERMIT_HOLD.has(askId)) {
            const hold = CLWND_PERMIT_HOLD.get(askId)!;
            CLWND_PERMIT_HOLD.delete(askId);
            hold.resolve("deny");
            trace("permission.hold.timeout", { id: askId });
          }
        }, 300_000);
      } else {
        trace("permission.allowed", { requestId, tool: toolName, path });
        roost.proc.stdin?.write(JSON.stringify({
          type: "permission_response",
          request_id: requestId,
          subtype: "success",
          response: { updated_input: {}, permission_updates: [] },
        }) + "\n");
      }
      return;
    }

    if (msg.type === "content_block_start") {
      const block = (msg.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "thinking") petal("reasoning_start", { id: msg.index });
      if (block.type === "text") petal("text_start", { id: msg.index });
      if (block.type === "tool_use") petal("tool_input_start", { toolCallId: block.id as string, toolName: block.name as string });
      return;
    }

    if (msg.type === "content_block_delta") {
      this.streamedTurn = true;
      const delta = (msg.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "thinking_delta") petal("reasoning_delta", { delta: delta.thinking as string });
      if (delta.type === "text_delta") petal("text_delta", { delta: delta.text as string });
      if (delta.type === "input_json_delta") petal("tool_input_delta", { partialJson: delta.partial_json as string });
      return;
    }

    if (msg.type === "content_block_stop") {
      petal("content_block_stop", { blockIdx: msg.index });
      return;
    }

    if (msg.type === "assistant" && msg.message) {
      const content = ((msg.message as Record<string, unknown>).content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string" && !this.streamedTurn) petal("text_delta", { delta: block.text });
        if (block.type === "tool_use") petal("tool_call", { toolCallId: block.id as string, toolName: block.name as string, input: block.input });
      }
      return;
    }

    if (msg.type === "user" && msg.message) {
      const content = ((msg.message as Record<string, unknown>).content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === "tool_result") {
          const toolUseId = (block.tool_use_id as string) ?? "";
          let resultText = "";
          const body = block.content;
          if (typeof body === "string") resultText = body;
          else if (Array.isArray(body)) resultText = (body as Array<Record<string, unknown>>).filter(c => typeof c.text === "string").map(c => c.text as string).join("\n");
          petal("tool_result", { toolUseId, result: resultText });
        }
      }
      return;
    }

    if (msg.type === "result") {
      this.streamedTurn = false;
      listener.onWilt({
        finishReason: (msg.stop_reason as string) ?? "stop",
        usage: msg.usage as Record<string, number> | undefined,
        providerMetadata: { sessionId: msg.session_id, cost: msg.total_cost_usd },
      });
      if (roost.activeSid) {
        roost.listeners.delete(roost.activeSid);
        roost.activeSid = null;
      }
    }
  }
}

// ─── Permission State ───────────────────────────────────────────────────────

// Pending permission asks — held PreToolUse hook responses waiting for user decision
const CLWND_PERMIT_HOLD = new Map<string, {
  resolve: (decision: "allow" | "deny") => void;
  tool: string;
  path?: string;
  sessionId: string;
}>();

// Permission rules stored per-session, forwarded from OC via the provider
const sessionPermissions = new Map<string, Array<{ permission: string; pattern: string; action: string }>>();

export function setSessionPermissions(sessionId: string, rules: Array<{ permission: string; pattern: string; action: string }>): void {
  sessionPermissions.set(sessionId, rules);
}

function getPermissionAction(tool: string, path?: string): "allow" | "deny" | "ask" {
  // OC rules are ordered general → specific. Last matching rule wins.
  let result: "allow" | "deny" | "ask" = "allow";
  for (const [, rules] of sessionPermissions) {
    for (const rule of rules) {
      if (rule.permission !== tool && rule.permission !== "*") continue;
      if (path) {
        const pat = rule.pattern;
        if (pat === "*" || path.startsWith(pat.replace("/*", "/")) || path === pat) {
          result = rule.action as "allow" | "deny" | "ask";
        }
      } else if (rule.pattern === "*") {
        result = rule.action as "allow" | "deny" | "ask";
      }
    }
  }
  return result;
}

// ─── Session State (persisted) ───────────────────────────────────────────────

interface Session {
  opencodeSessionId: string;
  claudeSessionId: string | null;
  claudeSessionPath: string | null;
  cwd: string;
  modelId: string;
}

const STATE_DIR = process.env.XDG_STATE_HOME
  ? `${process.env.XDG_STATE_HOME}/clwnd`
  : `${process.env.HOME}/.local/state/clwnd`;
const SESSIONS_FILE = `${STATE_DIR}/sessions.json`;

function loadSessions(): Map<string, Session> {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSessions(): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const obj: Record<string, Session> = {};
    for (const [k, v] of sessions) obj[k] = v;
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch {}
}

const sessions = loadSessions();

// ─── JSONL (Claude CLI history) ──────────────────────────────────────────────

const CLAUDE_BASE = `${process.env.HOME}/.claude`;

function cwdHash(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/^-+|-+$/g, "");
}

function getSessionDir(cwd: string): string {
  return `${CLAUDE_BASE}/projects/${cwdHash(cwd)}`;
}

function getSessionPath(cwd: string, id: string): string {
  return `${getSessionDir(cwd)}/${id}.jsonl`;
}

function appendToJsonl(path: string, record: Record<string, unknown>): string {
  const uuid = randomUUID();
  const entry = { ...record, uuid, timestamp: new Date().toISOString() };
  appendFileSync(path, JSON.stringify(entry) + "\n");
  return uuid;
}

function getLastEntryUuid(path: string): string | null {
  try {
    const content = readFileSync(path, "utf-8");
    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.uuid) return e.uuid as string;
      } catch {}
    }
  } catch {}
  return null;
}

function createClaudeSession(cwd: string, id: string): string {
  const dir = getSessionDir(cwd);
  const path = getSessionPath(cwd, id);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  writeFileSync(path, JSON.stringify({
    type: "summary",
    summary: "clwnd session",
    leafUuid: null,
    sessionId: id,
    timestamp: new Date().toISOString(),
  }) + "\n");
  return path;
}

function injectUserMessage(sessionPath: string, content: string | Record<string, unknown>[], parentUuid: string | null, sessionId: string): string {
  return appendToJsonl(sessionPath, {
    type: "user",
    parentUuid,
    sessionId,
    message: { role: "user", content },
    entrypoint: "sdk-cli",
  });
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) {
    const dir = `${runtime}/clwnd`;
    mkdirSync(dir, { recursive: true });
    return `${dir}/clwnd.sock`;
  }
  return "/tmp/clwnd.sock";
}

const SOCK = process.env.CLWND_SOCKET ?? defaultSocketPath();
const HTTP = SOCK + ".http";


const nest = new ClaudeNest(process.env.CLAUDE_CLI_PATH ?? "claude");

const HUM = SOCK + ".hum";

for (const p of [SOCK, HTTP, HUM]) {
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) { try { unlinkSync(p); } catch {} }
}

// ─── clwndHum: Bidirectional NDJSON socket ─────────────────────────────────
// One persistent connection per provider instance. Both sides push typed
// JSON messages (chi = message type). Replaces HTTP request/response dance.

type HumSocket = ReturnType<typeof Bun.connect> extends Promise<infer T> ? T : never;
const humRoots = new Map<string, { socket: any; sessionId: string | null }>();

function humChorus(msg: Record<string, unknown>): void {
  trace("hum.chorus.sent", { chi: msg.chi as string, clients: humRoots.size });
  const line = JSON.stringify(msg) + "\n";
  for (const [, client] of humRoots) {
    try { client.socket.write(line); } catch {}
  }
}

function hum(sessionId: string, msg: Record<string, unknown>): void {
  trace("hum.whisper.sent", { chi: msg.chi as string, sid: sessionId });
  const line = JSON.stringify(msg) + "\n";
  for (const [, client] of humRoots) {
    if (client.sessionId === sessionId || client.sessionId === null) {
      try { client.socket.write(line); } catch {}
    }
  }
}

function humReceive(clientId: string, msg: Record<string, unknown>): void {
  const chi = msg.chi as string;
  trace("hum.msg.received", { chi, clientId: clientId.slice(0, 8) });

  switch (chi) {
    case "prompt": {
      const sid = msg.sid as string;
      const client = humRoots.get(clientId);
      if (client) client.sessionId = sid;

      // Get or create session
      let session = sessions.get(sid);
      if (!session) {
        session = {
          opencodeSessionId: sid,
          claudeSessionId: null,
          claudeSessionPath: null,
          cwd: (msg.cwd as string) ?? "/root",
          modelId: (msg.modelId as string) ?? "sonnet",
        };
        sessions.set(sid, session);
        saveSessions();
        trace("session.created", { sid, model: session.modelId });
      }

      const permissions = (msg.permissions ?? []) as unknown[];
      const systemPrompt = (msg.systemPrompt as string) || undefined;
      const allowedTools = (msg.allowedTools as string[]) || undefined;
      const cwd = msg.cwd as string | undefined;

      if (cwd) mcpSetCwd(cwd);
      if (permissions.length > 0) {
        setSessionPermissions(sid, permissions as any);
      }

      const poolKey = sid;

      const listener: BloomListener = {
        sessionId: sid,
        onRoost(claudeSessionId, model, tools) {
          session.claudeSessionId = claudeSessionId;
          if (!session.claudeSessionPath) {
            const dir = getSessionDir(session.cwd);
            try { mkdirSync(dir, { recursive: true }); } catch {}
            session.claudeSessionPath = getSessionPath(session.cwd, claudeSessionId);
          }
          saveSessions();
          hum(sid, { chi: "session-ready", sid, claudeSessionId, model, tools });
        },
        onPetal: (() => {
          let batch: string[] = [];
          let pending = false;
          return (type: string, payload: Record<string, unknown>) => {
            batch.push(JSON.stringify({ chi: "chunk", sid, chunkType: type, ...payload }));
            if (!pending) {
              pending = true;
              queueMicrotask(() => {
                // Single socket write for all buffered chunks
                const line = batch.join("\n") + "\n";
                batch = [];
                pending = false;
                for (const [, client] of humRoots) {
                  if (client.sessionId === sid || client.sessionId === null) {
                    try { client.socket.write(line); } catch {}
                  }
                }
              });
            }
          };
        })(),
        onWilt(harvest) {
          hum(sid, {
            chi: "finish", sid,
            finishReason: harvest.finishReason,
            usage: harvest.usage,
            providerMetadata: harvest.providerMetadata,
          });
          nest.hush(sid, poolKey);
        },
        onThorn(wound) {
          hum(sid, { chi: "error", sid, message: wound });
          nest.fell(sid, poolKey);
        },
      };

      nest.awaken(poolKey, session.modelId, listener, undefined, permissions, systemPrompt, allowedTools, cwd);

      if (!msg.listenOnly) {
        nest.murmur(sid, poolKey, msg.text as string ?? "");
      }

      // Inject user message into JSONL
      if (session.claudeSessionId && session.claudeSessionPath && !msg.listenOnly) {
        const parentUuid = getLastEntryUuid(session.claudeSessionPath);
        injectUserMessage(session.claudeSessionPath, msg.text as string ?? "", parentUuid, session.claudeSessionId);
      }
      break;
    }

    case "release-permit": {
      const askId = msg.askId as string;
      const decision = msg.decision as "allow" | "deny";
      const hold = CLWND_PERMIT_HOLD.get(askId);
      if (hold) {
        CLWND_PERMIT_HOLD.delete(askId);
        hold.resolve(decision);
        trace("hum.permit.released", { askId, decision });
      }
      break;
    }

    case "cleanup": {
      const sid = msg.sid as string;
      const session = sessions.get(sid);
      if (session) {
        nest.fell(sid, session.modelId);
        sessions.delete(sid);
        saveSessions();
        trace("hum.session.cleaned", { sid });
      }
      break;
    }

    default:
      trace("hum.msg.unknown", { chi });
  }
}

const humServer = Bun.listen({
  unix: HUM,
  socket: {
    open(socket) {
      const clientId = randomUUID();
      humRoots.set(clientId, { socket, sessionId: null });
      info("hum.connected", { clientId: clientId.slice(0, 8), total: humRoots.size });
      // Attach clientId to socket for lookup in other handlers
      (socket as any).__clientId = clientId;
    },
    data(socket, data) {
      const clientId = (socket as any).__clientId as string;
      const text = Buffer.from(data).toString();
      const lines = text.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          humReceive(clientId, msg);
        } catch (e) {
          trace("hum.parse.failed", { err: String(e) });
        }
      }
    },
    close(socket) {
      const clientId = (socket as any).__clientId as string;
      humRoots.delete(clientId);
      info("hum.disconnected", { clientId: clientId.slice(0, 8), total: humRoots.size });
    },
    error(socket, err) {
      trace("hum.socket.failed", { err: String(err) });
    },
  },
});

info("hum.listening", { path: HUM });

Bun.serve({
  unix: HTTP,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify({ pid: process.pid, procs: nest.survey(), sessions: sessions.size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Cleanup — tests use this to tear down sessions
    if (req.method === "POST" && url.pathname === "/") {
      return req.json().then((body: { action: string; opencodeSessionId: string }) => {
        if (body.action === "cleanup") {
          const session = sessions.get(body.opencodeSessionId);
          if (session) {
            nest.fell(body.opencodeSessionId, session.modelId);
            sessions.delete(body.opencodeSessionId);
            saveSessions();
            trace("session.cleaned", { sid: body.opencodeSessionId });
          }
        }
        return new Response("ok");
      }).catch(() => new Response("error", { status: 400 }));
    }

    return new Response("clwnd", { status: 200 });
  },
});

// ─── MCP HTTP Server (persistent, no cold start) ────────────────────────────

import { handleMcpRequest, setCwd as mcpSetCwd, setPermissions as mcpSetPerms, setAllowedTools as mcpSetAllowed, setPermissionCallback, setMetaCallback } from "../mcp/tools.ts";

const MCP_PORT = parseInt(process.env.CLWND_MCP_PORT ?? "0") || 0;

const MCP_HOST = process.env.CLWND_HOST ?? "127.0.0.1";

const mcpServer = Bun.serve({
  port: MCP_PORT,
  hostname: MCP_HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // PreToolUse hook calls this to check permissions
    if (req.method === "POST" && url.pathname === "/permission-check") {
      try {
        const body = await req.json();
        const toolName = ((body.tool_name ?? "") as string).replace("mcp__clwnd__", "");
        const path = (body.tool_input?.file_path ?? body.tool_input?.path) as string | undefined;
        const sessionId = body.session_id as string;

        // Find OC session for this Claude session
        let ocSessionId: string | undefined;
        for (const [id, s] of sessions) {
          if (s.claudeSessionId === sessionId || id === sessionId) {
            ocSessionId = id;
            break;
          }
        }

        const action = getPermissionAction(toolName, path);
        trace("permission.hook.checked", { tool: toolName, path, action, ocSid: ocSessionId });

        // Claude CLI hook response format
        const hookAllow = () => Response.json({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        });
        const hookDeny = (reason: string) => Response.json({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason },
        });

        if (action === "allow") return hookAllow();
        if (action === "deny") return hookDeny("Denied by session permission rules");

        // "ask" — treated as allow until a viable UX solution is found.
        // Infrastructure exists (CLWND_PERMIT_HOLD, /release-permit-hold)
        // but OC's session lock prevents in-band user interaction during a turn.
        // See PERMISSION_ASK_PROPOSAL.md for investigation history.
        if (action === "ask") return hookAllow();

        // TODO: hold this response, expose via /permission-pending,
        // wait for /permission-respond to resolve it
        const askId = randomUUID();
        trace("permission.hold.created", { id: askId, tool: toolName, path });

        hum(ocSessionId ?? sessionId, { chi: "permission-ask", askId, tool: toolName, path, input: body.tool_input ?? {} });

        // Hold until /permission-respond resolves this, or timeout
        const decision = await new Promise<"allow" | "deny">((resolve) => {
          CLWND_PERMIT_HOLD.set(askId, { resolve, tool: toolName, path, sessionId: ocSessionId ?? sessionId });
          setTimeout(() => {
            if (CLWND_PERMIT_HOLD.has(askId)) {
              CLWND_PERMIT_HOLD.delete(askId);
              trace("permission.hold.timeout", { id: askId });
              resolve("deny");
            }
          }, 300_000); // 5 min — PreToolUse hook timeout is 600s
        });

        trace("permission.hold.resolved", { id: askId, decision });
        return decision === "allow" ? hookAllow() : hookDeny("Denied by user");
      } catch (e) {
        trace("permission.hook.failed", { err: String(e) });
        return Response.json({
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Permission check failed" },
        });
      }
    }

    // GET /permission-pending — list active permit holds
    if (req.method === "GET" && url.pathname === "/permission-pending") {
      const pending = Array.from(CLWND_PERMIT_HOLD.entries()).map(([id, p]) => ({
        id, tool: p.tool, path: p.path, sessionId: p.sessionId,
      }));
      return Response.json(pending);
    }

    // POST /permission-respond — release a permit hold
    if (req.method === "POST" && url.pathname === "/permission-respond") {
      try {
        const body = await req.json() as { id?: string; decision: "allow" | "deny" };
        // If no id, resolve the first pending
        const id = body.id ?? CLWND_PERMIT_HOLD.keys().next().value;
        if (!id || !CLWND_PERMIT_HOLD.has(id as string)) {
          return Response.json({ error: "no active permit hold" }, { status: 404 });
        }
        const hold = CLWND_PERMIT_HOLD.get(id as string)!;
        CLWND_PERMIT_HOLD.delete(id as string);
        hold.resolve(body.decision);
        trace("permission.responded", { id, decision: body.decision });
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "bad request" }, { status: 400 });
      }
    }

    // MCP JSON-RPC
    if (req.method !== "POST") return new Response("clwnd-mcp", { status: 200 });
    try {
      const body = await req.json();
      trace("mcp.request.received", { method: body?.method });
      const result = await handleMcpRequest(body);
      if (!result) return new Response("", { status: 204 });
      return Response.json(result);
    } catch (e: any) {
      trace("mcp.request.failed", { err: e.message });
      return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: e.message } });
    }
  },
});

const MCP_URL = `http://${MCP_HOST}:${mcpServer.port}`;
mcpSetCwd(process.env.CLWND_CWD ?? process.env.HOME ?? "/");

// Wire permission prompt MCP tool to daemon's permission logic
setPermissionCallback(async (toolName: string, input: Record<string, unknown>) => {
  const tool = toolName.replace("mcp__clwnd__", "");
  const path = (input?.file_path ?? input?.path ?? input?.pattern) as string | undefined;
  const action = getPermissionAction(tool, path);
  trace("permission.mcp.checked", { tool, path, action });

  if (action === "allow") return { decision: "allow" as const };
  if (action === "deny") return { decision: "deny" as const };

  // "ask" — hold MCP response, send permission_ask via the hum
  // so the provider can emit a clwnd_permission tool call to trigger OC's ctx.ask() dialog
  const askId = randomUUID();
  trace("permission.ask.hold", { id: askId, tool, path });

  // Send via hum — if no hum clients, permit hold times out and defaults to allow
  hum("", { chi: "permission-ask", askId, tool, path, input });

  return new Promise<{ decision: "allow" | "deny" }>((resolve) => {
    CLWND_PERMIT_HOLD.set(askId, {
      resolve: (decision) => resolve({ decision }),
      tool, path, sessionId: "",
    });

    // If nobody handles the ask within 10s (no hum client with
    // clwnd_permission tool), default to allow. The user-facing dialog
    // flow resolves much faster (~1-3s) when active.
    setTimeout(() => {
      if (CLWND_PERMIT_HOLD.has(askId)) {
        CLWND_PERMIT_HOLD.delete(askId);
        trace("permission.hold.timeout.ok", { id: askId });
        resolve({ decision: "allow" });
      }
    }, 10_000);
  });
});

// Wire tool metadata to hum — OC gets it out-of-band, Claude CLI never sees it
setMetaCallback((toolName, callId, title, metadata) => {
  // Find the active session to hum to
  for (const [sid, session] of sessions) {
    const roost = nest.roost(sid);
    if (roost && roost.activeSid === sid) {
      hum(sid, { chi: "tool-meta", tool: toolName, callId, title, metadata });
      trace("meta.hummed", { tool: toolName, sid });
      return;
    }
  }
  // No active session — broadcast to all hum clients
  humChorus({ chi: "tool-meta", tool: toolName, callId, title, metadata });
  trace("meta.hummed.broadcast", { tool: toolName });
});

// ─── Auto-update ─────────────────────────────────────────────────────────────

const CURRENT_VERSION = (() => {
  try {
    const pkg = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf-8");
    return JSON.parse(pkg).version as string;
  } catch { return "0.0.0"; }
})();

async function checkForUpdate(): Promise<void> {
  try {
    // Check if gh is available
    const which = Bun.spawnSync({ cmd: ["which", "gh"], stdout: "pipe", stderr: "pipe" });
    if (which.exitCode !== 0) return;

    const result = Bun.spawnSync({
      cmd: ["gh", "release", "view", "--repo", "adiled/clwnd", "--json", "tagName", "-q", ".tagName"],
      stdout: "pipe",
      stderr: "pipe",
    });
    if (result.exitCode !== 0) return;

    const latest = result.stdout.toString().trim().replace(/^v/, "");
    if (!latest || latest === CURRENT_VERSION) return;

    info("update-available", { current: CURRENT_VERSION, latest });

    // Invoke clwnd update
    const clwndBin = join(process.env.HOME ?? "/", ".local", "bin", "clwnd");
    const update = Bun.spawn({
      cmd: [clwndBin, "update"],
      stdout: "inherit",
      stderr: "inherit",
    });
    await update.exited;
  } catch {}
}

// Check every 6 hours
const UPDATE_INTERVAL = 6 * 60 * 60 * 1000;
setTimeout(checkForUpdate, 60_000); // first check 1 min after boot
setInterval(checkForUpdate, UPDATE_INTERVAL);

process.on("SIGINT",  () => { nest.silence(); process.exit(0); });
process.on("SIGTERM", () => { nest.silence(); process.exit(0); });
process.on("uncaughtException",  e => info("process.uncaught", { err: String(e) }));
process.on("unhandledRejection", e => info("process.unhandled", { err: String(e) }));

info("ready", { http: HTTP, mcp: MCP_URL, pid: process.pid, version: CURRENT_VERSION });

