import { spawn, type FileSink } from "bun";
import { existsSync, unlinkSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { randomUUID } from "crypto";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

import { trace, info } from "../log.ts";
import { loadConfig } from "../lib/config.ts";
import { sigil, rid as makeRid, echo, pulse, isDusk, classifySuspicion, WaneTracker, Drone, type Tone, type DroneBeat, type DroneState, type Breath, type BreathSession, type Reach, type DroneAction, type PulseKind, type Pulse } from "../lib/hum.ts";
import { droneThink, setDroneWorkspace, releaseDroneSession } from "../lib/drone-llm.ts";
import { graft, createSession as createClaudeSession, sessionDir as getSessionDir, sessionPath as getSessionPath, lastUuid, sanitizeJsonl, type GraftResult } from "../lib/session.ts";
import { penny, pennyAdd, pennyLoad, pennySave, pennyReset, type PennyDelta } from "../lib/penny.ts";


// ─── Shapes ─────────────────────────────────────────────────────────────────

interface BloomListener {
  sessionId: string;
  onRoost(claudeId: string, model: string, tools: string[]): void;
  onPetal(type: string, payload: Record<string, unknown>): void;
  onWilt(harvest: { finishReason: string; usage: Record<string, number> | undefined; providerMetadata: Record<string, unknown> }): void;
  onThorn(wound: string): void;
}

// ─── Protocol ────────────────────────────────────────────────────────────────

function encodePrompt(content: Array<Record<string, unknown>> | string): string {
  const parts = typeof content === "string"
    ? [{ type: "text", text: content }]
    : content;
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: parts },
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

interface RoostProc {
  pid: number | undefined;
  stdin: FileSink;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill(signal?: number): void;
  exited: Promise<number>;
}

interface Roost {
  proc: RoostProc;
  listeners: Map<string, BloomListener>;
  activeSid: string | null;
}

const cfg = loadConfig();
const MAX_PROCS = cfg.maxProcs;
const IDLE_TIMEOUT = cfg.idleTimeout;

class ClaudeNest {
  private roosts = new Map<string, Roost>();
  private idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private cliPath = "claude") {}

  awaken(poolKey: string, modelId: string, listener: BloomListener, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): void {
    let roost = this.roosts.get(poolKey);

    // Respawn if session was seeded with new history
    const session = sessions.get(poolKey);
    if (session?.needsRespawn) {
      if (roost) {
        trace("nest.respawn", { poolKey, reason: "seed" });
        // Synchronously emit roost-died so the drone's pulse handler resets
        // per-process counters. The proc.exited async handler skips its
        // own emission on the stale branch (current !== roost after the map
        // mutates below), so without this the drone's inflightTools leaks.
        humPulse("roost-died", poolKey, { pid: roost.proc.pid, reason: "respawn" });
        try { roost.proc.kill(); } catch {}
        this.roosts.delete(poolKey);
        roost = undefined;
      }
      session.needsRespawn = false;
      saveSessions(poolKey);
    }

    // Cancel idle timer — session is active again
    const idleTimer = this.idleTimers.get(poolKey);
    if (idleTimer) {
      clearTimeout(idleTimer);
      this.idleTimers.delete(poolKey);
    }

    if (!roost) {
      // Evict oldest idle roost if at maxProcs limit
      if (this.roosts.size >= MAX_PROCS) {
        let evictKey: string | null = null;
        for (const [key, r] of this.roosts) {
          if (r.listeners.size === 0 && r.activeSid === null) { evictKey = key; break; }
        }
        if (evictKey) {
          trace("nest.evicted", { poolKey: evictKey, reason: "maxProcs" });
          humPulse("roost-evicted", evictKey, { reason: "maxProcs" });
          try { this.roosts.get(evictKey)!.proc.kill(); } catch {}
          this.roosts.delete(evictKey);
          this.idleTimers.delete(evictKey);
        } else {
          trace("nest.rejected", { poolKey, reason: "maxProcs", active: this.roosts.size });
        }
      }
      roost = this.spawnProc(poolKey, modelId, claudeSessionId ?? session?.claudeSessionId ?? undefined, permissions, systemPrompt, allowedTools, sessionCwd);
    } else {
      mcpSetPerms((permissions ?? []) as any);
      mcpSetAllowed(allowedTools);
    }
    listener.onPetal("stream_start", {});
    roost.listeners.set(listener.sessionId, listener);
  }

  interrupt(poolKey: string): void {
    const roost = this.roosts.get(poolKey);
    if (!roost) return;
    const requestId = randomUUID();
    roost.proc.stdin.write(JSON.stringify({
      type: "control_cancel_request",
      request_id: requestId,
    }) + "\n");
    trace("nest.interrupted", { poolKey, requestId });
  }

  murmur(sessionId: string, poolKey: string, content: Array<Record<string, unknown>> | string): void {
    const roost = this.roosts.get(poolKey);
    if (!roost?.proc.stdin) return;
    roost.activeSid = sessionId;
    const len = typeof content === "string" ? content.length : content.reduce((s, p) => s + ((p.text as string)?.length ?? 0), 0);
    trace("nest.murmured", { sid: sessionId, poolKey, len, parts: typeof content === "string" ? 1 : content.length });
    roost.proc.stdin.write(encodePrompt(content) + "\n");
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

      // Start idle timer — kill process if no new messages within timeout
      if (IDLE_TIMEOUT > 0 && roost.listeners.size === 0) {
        this.idleTimers.set(poolKey, setTimeout(() => {
          const r = this.roosts.get(poolKey);
          if (r && r.listeners.size === 0) {
            trace("nest.idle", { poolKey, pid: r.proc.pid, timeout: IDLE_TIMEOUT });
            humPulse("roost-idle", poolKey, { pid: r.proc.pid });
            try { r.proc.kill(); } catch {}
            this.roosts.delete(poolKey);
          }
          this.idleTimers.delete(poolKey);
        }, IDLE_TIMEOUT));
      }
    }
  }

  fell(sessionId: string, poolKey: string): void {
    const roost = this.roosts.get(poolKey);
    if (roost) {
      roost.listeners.delete(sessionId);
      if (roost.activeSid === sessionId) roost.activeSid = null;
      if (roost.listeners.size === 0) {
        trace("nest.felled", { poolKey, pid: roost.proc.pid });
        // Emit roost-died BEFORE the kill + map delete. The async
        // proc.exited handler checks `current === roost` and skips its own
        // emission once the map no longer holds this entry (stale branch),
        // so the drone would never hear this process die. Synchronous pulse
        // here gives the drone's pulse handler a chance to reset counters.
        humPulse("roost-died", poolKey, { pid: roost.proc.pid, reason: "felled" });
        try { roost.proc.kill(); } catch {}
        this.roosts.delete(poolKey);
        const timer = this.idleTimers.get(poolKey);
        if (timer) { clearTimeout(timer); this.idleTimers.delete(poolKey); }
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
    for (const timer of this.idleTimers.values()) clearTimeout(timer);
    this.idleTimers.clear();
  }

  private spawnProc(poolKey: string, modelId: string, claudeSessionId?: string, permissions?: unknown[], systemPrompt?: string, allowedTools?: string[], sessionCwd?: string): Roost {
    // Update MCP server state for this request
    mcpSetPerms((permissions ?? []) as any);
    mcpSetAllowed(allowedTools);
    if (sessionCwd) mcpSetCwd(sessionCwd);

    // MCP config — session-scoped URL so tools/list returns correct external tools
    const mcpConfig = JSON.stringify({
      mcpServers: {
        clwnd: { type: "http", url: `${MCP_URL}/s/${poolKey}` },
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
      // Register our MCP server — strict mode prevents ambient .mcp.json discovery
      "--mcp-config", mcpConfig,
      "--strict-mcp-config",
      // Kill skills — OC controls the session, Claude CLI skills not needed
      "--disable-slash-commands",
    ];
    // System prompt set once at spawn — persistent process keeps it
    if (systemPrompt) {
      cmd.push("--system-prompt", systemPrompt);
    }
    // Resume from seeded JSONL session (cold-start history export)
    if (claudeSessionId) {
      // Sanitize JSONL before resume — fix structural violations that cause 400 errors
      const spawnCwd2 = sessionCwd ?? process.env.CLWND_CWD ?? process.env.HOME ?? "/";
      const jsonlPath = getSessionPath(spawnCwd2, claudeSessionId);
      try {
        if (existsSync(jsonlPath)) {
          const result = sanitizeJsonl(jsonlPath);
          if (result.fixed > 0) {
            trace("sanitize.applied", { poolKey, removed: result.removed, fixed: result.fixed, rules: result.rules });
          }
        }
      } catch (e) {
        trace("sanitize.error", { poolKey, err: String(e) });
      }
      cmd.push("--resume", claudeSessionId);
    }
    const spawnCwd = sessionCwd ?? process.env.CLWND_CWD ?? process.env.HOME ?? "/";
    const proc = spawn({
      cmd,
      cwd: spawnCwd,
      env: {
        ...process.env,
        TERM: "xterm-256color",
        DIRENV_DISABLE: "1",
        ENABLE_TOOL_SEARCH: "false",            // prevents cache invalidation from dynamic tool schema injection
        CLAUDE_CODE_DISABLE_FAST_MODE: "1",     // fast mode costs 6x — we control the model
        DISABLE_INTERLEAVED_THINKING: "1",      // reduces context overhead from interleaved thinking blocks
      },
      stdout: "pipe",
      stdin: "pipe",
      stderr: "pipe",
    });
    // Bun spawn with stdin/stdout/stderr: "pipe" — narrow the proc shape
    const roostProc: RoostProc = {
      pid: proc.pid,
      stdin: proc.stdin as FileSink,
      stdout: proc.stdout as ReadableStream<Uint8Array>,
      stderr: proc.stderr as ReadableStream<Uint8Array>,
      kill: (signal?: number) => proc.kill(signal),
      exited: proc.exited,
    };

    const roost: Roost = { proc: roostProc, listeners: new Map(), activeSid: null };
    this.roosts.set(poolKey, roost);
    info("nest.awakened", { poolKey, model: modelId, pid: roostProc.pid, resume: claudeSessionId ?? "none" });
    humPulse("roost-spawned", poolKey, { pid: roostProc.pid });

    this.readStderr(roostProc, poolKey);

    roostProc.exited.then(code => {
      trace("nest.exited", { poolKey, code, pid: roostProc.pid });
      // Only clean up if this roost is still the current one — a new spawn may have replaced it
      const current = this.roosts.get(poolKey);
      if (current === roost) {
        humPulse("roost-died", poolKey, { pid: roostProc.pid, reason: `exit:${code}` });
        for (const listener of roost.listeners.values()) {
          try { listener.onThorn(`subprocess exited: code=${code}`); } catch {}
        }
        roost.listeners.clear();
        roost.activeSid = null;
        this.roosts.delete(poolKey);
      } else {
        trace("nest.exited.stale", { poolKey, pid: roostProc.pid, reason: "replaced by newer roost" });
      }
    });

    this.readLoop(roostProc, poolKey, roost);
    return roost;
  }

  private readStderr(proc: RoostProc, modelId: string): void {
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

  private readLoop(proc: RoostProc, poolKey: string, roost: Roost): void {
    const reader = proc.stdout.getReader();
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
        drone.observed(sigil(poolKey), { type: "permission_ask" });

        hum(roost.activeSid ?? "", { chi: "permission-ask", askId, tool: toolName, path, input: msg.input ?? {}, dusk: Date.now() + cfg.permissionDusk });

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
        }, cfg.permissionDusk);
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
      if (block.type === "tool_use") {
        petal("tool_input_start", { toolCallId: block.id as string, toolName: block.name as string });
        drone.observed(sigil(poolKey), { type: "tool_start", toolName: block.name as string });
      }
      return;
    }

    if (msg.type === "content_block_delta") {
      this.streamedTurn = true;
      const delta = (msg.delta ?? {}) as Record<string, unknown>;
      if (delta.type === "thinking_delta") petal("reasoning_delta", { delta: delta.thinking as string });
      if (delta.type === "text_delta") {
        petal("text_delta", { delta: delta.text as string });
        drone.observed(sigil(poolKey), { type: "text_delta", text: delta.text as string });
      }
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
          drone.observed(sigil(poolKey), { type: "tool_end" });
        }
      }
      return;
    }

    if (msg.type === "result") {
      this.streamedTurn = false;
      drone.observed(sigil(poolKey), { type: "turn_end" });
      if (msg.subtype === "error_during_execution" || msg.is_error) {
        trace("stream.result.error", { raw: JSON.stringify(msg).slice(0, 500) });
      }
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
  needsRespawn?: boolean;
  lastAccessed?: number;
  lastSyncedPetal?: string | null; // uuid of last synced JSONL entry
  ocServerUrl?: string;
  thorns?: number; // consecutive error count — circuit breaker
  externalToolNames?: string[]; // sorted names of external MCP tools — respawn on change
  // Per-session cached hum fields. Plugin dedups these — when a hum
  // message omits them, we fall back to the cached value so a cold-spawn
  // still gets the right system prompt / permissions / allowedTools.
  lastSystemPrompt?: string;
  lastPermissions?: unknown[];
  lastAllowedTools?: string[];
  // Largest per-turn input context (input + cache_create + cache_read) seen
  // so far, captured from each result event's usage block. Pure observation:
  // surfaced via `clwnd savings` and used to emit a warning trace when a
  // session climbs past CONTEXT_WARN_THRESHOLD. Context reduction is OC's
  // job — clwnd does not mutate session state on this signal.
  maxContextTokens?: number;
}

// Advisory threshold. When a session's peak per-turn input context crosses
// this value, clwnd emits a `context.over.threshold.warning` trace on the
// next prompt and bumps `penny.contextOverThreshold`. Operator-facing signal
// only — no state mutation.
const CONTEXT_WARN_THRESHOLD = Number(process.env.CLWND_CONTEXT_WARN ?? "300000");

const STATE_DIR = process.env.XDG_STATE_HOME
  ? `${process.env.XDG_STATE_HOME}/clwnd`
  : `${process.env.HOME}/.local/state/clwnd`;
const SESSIONS_FILE = `${STATE_DIR}/sessions.json`;
const PENNY_FILE = `${STATE_DIR}/penny.json`;

// Load persisted penny counters (lifetime view) and start a write-back timer.
pennyLoad(PENNY_FILE);
const pennyPersistInterval = setInterval(() => pennySave(PENNY_FILE), 60_000);
pennyPersistInterval.unref?.();
process.on("SIGTERM", () => { try { pennySave(PENNY_FILE); } catch {} });
process.on("SIGINT", () => { try { pennySave(PENNY_FILE); } catch {} });

function loadSessions(): Map<string, Session> {
  try {
    const data = JSON.parse(readFileSync(SESSIONS_FILE, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

function saveSessions(mutatedSid?: string): void {
  if (mutatedSid) {
    const s = sigil(mutatedSid);
    const w = wane.tick(s);
    drone.setWane(s, w);
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    const obj: Record<string, Session> = {};
    for (const [k, v] of sessions) obj[k] = v;
    writeFileSync(SESSIONS_FILE, JSON.stringify(obj));
  } catch {}
}

const sessions = loadSessions();

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
const wane = new WaneTracker();
const DEFAULT_OC_URL = "http://127.0.0.1:4096";

// Drone: self-governing observer — opt-in via droned:true in clwnd.json
// When off, the hum is a raw pipe. When on, the sentinel watches everything.
const DRONED = cfg.droned;

function ocUrlForSigil(s: string): string {
  for (const [sid, session] of sessions) {
    if (sigil(sid) === s) return session.ocServerUrl ?? DEFAULT_OC_URL;
  }
  return DEFAULT_OC_URL;
}

function droneCtx(text: string, state: DroneState): Parameters<typeof droneThink>[0] {
  return {
    responseText: text,
    inflightTools: state.inflightTools,
    pendingPermissions: state.pendingPermissions,
    tokensBurned: state.tokensBurned,
    turnCount: 0,
    localWane: state.localWane,
    remoteWane: state.remoteWane,
    missedBeats: state.missedBeats,
    pendingEchoes: state.pendingEchoes.size,
    toolNames: [],
  };
}

const droneEvaluator = async (text: string, state: DroneState): Promise<number> => {
  const level = classifySuspicion(text);

  // Clean: no heuristic flags
  if (level === "none") return 0.1;

  // Critical: near-certain context loss — high confidence without LLM
  if (level === "critical") {
    trace("drone.heuristic.critical", { sigil: state.sigil, text: text.slice(0, 200) });
    return 0.9;
  }

  // Suspicious: compensation detected — ask the LLM to confirm
  trace("drone.heuristic.suspicious", { sigil: state.sigil, text: text.slice(0, 200) });
  try {
    const s = state.sigil;
    const url = s ? ocUrlForSigil(s) : DEFAULT_OC_URL;
    const judgment = await droneThink(droneCtx(text, state), url, s);
    trace("drone.llm.judgment", { assessment: judgment.assessment, action: judgment.action, reason: judgment.reason });
    return judgment.action === "swallow" ? 0.9 : judgment.action === "none" ? 0.2 : 0.6;
  } catch (e) {
    trace("drone.llm.failed", { err: String(e) });
    // Suspicious + LLM unreachable — lean towards swallow
    return 0.75;
  }
};

const drone = DRONED ? new Drone("daemon", (action: DroneAction) => {
  switch (action.type) {
    case "beat":
      // Send drone beat to the sigil's client
      for (const [, client] of humClients) {
        if (client.sigils.has(action.sigil) || client.sigils.size === 0) {
          humTo(client, action.beat as unknown as Record<string, unknown>);
          break;
        }
      }
      break;
    case "retry":
      trace("drone.retry", { sigil: action.sigil, rid: action.rid, chi: action.chi });
      // Retry is handled by re-acking — the original tone was already processed,
      // the echo was lost. Re-send echo.
      for (const [, client] of humClients) {
        if (client.sigils.has(action.sigil)) {
          humTo(client, { chi: "echo", rid: action.rid, ok: true, retried: true });
          break;
        }
      }
      break;
    case "lost":
      trace("drone.lost", { sigil: action.sigil, rid: action.rid, chi: action.chi });
      break;
    case "drift":
      trace("drone.drift", { sigil: action.sigil, local: action.local, remote: action.remote });
      // Trigger breath resync to the drifted client
      for (const [, client] of humClients) {
        if (client.sigils.has(action.sigil)) {
          humBreath(client);
          break;
        }
      }
      break;
    case "dead":
      trace("drone.dead", { sigil: action.sigil, missedBeats: action.missedBeats });
      // Clean up stale sigil — but don't disconnect the client (it may own active sessions too)
      for (const [, client] of humClients) {
        if (client.sigils.has(action.sigil)) {
          client.sigils.delete(action.sigil);
          break;
        }
      }
      break;
    case "swallow":
      // Wither is handled by cupped petals in onPetal — daemon-side only.
      // The Drone class may still emit this from its evaluator, but onPetal already acted.
      trace("drone.wither.noop", { sigil: action.sigil, reason: action.reason });
      break;
  }
}, droneEvaluator, 0.7, (s, state) => {
  // LLM assessment on silence — full state evaluation
  droneThink(droneCtx(state.responseText, state), ocUrlForSigil(s), s).then(judgment => {
    trace("drone.llm.assess", { sigil: s, assessment: judgment.assessment, action: judgment.action, reason: judgment.reason });
    // Act on LLM judgment
    if (judgment.action === "respawn") {
      for (const [sid, session] of sessions) {
        if (sigil(sid) === s) { nest.fell(sid, sid); break; }
      }
    } else if (judgment.action === "reseed") {
      for (const [sid, session] of sessions) {
        if (sigil(sid) === s) { session.needsRespawn = true; saveSessions(sid); break; }
      }
    } else if (judgment.action === "swallow") {
      // Swallow from silence path — by the time silence fires, the stream is done.
      // Set needsRespawn so next prompt starts fresh.
      for (const [sid, session] of sessions) {
        if (sigil(sid) === s) {
          session.needsRespawn = true;
          saveSessions(sid);
          break;
        }
      }
    }
  }).catch(e => trace("drone.llm.assess.failed", { sigil: s, err: String(e) }));
}) : { sent() {}, heard() {}, observed() {}, setWane() {}, inspect() { return new Map(); }, stop() {} } as unknown as Drone;

const HUM = SOCK + ".hum";

for (const p of [SOCK, HTTP, HUM]) {
  mkdirSync(dirname(p), { recursive: true });
  if (existsSync(p)) { try { unlinkSync(p); } catch {} }
}

// ─── clwndHum: Bidirectional NDJSON socket ─────────────────────────────────
// One persistent connection per provider instance. Both sides push typed
// JSON messages (chi = message type). Replaces HTTP request/response dance.

const humClients = new Map<string, Reach>();

function humTo(client: Reach, msg: Record<string, unknown> | Breath): void {
  try { client.socket.write(JSON.stringify(msg) + "\n"); } catch {}
}

function humAll(msg: Record<string, unknown>): void {
  trace("hum.all", { chi: msg.chi as string, clients: humClients.size });
  for (const [, client] of humClients) humTo(client, msg);
}

function hum(sessionId: string, msg: Record<string, unknown>): void {
  const s = sigil(sessionId);
  if (!msg.rid) msg.rid = makeRid();
  if (!msg.sigil) msg.sigil = s;
  if (!msg.sid) msg.sid = sessionId;
  msg.from = "daemon";
  trace("hum.tone.sent", { chi: msg.chi as string, sid: sessionId, rid: msg.rid as string });
  // Route to first client that owns this sigil — no duplicates
  let sent = false;
  for (const [, client] of humClients) {
    if (client.sigils.has(s)) {
      humTo(client, msg);
      sent = true;
      break;
    }
  }
  // Fallback: if no client claimed this sigil, broadcast to unregistered clients
  if (!sent) {
    for (const [, client] of humClients) {
      if (client.sigils.size === 0) humTo(client, msg);
    }
  }
  // Drone observes outgoing tones
  drone.sent(msg);
}

function humBreath(client: Reach): void {
  const sessionList: BreathSession[] = [];
  for (const [sid, session] of sessions) {
    // Only sync sessions with meaningful state
    if (!session.claudeSessionId && !session.lastSyncedPetal) continue;
    const s = sigil(sid);
    sessionList.push({
      sigil: s,
      sid,
      claudeSessionId: session.claudeSessionId,
      claudeSessionPath: session.claudeSessionPath,
      lastSyncedPetal: session.lastSyncedPetal ?? null,
      wane: wane.get(s),
      modelId: session.modelId,
      cwd: session.cwd,
      roostAlive: !!nest.roost(sid),
      roostPid: nest.roost(sid)?.proc.pid,
    });
  }
  const msg: Breath = { chi: "breath", from: "daemon", sessions: sessionList };
  humTo(client, msg);
  trace("hum.breath.sent", { clientId: client.clientId.slice(0, 8), sessions: sessionList.length });
}

function humEcho(clientId: string, tone: Record<string, unknown>, ok = true, error?: string): void {
  const client = humClients.get(clientId);
  if (!client) return;
  humTo(client, { chi: "echo", rid: tone.rid, ok, error });
}

function humPulse(kind: PulseKind, sid: string, extra?: Partial<Pulse>): void {
  const p = pulse(kind, sigil(sid), sid, extra);
  hum(sid, p as unknown as Record<string, unknown>);
}

function humHear(clientId: string, msg: Record<string, unknown>): void {
  const chi = msg.chi as string;
  if (chi !== "log") trace("hum.tone.received", { chi, clientId: clientId.slice(0, 8), rid: msg.rid as string });

  // Drone observes incoming tones
  drone.heard(msg);

  // Dusk: discard tones past their expiry
  if (isDusk(msg)) {
    trace("hum.tone.dusk", { chi, rid: msg.rid as string, dusk: msg.dusk });
    humEcho(clientId, msg, false, "past dusk");
    return;
  }

  // Echo: acknowledge receipt
  if (chi !== "echo" && chi !== "log" && msg.rid) {
    humEcho(clientId, msg);
  }

  switch (chi) {
    case "prompt": {
      // Plugin piggybacks its counter delta on every prompt — ingest before
      // anything else so counts don't miss on errors/early returns below.
      if (msg.pennyDelta) pennyAdd(msg.pennyDelta as PennyDelta);

      const sid = msg.sid as string;
      const client = humClients.get(clientId);
      (async () => {
      if (client) client.sigils.add(sigil(sid));

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
        saveSessions(sid);
        trace("session.created", { sid, model: session.modelId });
      }
      session.lastAccessed = Date.now();

      // Plugin may omit these fields on steady-state turns (hash-dedup). Fall
      // back to the session's last-known value so cold-spawns and respawns
      // still get the correct system prompt / permissions / allowedTools.
      const permissions = ("permissions" in msg
        ? (msg.permissions as unknown[] ?? [])
        : (session.lastPermissions ?? [])) as unknown[];
      const systemPrompt = ("systemPrompt" in msg
        ? ((msg.systemPrompt as string) || undefined)
        : session.lastSystemPrompt);
      const allowedTools = ("allowedTools" in msg
        ? ((msg.allowedTools as string[]) || undefined)
        : session.lastAllowedTools);
      // Cache fresh values when the plugin sent them.
      if ("permissions" in msg) session.lastPermissions = permissions;
      if ("systemPrompt" in msg && systemPrompt !== undefined) session.lastSystemPrompt = systemPrompt;
      if ("allowedTools" in msg && allowedTools !== undefined) session.lastAllowedTools = allowedTools;
      const cwd = msg.cwd as string | undefined;
      const ocServerUrl = (msg.ocServerUrl as string) || DEFAULT_OC_URL;

      if (cwd) mcpSetCwd(cwd);
      if (permissions.length > 0) {
        setSessionPermissions(sid, permissions as any);
      }

      const poolKey = sid;

      // Update model, cwd, and OC server URL — prompt always carries current values
      if (msg.modelId) session.modelId = msg.modelId as string;
      if (cwd) session.cwd = cwd;
      if (ocServerUrl !== DEFAULT_OC_URL) session.ocServerUrl = ocServerUrl;

      // Skip tool registration on listenOnly (permission return) — avoid spurious respawn
      if (!msg.listenOnly) {
        // External MCP tools — register for this session, respawn if changed
        const extTools = (msg.externalTools as ExternalToolDef[] | undefined) ?? [];
        const prevNames = (session.externalToolNames ?? []).join(",");
        const currNames = extTools.map(t => t.name).sort().join(",");
        if (extTools.length > 0) setExternalTools(sid, extTools);
        else clearExternalTools(sid);
        if (currNames !== prevNames) {
          session.externalToolNames = extTools.map(t => t.name).sort();
          if (prevNames) {
            session.needsRespawn = true;
            trace("external.tools.changed", { sid, prev: prevNames, curr: currNames });
          } else if (extTools.length > 0) {
            trace("external.tools.registered", { sid, count: extTools.length, names: currNames });
          }
        }

        // External MCP server configs — daemon connects directly for tool execution
        const mcpConfigs = (msg.mcpServerConfigs as Array<{ name: string; type: string; command: string[]; environment?: Record<string, string> }> | undefined) ?? [];
        if (mcpConfigs.length > 0) {
          setMcpServerConfigs(sid, mcpConfigs as Array<{ name: string; type: "local"; command: string[]; environment?: Record<string, string> }>);
          trace("mcp.configs.registered", { sid, servers: mcpConfigs.map(c => c.name).join(",") });
        } else {
          clearMcpServerConfigs(sid);
        }

        // Visible tools — OC decides what Claude sees (filtered by agent permissions)
        const visibleToolNames = msg.visibleTools as string[] | undefined;
        if (visibleToolNames && visibleToolNames.length > 0) {
          setVisibleTools(sid, visibleToolNames);
        }
      }

      // Circuit breaker — stop after 3 consecutive errors
      const MAX_THORNS = 3;
      if ((session.thorns ?? 0) >= MAX_THORNS) {
        trace("nest.thorns.breaker", { sid, thorns: session.thorns });
        hum(sid, { chi: "error", sid, message: `circuit breaker: ${session.thorns} consecutive errors` });
        return;
      }

      // Advisory: if the prior turn's peak input context crossed the warning
      // threshold, emit a trace and bump the penny counter so an operator
      // sees a session climbing toward the cache-replay tax. No state
      // mutation; OC owns context reduction.
      if (!msg.listenOnly && (session.maxContextTokens ?? 0) > CONTEXT_WARN_THRESHOLD) {
        penny.contextOverThreshold++;
        trace("context.over.threshold.warning", {
          sid,
          maxCtx: session.maxContextTokens,
          threshold: CONTEXT_WARN_THRESHOLD,
        });
      }

      // Graft: sync OC petals into Claude JSONL before spawning (skip for title gen / empty tools)
      const priorPetals = msg.priorPetals as Array<{ role: string; content: unknown }> | undefined;
      if (!msg.listenOnly && !msg.skipGraft && priorPetals && priorPetals.length > 0) {
        trace("graft.enter", { sid, petals: priorPetals.length });
        try {
          const effectiveCwd = cwd ?? session.cwd;
          if (session.claudeSessionId && session.claudeSessionPath) {
            // Existing JSONL — graft any new petals
            const result = graft(priorPetals ?? [], session.claudeSessionPath, session.claudeSessionId, effectiveCwd, session.lastSyncedPetal);
            // Always update anchor — even grafted=0, the JSONL may have grown from Claude's native entries
            if (result.lastPetal) session.lastSyncedPetal = result.lastPetal;
            if (result.grafted > 0) {
              session.needsRespawn = true;
              saveSessions(sid);
              trace("graft.done", { sid, grafted: result.grafted });
            }
          } else {
            // Cold start — peek OC for petals, create JSONL only if there's content
            const peekId = randomUUID();
            const peekPath = createClaudeSession(effectiveCwd, peekId);
            const result = graft(priorPetals ?? [], peekPath, peekId, effectiveCwd);
            if (result.grafted > 0) {
              session.claudeSessionId = peekId;
              session.claudeSessionPath = peekPath;
              session.lastSyncedPetal = result.lastPetal;
              session.needsRespawn = true;
              saveSessions(sid);
              trace("graft.cold", { sid, grafted: result.grafted });
            } else {
              // No petals — delete the empty JSONL skeleton
              trace("graft.cold.empty", { sid });
              try { unlinkSync(peekPath); } catch {}
            }
          }
        } catch (e) {
          trace("graft.failed", { sid, err: String(e) });
        }
      }

      // Capture prompt content for deferred murmur
      const promptContent: Array<Record<string, unknown>> | string | null =
        !msg.listenOnly ? (msg.content as Array<Record<string, unknown>> | undefined) ?? (msg.text as string ?? "") : null;
      const isResume = !!(session.claudeSessionId && session.needsRespawn);
      let withered = false; // shared between onPetal and onWilt — true when bad petals were discarded
      let uncup: (() => void) | null = null; // set by onPetal closure — flushes cupped petals to plugin

      const listener: BloomListener = {
        sessionId: sid,
        onRoost(claudeSessionId, model, tools) {
          session.claudeSessionId = claudeSessionId;
          if (!session.claudeSessionPath) {
            // Use the cwd passed to awaken (= spawnCwd), not session.cwd,
            // because Claude CLI determines its project dir from spawnCwd
            const effectiveCwd = cwd ?? session.cwd;
            const dir = getSessionDir(effectiveCwd);
            try { mkdirSync(dir, { recursive: true }); } catch {}
            session.claudeSessionPath = getSessionPath(effectiveCwd, claudeSessionId);
          }
          saveSessions(sid);
          hum(sid, { chi: "session-ready", sid, claudeSessionId, model, tools });
          humPulse("roost-ready", sid, { pid: nest.roost(poolKey)?.proc.pid });
        },
        onPetal: (() => {
          let batch: string[] = [];
          let pending = false;
          // Cupped petals: daemon cups early petals to check for context loss before blooming
          const CUP_THRESHOLD = 200;
          const MAX_WITHERS = 1;
          let withers = 0;
          let cupped: string[] = [];
          let cuppedText = "";
          let uncupped = !DRONED; // drone off = bloom directly

          function sendChunks(chunks: string[]) {
            const line = chunks.join("\n") + "\n";
            const s = sigil(sid);
            let sent = false;
            for (const [, client] of humClients) {
              if (client.sigils.has(s)) {
                try { client.socket.write(line); } catch {}
                sent = true;
                break;
              }
            }
            if (!sent) {
              for (const [, client] of humClients) {
                if (client.sigils.size === 0) try { client.socket.write(line); } catch {}
              }
            }
          }

          function doUncup() {
            if (uncupped) return;
            uncupped = true;
            trace("nest.uncup", { sid, cuppedChunks: cupped.length, cuppedLen: cuppedText.length });
            if (cupped.length > 0) {
              sendChunks(cupped);
              cupped = [];
            }
          }
          uncup = doUncup;

          function wither() {
            if (!session) return;
            withered = true;
            cupped = [];
            cuppedText = "";
            trace("drone.wither", { sid });
            // Kill process, graft, respawn, re-murmur — all internal
            nest.fell(sid, poolKey);
            session.needsRespawn = true;
            session.lastSyncedPetal = null;
            saveSessions(sid);
            // Re-send the prompt after a tick (let fell complete)
            queueMicrotask(() => {
              // Graft runs inside the prompt handler on the re-sent prompt
              const effectiveCwd = cwd ?? session.cwd;
              const ocUrl = session.ocServerUrl ?? DEFAULT_OC_URL;
              // Re-create listener state for the retry
              uncupped = !DRONED;
              withered = false;
              cuppedText = "";
              cupped = [];
              batch = [];
              pending = false;
              // Respawn with existing JSONL — history is already grafted from prior prompt
              if (promptContent) {
                (async () => {
                  try {
                    session.needsRespawn = true;
                    nest.awaken(poolKey, session.modelId, listener, session.claudeSessionId ?? undefined, permissions, systemPrompt, allowedTools, cwd);
                    nest.murmur(sid, poolKey, promptContent);
                  } catch (e) {
                    trace("drone.swallow.retry.failed", { sid, err: String(e) });
                    hum(sid, { chi: "error", sid, message: `swallow retry failed: ${e}` });
                  }
                })();
              }
            });
          }

          return (type: string, payload: Record<string, unknown>) => {
            if (withered) return; // withered — drop remaining chunks from old stream
            const chunk = JSON.stringify({ chi: "chunk", sid, chunkType: type, ...payload });

            if (uncupped) {
              // Already uncupped — bloom directly via microtask batching
              batch.push(chunk);
              if (!pending) {
                pending = true;
                queueMicrotask(() => {
                  sendChunks(batch);
                  batch = [];
                  pending = false;
                });
              }
              return;
            }

            // Detect API errors in Claude CLI's stream — interrupt before retry loop
            if (type === "text_delta" && payload.delta) {
              cuppedText += payload.delta as string;
              if (cuppedText.startsWith("API Error:")) {
                trace("nest.api.error", { sid, text: cuppedText.slice(0, 120) });
                hum(sid, { chi: "error", sid, message: cuppedText.slice(0, 200) });
                nest.interrupt(poolKey);
                withered = true;
                return;
              }
            }

            // Cup phase — buffer and check
            cupped.push(chunk);

            if (cuppedText.length >= CUP_THRESHOLD) {
              const level = classifySuspicion(cuppedText);
              if ((level === "critical" || level === "suspicious") && withers < MAX_WITHERS) {
                withers++;
                trace(`drone.cup.${level}`, { sid, len: cuppedText.length, wither: withers });
                wither();
              } else {
                // Clean, or exhausted withers — uncup and bloom directly
                if (level !== "none" && withers >= MAX_WITHERS) {
                  trace("drone.cup.exhausted", { sid, level, withers });
                }
                doUncup();
              }
            }
          };
        })(),
        onWilt(harvest) {
          if (withered) return; // withered petal — don't send finish for bad petals
          session.thorns = 0; // reset circuit breaker on success
          // Advance anchor to last JSONL entry — Claude finished writing
          if (session.claudeSessionPath) {
            const tip = lastUuid(session.claudeSessionPath);
            if (tip) session.lastSyncedPetal = tip;
          }
          // Track peak per-turn input context for observability — surfaced
          // by `clwnd savings` and used by the next-prompt warning trace.
          // No destructive action attached: clwnd does not rotate sessions.
          if (harvest.usage) {
            const u = harvest.usage;
            const turnCtx = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
            if (turnCtx > (session.maxContextTokens ?? 0)) {
              session.maxContextTokens = turnCtx;
            }
          }
          trace("nest.wilt", { sid, finishReason: harvest.finishReason, maxCtx: session.maxContextTokens });
          if (uncup) uncup(); // uncup any remaining petals before finish
          hum(sid, {
            chi: "finish", sid,
            finishReason: harvest.finishReason,
            usage: harvest.usage,
            providerMetadata: harvest.providerMetadata,
          });
          nest.hush(sid, poolKey);
        },
        onThorn(wound) {
          session.thorns = (session.thorns ?? 0) + 1;
          trace("nest.thorn", { sid, wound: wound.slice(0, 100), thorns: session.thorns });
          hum(sid, { chi: "error", sid, message: wound });
          nest.fell(sid, poolKey);
        },
      };

      const hadRoost = !!nest.roost(poolKey);
      nest.awaken(poolKey, session.modelId, listener, session.claudeSessionId ?? undefined, permissions, systemPrompt, allowedTools, cwd);

      if (promptContent) {
        // Guard against empty murmurs — empty text blocks cause API 400 (cache_control on empty text)
        const hasContent = typeof promptContent === "string"
          ? promptContent.length > 0
          : Array.isArray(promptContent) && promptContent.some((p: Record<string, unknown>) => p.type !== "text" || (p.text as string)?.length > 0);
        if (hasContent) {
          nest.murmur(sid, poolKey, promptContent);
        } else {
          trace("nest.murmur.empty", { sid, poolKey });
          // Send finish so OC doesn't hang waiting for a response
          hum(sid, { chi: "finish", sid, finishReason: "stop", usage: undefined, providerMetadata: {} });
        }
      }
      })().catch(e => trace("prompt.failed", { sid, err: String(e) }));
      break;
    }

    case "cancel": {
      const sid = msg.sid as string;
      const session = sessions.get(sid);
      if (session) {
        trace("nest.cancelled", { sid, reason: msg.reason });
        if (msg.reason === "compaction") {
          // Compaction: kill the running Claude CLI process and TRUNCATE the
          // existing JSONL in place. The claudeSessionId / claudeSessionPath
          // STAY THE SAME — clwnd's invariant is one-OC-session-to-one-Claude-
          // session, stable for the lifetime of the OC session. Next prompt
          // takes the warm-path graft, which sees an effectively-empty JSONL
          // (just the summary header) and writes the compacted history into
          // it. Claude resumes from the same uuid with fresh content.
          nest.fell(sid, sid);
          if (session.claudeSessionPath && session.claudeSessionId) {
            try {
              createClaudeSession(session.cwd, session.claudeSessionId);
              trace("compaction.jsonl.truncated", { sid, path: session.claudeSessionPath });
            } catch (e) {
              trace("compaction.truncate.failed", { sid, err: String(e) });
            }
          }
          session.lastSyncedPetal = null;
          session.needsRespawn = true;
          saveSessions(sid);
        } else if (msg.reason === "swallow") {
          // Drone swallow: kill process — plugin re-sends prompt, daemon re-seeds via graft
          nest.fell(sid, sid);
          session.needsRespawn = true;
          session.lastSyncedPetal = null;
          saveSessions(sid);
          hum(sid, { chi: "drone-retrofit", sid, reason: msg.reason });
        } else {
          // User interrupt: send control_cancel_request — process stays alive
          nest.interrupt(sid);
        }
      }
      break;
    }

    case "release-permit": {
      const askId = msg.askId as string;
      const decision = msg.decision as "allow" | "deny";
      const hold = CLWND_PERMIT_HOLD.get(askId);
      trace("hum.permit.releasing", { askId, decision, holdExists: !!hold, pendingHolds: CLWND_PERMIT_HOLD.size });
      if (hold) {
        CLWND_PERMIT_HOLD.delete(askId);
        hold.resolve(decision);
        trace("hum.permit.released", { askId, decision });
        // Drone observes permission resolution — find the session
        const permitSid = hold.sessionId;
        if (permitSid) drone.observed(sigil(permitSid), { type: "permission_resolved" });
      }
      break;
    }

    case "cleanup": {
      const sid = msg.sid as string;
      const session = sessions.get(sid);
      if (session) {
        nest.fell(sid, sid);
        releaseDroneSession(sigil(sid));
        clearExternalTools(sid);
        clearMcpServerConfigs(sid);
        clearVisibleTools(sid);
        sessions.delete(sid);
        saveSessions(sid);
        trace("hum.session.cleaned", { sid });
      }
      break;
    }

    // "seeded" handler removed — daemon owns seeding via graft()

    case "log": {
      const level = msg.level as string;
      const event = msg.event as string;
      const data = msg.data as Record<string, unknown> | undefined;
      if (level === "info") info(event, data);
      else trace(event, data);
      break;
    }

    case "petal-cell": {
      // The sentinel's ears — track all OC session activity across all providers
      const sid = msg.sid as string;
      const role = msg.role as string;
      const model = msg.model as string;
      const provider = msg.provider as string;
      const messageId = msg.messageId as string | undefined;
      const parentId = msg.parentId as string | undefined;
      const completed = msg.completed as number | undefined;
      trace("petal.cell", { sid, role, provider, messageId, completed: !!completed });
      let session = sessions.get(sid);
      if (!session) {
        session = {
          opencodeSessionId: sid,
          claudeSessionId: null,
          claudeSessionPath: null,
          cwd: process.env.HOME ?? "/",
          modelId: model ?? "sonnet",
        };
        sessions.set(sid, session);
      }
      session.lastAccessed = Date.now();
      // Advance anchor on completed clwnd assistant petals —
      // completed means Claude finished writing to the JSONL, read the last uuid
      if (role === "assistant" && completed && provider?.startsWith("opencode-clwnd") && session.claudeSessionPath) {
        const tip = lastUuid(session.claudeSessionPath);
        if (tip) {
          session.lastSyncedPetal = tip;
          saveSessions(sid);
        }
      }
      break;
    }

    case "drone":
      // Plugin drone beat — handled by drone.heard() above
      break;

    default:
      trace("hum.msg.unknown", { chi });
  }
}

import { createServer, type Socket } from "net";

const humServer = createServer((socket: Socket) => {
  const clientId = randomUUID();
  const client: Reach = { clientId, sigils: new Set(), socket };
  humClients.set(clientId, client);
  info("hum.connected", { clientId: clientId.slice(0, 8), total: humClients.size });

  // Breath: send full state on connect
  humBreath(client);

  let buf = "";
  socket.on("data", (data) => {
    buf += data.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try {
        humHear(clientId, JSON.parse(line));
      } catch (e) {
        trace("hum.parse.failed", { err: String(e) });
      }
    }
  });

  socket.on("close", () => {
    humClients.delete(clientId);
    info("hum.disconnected", { clientId: clientId.slice(0, 8), total: humClients.size });
  });

  socket.on("error", (err) => {
    trace("hum.socket.failed", { err: String(err) });
  });
});

humServer.listen(HUM, () => {
  info("hum.listening", { path: HUM });
});

Bun.serve({
  unix: HTTP,
  fetch(req) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/status") {
      // Drone state — the post-mortem you never need
      const droneStates: Record<string, unknown> = {};
      for (const [s, state] of drone.inspect()) {
        // Only show active drone states
        if (state.localWane === 0 && state.remoteWane === 0 && state.missedBeats === 0) continue;
        droneStates[s] = {
          assessment: state.assessment,
          rhythm: state.rhythm,
          localWane: state.localWane,
          remoteWane: state.remoteWane,
          missedBeats: state.missedBeats,
          pendingEchoes: state.pendingEchoes.size,
          inflightTools: state.inflightTools,
          pendingPermissions: state.pendingPermissions,
          suspicious: state.suspicious,
        };
      }
      return Response.json({
        pid: process.pid,
        procs: nest.survey(),
        sessions: sessions.size,
        drone: droneStates,
      });
    }

    // /savings — penny-pincher counters (lifetime, persisted across restarts)
    if (req.method === "GET" && url.pathname === "/savings") {
      const sessionCtx: Array<{ sid: string; maxContextTokens: number }> = [];
      for (const [sid, sess] of sessions) {
        if (sess.maxContextTokens && sess.maxContextTokens > 0) {
          sessionCtx.push({ sid, maxContextTokens: sess.maxContextTokens });
        }
      }
      sessionCtx.sort((a, b) => b.maxContextTokens - a.maxContextTokens);
      // Snapshot disk on every query so `clwnd savings` always reflects the
      // freshest counters even between the 60s periodic writes.
      pennySave(PENNY_FILE);
      return Response.json({
        uptimeMs: Date.now() - penny.started,
        counters: penny,
        contextWarnThreshold: CONTEXT_WARN_THRESHOLD,
        topContextSessions: sessionCtx.slice(0, 10),
      });
    }

    // /savings/reset — zero the counters (and persist)
    if (req.method === "POST" && url.pathname === "/savings/reset") {
      pennyReset();
      pennySave(PENNY_FILE);
      return Response.json({ ok: true, resetAt: penny.started });
    }

    if (req.method === "GET" && url.pathname === "/sessions") {
      const out: Record<string, unknown> = {};
      for (const [sid, s] of sessions) out[sid] = s;
      return Response.json(out);
    }

    // Cleanup — tests use this to tear down sessions
    if (req.method === "POST" && url.pathname === "/") {
      return req.json().then((raw: unknown) => {
        const body = raw as { action: string; opencodeSessionId: string };
        if (body.action === "cleanup") {
          const session = sessions.get(body.opencodeSessionId);
          if (session) {
            nest.fell(body.opencodeSessionId, body.opencodeSessionId);
            releaseDroneSession(sigil(body.opencodeSessionId));
            sessions.delete(body.opencodeSessionId);
            saveSessions(body.opencodeSessionId);
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

import { handleMcpRequest, setCwd as mcpSetCwd, setPermissions as mcpSetPerms, setAllowedTools as mcpSetAllowed, setPermissionCallback, setMetaCallback, setExternalTools, clearExternalTools, setMcpServerConfigs, clearMcpServerConfigs, setVisibleTools, clearVisibleTools, type ExternalToolDef } from "../mcp/tools.ts";

// Fixed port so the plugin (and anything else local) can reach the MCP
// HTTP endpoint without discovery. Override with CLWND_MCP_PORT if the
// default clashes with something on your machine. 29147 is in the IANA
// user range, not commonly assigned.
const MCP_PORT = parseInt(process.env.CLWND_MCP_PORT ?? "29147") || 29147;

const MCP_HOST = process.env.CLWND_HOST ?? "127.0.0.1";

const mcpServer = Bun.serve({
  port: MCP_PORT,
  hostname: MCP_HOST,
  async fetch(req) {
    const url = new URL(req.url);

    // PreToolUse hook calls this to check permissions
    if (req.method === "POST" && url.pathname === "/permission-check") {
      try {
        const body = await req.json() as { tool_name?: string; tool_input?: Record<string, unknown>; session_id?: string };
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

        hum(ocSessionId ?? sessionId, { chi: "permission-ask", askId, tool: toolName, path, input: body.tool_input ?? {}, dusk: Date.now() + cfg.permissionDusk });

        // Hold until /permission-respond resolves this, or timeout
        const decision = await new Promise<"allow" | "deny">((resolve) => {
          CLWND_PERMIT_HOLD.set(askId, { resolve, tool: toolName, path, sessionId: ocSessionId ?? sessionId });
          setTimeout(() => {
            if (CLWND_PERMIT_HOLD.has(askId)) {
              CLWND_PERMIT_HOLD.delete(askId);
              trace("permission.hold.timeout", { id: askId });
              resolve("deny");
            }
          }, cfg.permissionDusk);
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

    // MCP JSON-RPC — extract session ID from /s/{poolKey} path
    if (req.method !== "POST") return new Response("clwnd-mcp", { status: 200 });
    const mcpSessionId = url.pathname.match(/^\/s\/([^/]+)/)?.[1] ?? undefined;
    try {
      const body = await req.json() as { jsonrpc: string; id?: number | string; method: string; params?: unknown };
      trace("mcp.request.received", { method: body.method, sid: mcpSessionId });
      const result = await handleMcpRequest(body, mcpSessionId);
      if (!result) return new Response("", { status: 204 });
      return Response.json(result);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      trace("mcp.request.failed", { err: msg });
      return Response.json({ jsonrpc: "2.0", error: { code: -32700, message: msg } });
    }
  },
});

const MCP_URL = `http://${MCP_HOST}:${mcpServer.port}`;
mcpSetCwd(process.env.CLWND_CWD ?? process.env.HOME ?? "/");

// Wire permission prompt MCP tool to daemon's permission logic
setPermissionCallback(async (toolName: string, input: Record<string, unknown>, sessionId?: string) => {
  const tool = toolName.replace("mcp__clwnd__", "");
  const path = (input?.file_path ?? input?.path ?? input?.pattern) as string | undefined;
  const action = getPermissionAction(tool, path);
  trace("permission.mcp.checked", { tool, path, action, sessionId });

  if (action === "allow") return { decision: "allow" as const };
  if (action === "deny") return { decision: "deny" as const };

  // "ask" — hold MCP response, send permission_ask via the hum
  // so the provider can emit a clwnd_permission tool call to trigger OC's ctx.ask() dialog
  const askId = randomUUID();
  trace("permission.ask.hold", { id: askId, tool, path, sessionId });

  // Route to the session's hum client — sessionId comes from MCP URL path
  hum(sessionId ?? "", { chi: "permission-ask", askId, tool, path, input, dusk: Date.now() + cfg.permissionDusk });

  return new Promise<{ decision: "allow" | "deny" }>((resolve) => {
    CLWND_PERMIT_HOLD.set(askId, {
      resolve: (decision) => resolve({ decision }),
      tool, path, sessionId: sessionId ?? "",
    });

    // Auto-allow after 5s. The MCP permission_prompt blocks Claude CLI's stream,
    // creating a deadlock: provider can't emit clwnd_permission tool-call until
    // the stream flows, but the stream can't flow until MCP returns.
    // The timeout breaks the deadlock. 5s is enough for release-permit to arrive
    // if OC's ctx.ask() resolves quickly (which it does when agent auto-allows).
    setTimeout(() => {
      if (CLWND_PERMIT_HOLD.has(askId)) {
        CLWND_PERMIT_HOLD.delete(askId);
        trace("permission.hold.timeout.allow", { id: askId });
        resolve({ decision: "allow" });
      }
    }, 5_000);
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
  for (const client of humClients.values()) {
    humTo(client, { chi: "tool-meta", tool: toolName, callId, title, metadata });
  }
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

info("ready", { http: HTTP, mcp: MCP_URL, pid: process.pid, version: CURRENT_VERSION, maxProcs: MAX_PROCS, idleTimeout: IDLE_TIMEOUT, droned: DRONED });

// ─── Session Reaper ─────────────────────────────────────────────────────────
// Remove stale sessions that haven't been accessed in a while.

const REAP_INTERVAL = 60_000; // check every 60s
const REAP_MAX_AGE = 60 * 60 * 1000; // 1 hour

function reapSessions(): void {
  const now = Date.now();
  let reaped = 0;
  for (const [sid, session] of sessions) {
    if (!session.lastAccessed) continue;
    const age = now - session.lastAccessed;
    if (age < REAP_MAX_AGE) continue;
    // Don't reap if a process is alive for this session
    if (nest.roost(sid)) continue;
    sessions.delete(sid);
    reaped++;
  }
  if (reaped > 0) {
    saveSessions();
    trace("session.reaped", { count: reaped, remaining: sessions.size });
  }
}

setInterval(reapSessions, REAP_INTERVAL);
// Reap on startup too — clean up sessions from before daemon restart
reapSessions();

