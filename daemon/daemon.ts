import { spawn, type Subprocess } from "bun";
import { EventEmitter } from "events";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

// ─── Logging ────────────────────────────────────────────────────────────────

const LOG_LEVEL = process.env.CLWND_LOG_LEVEL ?? "info";
const TRACE = LOG_LEVEL === "trace" || LOG_LEVEL === "debug";

function trace(event: string, data?: Record<string, unknown>): void {
  if (!TRACE) return;
  const parts = [event];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  console.log(`[trace] ${parts.join(" ")}`);
}

function info(event: string, data?: Record<string, unknown>): void {
  const parts = [event];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  console.log(parts.join(" "));
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface StreamHandler {
  opencodeSessionId: string;
  onSystemInit(sessionId: string, model: string, tools: string[]): void;
  onChunk(type: string, data: Record<string, unknown>): void;
  onFinish(info: { finishReason: string; usage: Record<string, number> | undefined; providerMetadata: Record<string, unknown> }): void;
  onError(msg: string): void;
}

interface IpcToDaemon {
  action: string;
  opencodeSessionId: string;
  cwd?: string;
  modelId?: string;
  text?: string;
  historyContext?: string;
  toolUseId?: string;
  result?: string;
  [key: string]: unknown;
}

interface IpcToPlugin {
  action: string;
  opencodeSessionId?: string;
  chunkType?: string;
  finishReason?: string;
  usage?: Record<string, number>;
  providerMetadata?: Record<string, unknown>;
  message?: string;
  claudeSessionId?: string;
  model?: string;
  tools?: string[];
  [key: string]: unknown;
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

// ─── SubprocessPool ──────────────────────────────────────────────────────────

interface ProcEntry {
  proc: Subprocess;
  handlers: Map<string, StreamHandler>;
  activeSession: string | null;
}

class SubprocessPool {
  private procs = new Map<string, ProcEntry>();

  constructor(private cliPath = "claude") {}

  sendSpawn(poolKey: string, modelId: string, handler: StreamHandler, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): void {
    let entry = this.procs.get(poolKey);
    if (!entry) {
      entry = this.spawnProc(poolKey, modelId, claudeSessionId, permissions, systemPrompt, allowedTools, sessionCwd);
    } else {
      // Persistent process: update per-turn state
      mcpSetPerms((permissions ?? []) as any);
      mcpSetAllowed(allowedTools);
    }
    handler.onChunk("stream_start", {});
    entry.handlers.set(handler.opencodeSessionId, handler);
  }

  sendPrompt(sessionId: string, poolKey: string, text: string): void {
    const entry = this.procs.get(poolKey);
    if (!entry?.proc.stdin) return;
    entry.activeSession = sessionId;
    entry.proc.stdin.write(encodePrompt(text) + "\n");
  }

  sendToolResult(sessionId: string, poolKey: string, toolUseId: string, result: string): void {
    const entry = this.procs.get(poolKey);
    if (!entry?.proc.stdin) return;
    entry.activeSession = sessionId;
    entry.proc.stdin.write(encodeToolResult(toolUseId, result) + "\n");
  }

  abort(sessionId: string, poolKey: string): void {
    const e = this.procs.get(poolKey);
    if (e) {
      e.handlers.delete(sessionId);
      if (e.activeSession === sessionId) e.activeSession = null;
    }
  }

  destroy(sessionId: string, poolKey: string): void {
    const e = this.procs.get(poolKey);
    if (e) {
      e.handlers.delete(sessionId);
      if (e.activeSession === sessionId) e.activeSession = null;
      if (e.handlers.size === 0) {
        try { e.proc.kill(); } catch {}
        this.procs.delete(poolKey);
      }
    }
  }

  status(): Array<{ model: string; pid?: number; sessions: string[] }> {
    const out: Array<{ model: string; pid?: number; sessions: string[] }> = [];
    for (const [id, e] of this.procs) {
      out.push({ model: id, pid: e.proc.pid, sessions: Array.from(e.handlers.keys()) });
    }
    return out;
  }

  killAll(): void {
    for (const [, e] of this.procs) { try { e.proc.kill(); } catch {} }
    this.procs.clear();
  }

  private spawnProc(poolKey: string, modelId: string, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): ProcEntry {
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
      "--permission-mode", process.env.CLWND_PERMISSION_MODE ?? "acceptEdits",
      // Disable built-in tools — our MCP server replaces file/bash tools,
      // and Claude CLI internal tools aren't available in OpenCode
      "--disallowedTools", "Read,Edit,Write,Bash,Glob,Grep,ToolSearch,Agent,NotebookEdit,EnterPlanMode,ExitPlanMode,EnterWorktree,ExitWorktree",
      // Auto-approve our MCP tools
      "--allowedTools", "mcp__clwnd__read,mcp__clwnd__edit,mcp__clwnd__write,mcp__clwnd__bash,mcp__clwnd__glob,mcp__clwnd__grep",
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

    const entry: ProcEntry = { proc, handlers: new Map(), activeSession: null };
    this.procs.set(poolKey, entry);
    info("spawn", { poolKey, model: modelId, pid: proc.pid, resume: claudeSessionId ?? "none" });

    this.readStderr(proc, poolKey);

    proc.exited.then(exit => {
      trace("proc.exited", { poolKey, code: exit.exitCode });
      for (const h of entry.handlers.values()) {
        try { h.onError(`subprocess exited: code=${exit.exitCode}`); } catch {}
      }
      entry.handlers.clear();
      entry.activeSession = null;
      this.procs.delete(poolKey);
    });

    this.readLoop(proc, poolKey, entry);
    return entry;
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
          if (text.trim()) console.error("stderr[" + modelId + "]:", text.trim());
        }
      } catch {}
    })();
  }

  private readLoop(proc: Subprocess, modelId: string, entry: ProcEntry): void {
    const reader = proc.stdout!.getReader();
    const dec = new TextDecoder();
    let buf = "";

    (async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value!, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) this.dispatchLine(modelId, entry, parseLine(line));
          }
        }
      } catch (e) {
        console.error("readLoop:", e);
        for (const h of entry.handlers.values()) {
          try { h.onError(`readLoop error: ${e}`); } catch {}
        }
        entry.handlers.clear();
      }
    })();
  }

  // Track whether we've seen streaming content blocks for this turn
  // to avoid duplicating text from the final assistant message
  private streamedTurn = false;

  private dispatchLine(modelId: string, entry: ProcEntry, msg: unknown): void {
    if (!msg || typeof msg !== "object") return;
    let m = msg as Record<string, unknown>;

    // Unwrap stream_event wrapper from --include-partial-messages
    if (m.type === "stream_event" && m.event && typeof m.event === "object") {
      m = m.event as Record<string, unknown>;
    }

    if (m.type === "system" && m.subtype === "init") {
      const sid = (m.session_id as string) ?? "";
      const model = (m.model as string) ?? modelId;
      const tools = ((m.tools as unknown[]) ?? []).map(String);
      for (const h of entry.handlers.values()) h.onSystemInit(sid, model, tools);
      return;
    }

    let handler: StreamHandler | undefined;
    if (entry.activeSession) {
      handler = entry.handlers.get(entry.activeSession);
    }
    if (!handler) {
      handler = entry.handlers.values().next().value;
    }
    if (!handler) return;

    const emit = (type: string, data: Record<string, unknown>) => handler!.onChunk(type, data);

    if (m.type === "content_block_start") {
      const block = (m.content_block ?? {}) as Record<string, unknown>;
      if (block.type === "thinking") emit("reasoning_start", { id: m.index });
      if (block.type === "text") emit("text_start", { id: m.index });
      if (block.type === "tool_use") emit("tool_input_start", { toolCallId: block.id as string, toolName: block.name as string });
      return;
    }

    if (m.type === "content_block_delta") {
      this.streamedTurn = true;
      const delta = (m.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "thinking_delta") emit("reasoning_delta", { delta: delta.thinking as string });
      if (delta.type === "text_delta") emit("text_delta", { delta: delta.text as string });
      if (delta.type === "input_json_delta") emit("tool_input_delta", { partialJson: delta.partial_json as string });
      return;
    }

    if (m.type === "content_block_stop") {
      emit("content_block_stop", { blockIdx: m.index });
      return;
    }

    if (m.type === "assistant" && m.message) {
      const content = ((m.message as Record<string, unknown>).content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        // Skip text if already streamed via content_block_delta
        if (block.type === "text" && typeof block.text === "string" && !this.streamedTurn) emit("text_delta", { delta: block.text });
        // Always emit tool_use — MCP tool calls only appear in assistant messages
        if (block.type === "tool_use") emit("tool_call", { toolCallId: block.id as string, toolName: block.name as string, input: block.input });
      }
      return;
    }

    if (m.type === "user" && m.message) {
      const content = ((m.message as Record<string, unknown>).content ?? []) as Array<Record<string, unknown>>;
      for (const block of content) {
        if (block.type === "tool_result") {
          const toolUseId = (block.tool_use_id as string) ?? "";
          let resultText = "";
          const raw = block.content;
          if (typeof raw === "string") resultText = raw;
          else if (Array.isArray(raw)) resultText = (raw as Array<Record<string, unknown>>).filter(c => typeof c.text === "string").map(c => c.text as string).join("\n");
          emit("tool_result", { toolUseId, result: resultText });
        }
      }
      return;
    }

    if (m.type === "result") {
      this.streamedTurn = false;
      handler.onFinish({
        finishReason: (m.stop_reason as string) ?? "stop",
        usage: m.usage as Record<string, number> | undefined,
        providerMetadata: { sessionId: m.session_id, cost: m.total_cost_usd },
      });
      if (entry.activeSession) {
        entry.handlers.delete(entry.activeSession);
        entry.activeSession = null;
      }
    }
  }
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

// ─── IPC ─────────────────────────────────────────────────────────────────────

const emitter = new EventEmitter();

function onBroadcast(cb: (msg: IpcToPlugin) => void): void {
  emitter.on("broadcast", cb);
}

function emitBroadcast(msg: IpcToPlugin): void {
  emitter.emit("broadcast", msg);
}

function handleAction(msg: IpcToDaemon, pool: SubprocessPool): void {
  switch (msg.action) {
    case "spawn": {
      const { opencodeSessionId, cwd, modelId } = msg;
      const session: Session = {
        opencodeSessionId,
        claudeSessionId: null,
        claudeSessionPath: null,
        cwd: cwd ?? "/root",
        modelId: modelId ?? "sonnet",
      };
      sessions.set(opencodeSessionId, session);
      saveSessions();

      const h: StreamHandler = {
        opencodeSessionId,
        onSystemInit(claudeSessionId, model, tools) {
          const path = createClaudeSession(session.cwd, claudeSessionId);
          session.claudeSessionId = claudeSessionId;
          session.claudeSessionPath = path;
          saveSessions();
          emitBroadcast({ action: "session_ready", opencodeSessionId, claudeSessionId, model, tools });
        },
        onChunk(type, data) {
          emitBroadcast({ action: "chunk", opencodeSessionId, chunkType: type, ...data } as unknown as IpcToPlugin);
        },
        onFinish(finish) {
          emitBroadcast({
            action: "finish",
            opencodeSessionId,
            finishReason: finish.finishReason,
            usage: finish.usage,
            providerMetadata: finish.providerMetadata,
          });
        },
        onError(err) {
          emitBroadcast({ action: "error", opencodeSessionId, message: err });
        },
      };

      pool.sendSpawn(opencodeSessionId, session.modelId, h);
      break;
    }

    case "prompt": {
      const { opencodeSessionId, text } = msg;
      const session = sessions.get(opencodeSessionId);
      if (!session) {
        emitBroadcast({ action: "error", opencodeSessionId, message: "session not found" });
        return;
      }

      if (session.claudeSessionId && session.claudeSessionPath) {
        const parentUuid = getLastEntryUuid(session.claudeSessionPath);
        injectUserMessage(session.claudeSessionPath, text ?? "", parentUuid, session.claudeSessionId);
      }

      const fullText = (msg.historyContext as string)
        ? `Previous context:\n${msg.historyContext}\n\nNew message:\n${text}`
        : (text ?? "");
      pool.sendPrompt(opencodeSessionId, session.modelId, fullText);
      break;
    }

    case "tool_result": {
      const { opencodeSessionId, toolUseId, result } = msg;
      const session = sessions.get(opencodeSessionId);
      if (!session) return;

      if (session.claudeSessionPath && session.claudeSessionId) {
        const parentUuid = getLastEntryUuid(session.claudeSessionPath);
        injectUserMessage(session.claudeSessionPath, [
          { type: "tool_result", tool_use_id: toolUseId, content: result, is_error: false }
        ], parentUuid, session.claudeSessionId);
      }

      pool.sendToolResult(opencodeSessionId, session.modelId, toolUseId ?? "", result ?? "");
      break;
    }

    case "abort": {
      const session = sessions.get(msg.opencodeSessionId);
      if (session) pool.abort(msg.opencodeSessionId, session.modelId);
      break;
    }

    case "destroy": {
      // Only destroy the subprocess, NOT the session state.
      // The plugin sends destroy on abort/cancel, but we need the session
      // to persist for --resume on the next turn.
      trace("destroy", { sid: msg.opencodeSessionId, hadSession: sessions.has(msg.opencodeSessionId) });
      // Pool cleanup is handled per-request via poolKey, not via this action.
      break;
    }

    case "cleanup": {
      // Kill subprocess AND remove session state. Used by tests.
      const session = sessions.get(msg.opencodeSessionId);
      if (session) {
        pool.destroy(msg.opencodeSessionId, session.modelId);
        sessions.delete(msg.opencodeSessionId);
        saveSessions();
        trace("cleanup", { sid: msg.opencodeSessionId });
      }
      break;
    }

    case "status": {
      emitBroadcast({ action: "status_reply", opencodeSessionId: msg.opencodeSessionId, procs: pool.status() });
      break;
    }

    case "ping": {
      emitBroadcast({ action: "pong" });
      break;
    }

  }
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


const pool = new SubprocessPool(process.env.CLAUDE_CLI_PATH ?? "claude");

const sessionLocks = new Map<string, Promise<void>>();
const pendingEvents = new Map<string, IpcToPlugin[]>();
const sseClients = new Map<string, (msg: IpcToPlugin) => void>();

function flushToSse(sessionId: string, send: (msg: IpcToPlugin) => void) {
  const buf = pendingEvents.get(sessionId) ?? [];
  pendingEvents.delete(sessionId);
  for (const m of buf) { try { send(m); } catch { break; } }
}

function broadcastToSession(sessionId: string, msg: IpcToPlugin) {
  const send = sseClients.get(sessionId);
  if (send) {
    try { send(msg); } catch { sseClients.delete(sessionId); }
  } else {
    if (!pendingEvents.has(sessionId)) pendingEvents.set(sessionId, []);
    pendingEvents.get(sessionId)!.push(msg);
  }
}

onBroadcast((msg) => {
  const sid = (msg as Record<string, unknown>).opencodeSessionId as string | undefined;
  if (sid) broadcastToSession(sid, msg);
  else {
    for (const [id, send] of sseClients) {
      try { send(msg); } catch { sseClients.delete(id); }
    }
  }
});

for (const p of [SOCK, HTTP]) {
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) { try { unlinkSync(p); } catch {} }
}

Bun.serve({
  unix: HTTP,
  idleTimeout: 0,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "POST" && url.pathname === "/") {
      return req.text().then(body => {
        try {
          handleAction(JSON.parse(body) as IpcToDaemon, pool);
        } catch (e) {
          console.error("parse:", e);
        }
        return new Response("ok");
      }).catch(() => new Response("error", { status: 500 }));
    }

    if (req.method === "GET" && url.pathname === "/status") {
      return new Response(JSON.stringify({ pid: process.pid, procs: pool.status(), sessions: sessions.size }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Streaming endpoint: POST /stream — spawn + prompt, stream NDJSON response
    // Serialized per session: OpenCode may fire concurrent calls for the same
    // session (small model + main). We serialize to avoid racing --resume.
    if (req.method === "POST" && url.pathname === "/stream") {
      return req.json().then(async (body: IpcToDaemon) => {
        const { opencodeSessionId, cwd, modelId, text } = body;
        const permissions = (body.permissions ?? []) as unknown[];
        const systemPrompt = (body.systemPrompt as string) || undefined;
        const allowedTools = (body.allowedTools as string[]) || undefined;

        // Update MCP server CWD per-turn (may change via opencode-dir /cd)
        if (cwd) mcpSetCwd(cwd as string);

        // Wait for any in-flight request on this session to finish
        const prev = sessionLocks.get(opencodeSessionId);
        if (prev) {
          trace("stream.wait", { sid: opencodeSessionId });
          await prev;
        }

        const encoder = new TextEncoder();
        let closed = false;
        let releaseLock: () => void;
        const lock = new Promise<void>(r => { releaseLock = r; });
        sessionLocks.set(opencodeSessionId, lock);

        const stream = new ReadableStream({
          start(controller) {
            const send = (msg: IpcToPlugin) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(JSON.stringify(msg) + "\n"));
              } catch { closed = true; }
            };

            // Get or create persistent session
            let session = sessions.get(opencodeSessionId);
            const isNewSession = !session;

            if (!session) {
              session = {
                opencodeSessionId,
                claudeSessionId: null,
                claudeSessionPath: null,
                cwd: cwd ?? "/root",
                modelId: modelId ?? "sonnet",
              };
              sessions.set(opencodeSessionId, session);
              saveSessions();
            }

            // Persistent process: poolKey = opencodeSessionId (one process per OC session)
            const poolKey = opencodeSessionId;

            trace("stream.start", { sid: opencodeSessionId, isNew: isNewSession, sessions: sessions.size });

            const h: StreamHandler = {
              opencodeSessionId,
              onSystemInit(claudeSessionId, model, tools) {
                session.claudeSessionId = claudeSessionId;
                if (!session.claudeSessionPath) {
                  const dir = getSessionDir(session.cwd);
                  try { mkdirSync(dir, { recursive: true }); } catch {}
                  session.claudeSessionPath = getSessionPath(session.cwd, claudeSessionId);
                }
                saveSessions();
                trace("stream.init", { sid: opencodeSessionId, claude: claudeSessionId });
                send({ action: "session_ready", opencodeSessionId, claudeSessionId, model, tools });
              },
              onChunk(type, data) {
                send({ action: "chunk", opencodeSessionId, chunkType: type, ...data } as unknown as IpcToPlugin);
              },
              onFinish(finish) {
                trace("stream.finish", { sid: opencodeSessionId, claude: session.claudeSessionId });
                send({
                  action: "finish",
                  opencodeSessionId,
                  finishReason: finish.finishReason,
                  usage: finish.usage,
                  providerMetadata: finish.providerMetadata,
                });
                // Remove handler but DON'T destroy process — it stays alive for next turn
                pool.abort(opencodeSessionId, poolKey);
                releaseLock!();
                if (!closed) { closed = true; try { controller.close(); } catch {} }
              },
              onError(err) {
                trace("stream.error", { sid: opencodeSessionId, err });
                send({ action: "error", opencodeSessionId, message: err });
                // On error, kill the process — next turn will spawn fresh
                pool.destroy(opencodeSessionId, poolKey);
                releaseLock!();
                if (!closed) { closed = true; try { controller.close(); } catch {} }
              },
            };

            // First turn: spawn process. Subsequent turns: reuse existing.
            pool.sendSpawn(poolKey, session.modelId, h, undefined, permissions, systemPrompt, allowedTools, cwd as string);
            pool.sendPrompt(opencodeSessionId, poolKey, text ?? "");
          },
          cancel() {
            closed = true;
            releaseLock!();
          },
        });

        return new Response(stream, {
          headers: { "Content-Type": "application/x-ndjson" },
        });
      }).catch(() => new Response("error", { status: 500 }));
    }

    if (req.method === "GET" && url.pathname === "/sse") {
      const sessionId = url.searchParams.get("session") ?? "_all_";
      const encoder = new TextEncoder();
      let closed = false;

      const stream = new ReadableStream({
        start(controller) {
          const send = (msg: IpcToPlugin) => {
            if (closed) return;
            try {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(msg)}\n\n`));
            } catch { closed = true; }
          };
          sseClients.set(sessionId, send);
          flushToSse(sessionId, send);
        },
        cancel() {
          closed = true;
          sseClients.delete(sessionId);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "X-Accel-Buffering": "no",
        },
      });
    }

    return new Response("clwnd", { status: 200 });
  },
});

// ─── MCP HTTP Server (persistent, no cold start) ────────────────────────────

import { handleMcpRequest, setCwd as mcpSetCwd, setPermissions as mcpSetPerms, setAllowedTools as mcpSetAllowed } from "../mcp/tools.ts";

const MCP_PORT = parseInt(process.env.CLWND_MCP_PORT ?? "0") || 0;

const MCP_HOST = process.env.CLWND_HOST ?? "127.0.0.1";

const mcpServer = Bun.serve({
  port: MCP_PORT,
  hostname: MCP_HOST,
  async fetch(req) {
    if (req.method !== "POST") return new Response("clwnd-mcp", { status: 200 });
    try {
      const body = await req.json();
      const result = await handleMcpRequest(body);
      if (!result) return new Response("", { status: 204 });
      return Response.json(result);
    } catch (e: any) {
      return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: e.message } });
    }
  },
});

const MCP_URL = `http://${MCP_HOST}:${mcpServer.port}`;
mcpSetCwd(process.env.CLWND_CWD ?? process.env.HOME ?? "/");

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

process.on("SIGINT",  () => { pool.killAll(); process.exit(0); });
process.on("SIGTERM", () => { pool.killAll(); process.exit(0); });
process.on("uncaughtException",  e => console.error("uncaught:", e));
process.on("unhandledRejection", e => console.error("unhandled:", e));

info("ready", { http: HTTP, mcp: MCP_URL, pid: process.pid, version: CURRENT_VERSION });

// Set small_model to a free opencode model so title gen doesn't spawn claude processes
(async () => {
  try {
    const configHome = process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "", ".config");
    const configPath = join(configHome, "opencode", "opencode.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    // Only touch if unset or already a -free model (don't override user choice)
    if (config.small_model && !config.small_model.includes("-free")) return;
    const home = process.env.HOME ?? "";
    const opencodeBin = [join(home, ".opencode", "bin", "opencode"), "opencode"].find(p => existsSync(p)) ?? "opencode";
    const proc = spawn({ cmd: [opencodeBin, "models"], stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    const freeModels = out.split("\n").filter(l => l.includes("opencode/") && l.includes("-free")).map(l => l.trim());
    if (freeModels.length === 0) return;
    const pick = freeModels[Math.floor(Math.random() * freeModels.length)];
    if (config.small_model === pick) return;
    config.small_model = pick;
    writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
    info("small_model", { model: pick });
  } catch {}
})();
