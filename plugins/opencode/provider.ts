/**
 * clwnd provider — LanguageModelV3 for OpenCode.
 *
 * Receives Claude CLI stream events from the daemon via hum,
 * emits v3 stream parts to OC's processor. Clean pipe — daemon
 * owns seeding, cupping, and drone evaluation.
 */

import { appendFileSync, mkdirSync } from "fs";
import { connect as netConnect, type Socket as NetSocket } from "net";
import { loadConfig, type ClwndConfig as CfgShape } from "../../lib/config.ts";
import { sigil as makeSigil, Drone, duskIn, type DroneAction } from "../../lib/hum.ts";

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3GenerateResult,
  LanguageModelV3FinishReason,
  LanguageModelV3Usage,
  LanguageModelV3Prompt,
} from "@ai-sdk/provider";

// ─── Config ──────────────────────────────────────────────────────────────

export interface ClwndConfig {
  cwd?: string;
  client?: any;
  pluginInput?: any;
}

// ─── Logging ─────────────────────────────────────────────────────────────

const LOG_DIR = `${process.env.XDG_STATE_HOME || process.env.HOME + "/.local/state"}/clwnd`;
const LOG_FILE = `${LOG_DIR}/plugin.log`;
try { mkdirSync(LOG_DIR, { recursive: true }); } catch {}

function writeLog(level: string, event: string, data?: Record<string, unknown>): void {
  const parts = [new Date().toISOString(), `[${level}]`, event];
  if (data) for (const [k, v] of Object.entries(data)) parts.push(`${k}=${v}`);
  try { appendFileSync(LOG_FILE, parts.join(" ") + "\n"); } catch {}
}

let logClient: any = null;
export function setLogClient(client: any): void { logClient = client; }

export function trace(event: string, data?: Record<string, unknown>): void {
  writeLog("trace", event, data);
  if (logClient?.app?.log) {
    logClient.app.log({
      body: { service: "clwnd", level: "debug" as const, message: event, extra: data },
    }).catch(() => {});
  }
  hum({ chi: "log", level: "trace", event, data });
}

export function log(event: string, data?: Record<string, unknown>): void {
  writeLog("info", event, data);
  if (logClient?.app?.log) {
    logClient.app.log({
      body: { service: "clwnd", level: "info" as const, message: event, extra: data },
    }).catch(() => {});
  }
  hum({ chi: "log", level: "info", event, data });
}

// ─── Tool Mapping (Claude CLI MCP → OpenCode native) ────────────────────

const MCP_PREFIX = "mcp__clwnd__";

const TOOL_NAME_MAP: Record<string, string> = {
  WebFetch: "webfetch", WebSearch: "websearch",
  TodoWrite: "todowrite", AskUserQuestion: "question",
  Task: "task", Skill: "skill",
};

function mapToolName(name: string): string {
  if (name.startsWith(MCP_PREFIX)) return name.slice(MCP_PREFIX.length);
  return TOOL_NAME_MAP[name] ?? name;
}

const BROKERED_TOOLS = new Set(["todowrite"]);

// Tools handled natively by clwnd — anything NOT in this set from opts.tools
// is treated as an external MCP tool and forwarded to Claude CLI for dispatch.
// do_code/do_noncode replace edit+write; read absorbs glob+grep via modifiers.
//
// REPLACED legacy tools are INCLUDED in this set so they're silently dropped
// from opts.tools by the external-tool filter — Claude CLI never even learns
// they exist. Without this, OC's built-in edit/write/glob/grep tool defs get
// forwarded as "external" MCP tools, Claude sees them, calls them, and
// clwnd's dispatcher bounces them as unknown. The agent wastes round-trips
// discovering what's gone.
const KNOWN_TOOLS = new Set([
  // clwnd native surface
  "read", "do_code", "do_noncode", "bash",
  // Brokered through provider (OC executes, result relayed)
  "webfetch", "websearch", "todowrite",
  // OC's own tools
  "task", "skill", "todoread", "taskoutput", "taskstop", "question",
  // clwnd internal
  "clwnd_permission", "permission_prompt",
  // ALL Claude CLI built-in tools — blocked via --disallowedTools in the
  // daemon spawn. Listed here so OC doesn't forward them as "external
  // MCP tools" when it sees them in its own registry.
  "cronCreate", "cronDelete", "cronList", "monitor", "remoteTrigger", "scheduleWakeup",
  "taskCreate", "taskGet", "taskList", "taskUpdate",
  "notebookedit", "codesearch", "applypatch", "ls",
  "agent", "explore", "sendMessage",
  "enterPlanMode", "exitPlanMode", "enterWorktree", "exitWorktree",
  "askUserQuestion",
  // Replaced-and-banned. Do not forward. Do not re-enable.
  "edit", "write", "multiedit", "glob", "grep",
]);

// Map OC's snake_case schema fields to the camelCase Claude CLI expects.
// New surface only: read (absorbs glob+grep via modifiers), do_code, do_noncode.
const INPUT_FIELD_MAP: Record<string, Record<string, string>> = {
  read:       { file_path: "filePath" },
  do_code:    { file_path: "filePath", new_source: "newSource" },
  do_noncode: { file_path: "filePath" },
  bash:       {},
};

function mapToolInput(toolName: string, input: string): string {
  const ocName = mapToolName(toolName);
  if (ocName === "todowrite") {
    try {
      const parsed = JSON.parse(input);
      if (parsed.todos && Array.isArray(parsed.todos)) {
        parsed.todos = parsed.todos.map((t: Record<string, unknown>) => ({
          content: t.content ?? "",
          status: t.status ?? "pending",
          priority: t.priority ?? "medium",
        }));
      }
      return JSON.stringify(parsed);
    } catch { return input; }
  }
  const fieldMap = INPUT_FIELD_MAP[ocName];
  if (!fieldMap || Object.keys(fieldMap).length === 0) return input;
  try {
    const parsed = JSON.parse(input);
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      mapped[fieldMap[k] ?? k] = v;
    }
    return JSON.stringify(mapped);
  } catch {
    return input;
  }
}

function parseToolResult(resultText: string): { output: string; title: string; metadata: Record<string, unknown> } {
  const metaMatch = resultText.match(/<!--clwnd-meta:(.*?)-->/s);
  let title = "";
  let metadata: Record<string, unknown> = {};
  let output = resultText;
  if (metaMatch) {
    output = resultText.replace(/\n?<!--clwnd-meta:.*?-->/s, "").trim();
    try {
      const parsed = JSON.parse(metaMatch[1]);
      title = parsed.title ?? "";
      metadata = parsed.metadata ?? {};
    } catch {}
  }
  return { output, title, metadata };
}

// ─── Hum: Bidirectional NDJSON socket ────────────────────────────────────

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/clwnd/clwnd.sock`;
  return "/tmp/clwnd/clwnd.sock";
}

const HUM_PATH = (process.env.CLWND_SOCKET ?? defaultSocketPath()) + ".hum";

type HumListener = (msg: Record<string, unknown>) => void;

let humSocket: NetSocket | null = null;
let humEcho = "";
// Per-session listeners. Keyed by sid so concurrent doStream calls (build +
// compaction + title + summarize, often from different sessions) don't clobber
// each other's finish handlers. Earlier versions had a single global humHearer
// which was overwritten by every new doStream, causing finishes to be
// delivered to the wrong stream — manifesting as hung turns and scrambled
// session state. See the compaction hang incident.
const humHearers = new Map<string, HumListener>();
let humAlive = false;
let humReady: { resolve: () => void } | null = null;
let humAwaken: Promise<void> = awakenHum();
const HUM_TIMEOUT = 5000;

async function awaitHum(): Promise<void> {
  if (humAlive) return;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("hum not connected within 5s")), HUM_TIMEOUT));
  await Promise.race([humAwaken, timeout]);
}

const DRONED = loadConfig().droned;
const pluginDrone = DRONED ? new Drone("plugin", (action: DroneAction) => {
  switch (action.type) {
    case "beat":
      if (humSocket && humAlive) {
        try { humSocket.write(JSON.stringify(action.beat) + "\n"); } catch {}
      }
      break;
    case "retry": trace("drone.retry", { rid: action.rid, chi: action.chi }); break;
    case "lost": trace("drone.lost", { rid: action.rid, chi: action.chi }); break;
    case "drift": trace("drone.drift", { local: action.local, remote: action.remote }); break;
    case "dead": trace("drone.dead", { missedBeats: action.missedBeats }); break;
    case "swallow": trace("drone.swallow", { reason: action.reason }); break;
  }
}) : { sent() {}, heard() {}, observed() {}, setWane() {}, inspect() { return new Map(); }, stop() {} } as unknown as Drone;

async function awakenHum(): Promise<void> {
  try {
    humSocket = netConnect({ path: HUM_PATH });
    humSocket.on("connect", () => {
      humAlive = true;
      if (humReady) { humReady.resolve(); humReady = null; }
      trace("hum.connected");
    });
    humSocket.on("data", (data) => {
      humEcho += data.toString();
      const lines = humEcho.split("\n");
      humEcho = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          pluginDrone.heard(msg);
          if (msg.chi === "echo") { trace("hum.echo", { rid: msg.rid, ok: msg.ok }); continue; }
          if (msg.chi === "breath") {
            const sessions = (msg.sessions ?? []) as Array<{ sid: string; sigil: string; wane: number }>;
            trace("hum.breath.received", { sessions: sessions.length, synced: sessions.length });
            continue;
          }
          if (msg.chi === "pulse") { trace("hum.pulse", { kind: msg.kind, sid: msg.sid }); continue; }
          // Dispatch stream events to the per-session listener. Every clwnd
          // hum event that belongs to a stream carries sid — pulses, breaths
          // and echoes (handled above) do not, and they reach all sessions by
          // design. Missing sid means the message is not stream-bound; drop.
          const msgSid = typeof msg.sid === "string" ? msg.sid : undefined;
          if (msgSid) {
            const h = humHearers.get(msgSid);
            if (h) h(msg);
          }
        } catch {}
      }
    });
    humSocket.on("close", () => {
      humAlive = false;
      humSocket = null;
      trace("hum.disconnected");
      humAwaken = new Promise<void>(r => { humReady = { resolve: r }; });
      setTimeout(awakenHum, 2000);
    });
    humSocket.on("error", (err) => {
      trace("hum.error", { err: String(err) });
    });
  } catch (e) {
    trace("hum.connect.failed", { err: String(e) });
    setTimeout(awakenHum, 2000);
  }
}

let ridCounter = 0;
function makeRid(): string {
  return `p-${Date.now().toString(36)}-${(ridCounter++).toString(36)}`;
}

export function hum(msg: Record<string, unknown>): void {
  if (!humSocket || !humAlive) {
    writeLog("trace", "hum.send.skipped", { chi: msg.chi as string, alive: humAlive, socket: !!humSocket });
    return;
  }
  if (msg.chi !== "log" && !msg.rid) msg.rid = makeRid();
  msg.from = "plugin";
  try {
    const data = JSON.stringify(msg) + "\n";
    writeLog("trace", "hum.send", { chi: msg.chi as string, rid: msg.rid as string, len: data.length });
    humSocket.write(data);
    pluginDrone.sent(msg);
  } catch (e) {
    writeLog("trace", "hum.send.failed", { err: String(e) });
  }
}

function humHear(sid: string, onMessage: HumListener): Promise<void> {
  return new Promise<void>((resolve) => {
    humHearers.set(sid, (incoming) => {
      onMessage(incoming);
      if (incoming.chi === "finish" || incoming.chi === "error") {
        humHearers.delete(sid);
        resolve();
      }
    });
  });
}

// ─── Prompt Helpers ──────────────────────────────────────────────────────

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function extractContent(prompt: LanguageModelV3Prompt, sessionId?: string): ContentPart[] {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return [{ type: "text", text: m.content }];
      if (Array.isArray(m.content)) {
        const parts: ContentPart[] = [];
        for (const p of m.content) {
          if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
          if (p.type === "file" && (p.mediaType ?? "").startsWith("image/")) {
            let b64: string | undefined;
            const raw = p.data;
            if (raw instanceof Uint8Array) {
              b64 = Buffer.from(raw).toString("base64");
            } else if (typeof raw === "string") {
              const match = raw.match(/^data:[^;]+;base64,(.+)/);
              b64 = match ? match[1] : raw;
            } else if (raw instanceof URL) {
              const match = raw.toString().match(/^data:[^;]+;base64,(.+)/);
              b64 = match ? match[1] : undefined;
            }
            if (b64) {
              parts.push({ type: "image", source: { type: "base64", media_type: p.mediaType ?? "image/png", data: b64 } });
            }
          }
        }
        if (parts.length === 0) continue;
        // Strip repeated system reminders. Normalize whitespace before
        // comparison so near-duplicates (whitespace drift, trailing newlines
        // from different OC code paths) also dedup — saves every repeated
        // reminder that differs only in formatting.
        if (sessionId) {
          const norm = (s: string) => s.replace(/\s+/g, " ").trim();
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j].type !== "text") continue;
            const reminder = (parts[j] as { text: string }).text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
            if (reminder) {
              const key = norm(reminder);
              const prev = lastReminder.get(sessionId);
              if (prev === key) {
                const stripped = (parts[j] as { type: "text"; text: string }).text.replace(reminder, "").trim();
                if (stripped) { parts[j] = { type: "text", text: stripped }; }
                else { parts.splice(j, 1); }
                pendingPenny.reminderStripped++;
                trace("reminder.stripped", { sid: sessionId });
              } else {
                lastReminder.set(sessionId, key);
              }
            }
          }
        }
        return parts.length > 0 ? parts : [{ type: "text", text: "" }];
      }
    }
  }
  return [{ type: "text", text: "" }];
}

const lastReminder = new Map<string, string>();

function extractSystemPrompt(prompt: LanguageModelV3Prompt): string {
  const parts: string[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      if (typeof m.content === "string") parts.push(m.content);
    }
  }
  return parts.join("\n\n");
}

// Sanitize a system prompt before forwarding to Claude:
//   1. Strip XML-like enclosures only — `<tag>` and `</tag>` wrappers are
//      removed, but the content between them is preserved. The tags add noise
//      (and may trigger the CLI's <system-reminder>-aware handling) while the
//      prose inside is usually meaningful.
//   2. Drop every unit mentioning `word` (case-insensitive) from what remains.
// A "unit" is either an atomic block (header, list item with its indented
// continuations) or a prose sentence (within a prose block, split on sentence-
// terminator + whitespace). This hybrid keeps bullets with their URL continua-
// tions as one unit (so stripping leaves no dangling "at"), while still split-
// ting multi-sentence paragraphs finely enough that one bad sentence doesn't
// drag the whole paragraph down.
function sanitizePrompt(text: string, word: string): string {
  if (!text) return text;

  // Pass 1: strip enclosure markers. Matches opening, closing, and self-closing
  // tags; content in between is left intact. Requires a word-char start so it
  // doesn't eat "2 < 3" style inequalities.
  text = text.replace(/<\/?\w[\w-]*\b[^>]*>/g, "");

  if (!word) {
    return text.replace(/^\n+/, "");
  }

  const needle = new RegExp(word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

  // Split into lines, preserving each line's trailing \n.
  const lines: string[] = [];
  {
    let cursor = 0;
    while (cursor < text.length) {
      const nl = text.indexOf("\n", cursor);
      if (nl === -1) { lines.push(text.slice(cursor)); break; }
      lines.push(text.slice(cursor, nl + 1));
      cursor = nl + 1;
    }
  }

  type Kind = "blank" | "header" | "list" | "prose";
  const kindOf = (line: string): Kind => {
    const body = line.replace(/\n$/, "");
    if (!body.trim()) return "blank";
    if (/^\s*#/.test(body)) return "header";
    if (/^\s*(?:[-*]|\d+\.)\s/.test(body)) return "list";
    return "prose";
  };
  // Indented non-list line → belongs to the preceding atomic block
  const isContinuation = (line: string): boolean => {
    const body = line.replace(/\n$/, "");
    if (!body.trim()) return false;
    return /^\s/.test(body) && !/^\s*(?:[-*]|\d+\.)\s/.test(body);
  };

  const units: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const k = kindOf(lines[i]);

    if (k === "blank" || k === "header") {
      units.push(lines[i]);
      i++;
      continue;
    }

    if (k === "list") {
      let unit = lines[i];
      i++;
      while (i < lines.length && isContinuation(lines[i])) {
        unit += lines[i];
        i++;
      }
      units.push(unit);
      continue;
    }

    // Prose: collect consecutive prose lines into one block, then split into
    // sentences. Sentence terminator = .!? followed by space/tab/newline; the
    // delimiter is kept with the preceding sentence so the whole sentence —
    // trailing newline included — disappears when stripped, no orphan blanks.
    let block = lines[i];
    i++;
    while (i < lines.length && kindOf(lines[i]) === "prose") {
      block += lines[i];
      i++;
    }

    // Boundary: .!? + whitespace, OR bare \n. The bare-\n fallback rescues
    // terminator-less lines (file paths, <env> blocks) — each becomes its own
    // unit instead of bundling into one giant tail that trips on a single
    // opencode mention anywhere in the block.
    const sentRe = /[.!?][ \t\n]+|\n/g;
    let start = 0;
    let m: RegExpExecArray | null;
    while ((m = sentRe.exec(block)) !== null) {
      const end = m.index + m[0].length;
      units.push(block.slice(start, end));
      start = end;
    }
    if (start < block.length) units.push(block.slice(start));
  }

  // Strip leading blank units — if the first few kept units are just newlines
  // (often the \n\n separator left behind when the first system message was
  // fully removed), drop them so the prompt doesn't start with a blank line.
  const kept = units.filter(u => !needle.test(u));
  while (kept.length > 0 && !kept[0].trim()) kept.shift();
  return kept.join("");
}

// ─── Detection Helpers ───────────────────────────────────────────────────
//
// There is no longer a unified "auxiliary call" concept. OC has two
// distinct agent types we handle specially: `title` (skipped entirely —
// clwnd doesn't title-gen) and `compaction` (passes through to Claude CLI
// but tells the daemon to truncate the JSONL in place so the next turn
// starts from the summary). Everything else is a normal build/chat turn.
// An earlier revision swapped the model on empty-tools calls ("aux model
// routing") as a cost optimization. That swap pollutes the nest pool
// with the wrong model and silently downgrades the next real turn, so it
// was ripped. The user's selected model now passes through every turn.

function isBrokeredToolReturn(prompt: LanguageModelV3Prompt): boolean {
  if (prompt.length < 2) return false;
  const last = prompt[prompt.length - 1];
  if (last.role !== "tool" || !Array.isArray(last.content)) return false;
  for (const part of last.content) {
    if (part.type === "tool-result" && (
      (part.toolName && BROKERED_TOOLS.has(part.toolName)) ||
      part.toolName === "clwnd_permission" ||
      part.toolCallId?.startsWith("perm-")
    )) {
      return true;
    }
  }
  return false;
}


// ─── Agent + Session Helpers ─────────────────────────────────────────────

const sessionLastAgent = new Map<string, string>();
const sessionPetalCounts = new Map<string, number>();
// Set true in the compaction doStream, consumed + cleared in the next build
// doStream on the same session. Primary signal that OC just compacted;
// the petal-count drop is a fallback for anything that bypasses the marker.
const sessionJustCompacted = new Map<string, boolean>();

function detectAgent(sid: string, headers?: Record<string, string | undefined>): string | null {
  const raw = headers?.["x-clwnd-agent"] ?? null;
  if (!raw) return null;
  let agent = raw;
  try { const parsed = JSON.parse(raw); if (typeof parsed === "object" && parsed.name) agent = parsed.name; } catch {}
  const prev = sessionLastAgent.get(sid);
  if (prev && prev !== agent) trace("agent.changed", { sid, old: prev, new: agent });
  sessionLastAgent.set(sid, agent);
  trace("agent.current", { sid, agent });
  return agent;
}

async function getSessionDirectory(client: unknown, sessionId: string): Promise<string | null> {
  if (!client) return null;
  try {
    const resp = await (client as any).session.get({ path: { sessionID: sessionId } });
    return resp.data?.directory ?? null;
  } catch { return null; }
}

const agentPermissionCache = new Map<string, Array<{ permission: string; pattern: string; action: string }>>();

async function getSessionPermissions(client: unknown, sessionId: string): Promise<Array<{ permission: string; pattern: string; action: string }>> {
  if (!client) return [];
  const agentName = sessionLastAgent.get(sessionId) ?? "build";
  if (agentPermissionCache.has(agentName)) return agentPermissionCache.get(agentName)!;
  try {
    const resp = await (client as any).app.agents();
    const agents = resp.data ?? [];
    const agent = agents.find((a: { name: string }) => a.name === agentName);
    const perms = agent?.permission ?? [];
    agentPermissionCache.set(agentName, perms);
    trace("permissions.loaded", { agent: agentName, count: perms.length });
    return perms;
  } catch (e: unknown) {
    trace("permissions.error", { agent: agentName, err: e instanceof Error ? e.message : String(e) });
    return [];
  }
}

// Cache MCP configs — read once per OC lifecycle
let mcpConfigCache: Array<{ name: string; type: "local"; command: string[]; environment?: Record<string, string> }> | null = null;

async function getMcpServerConfigs(client: unknown): Promise<Array<{ name: string; type: "local"; command: string[]; environment?: Record<string, string> }>> {
  if (mcpConfigCache) return mcpConfigCache;
  if (!client) return [];
  try {
    const resp = await (client as any).config.get();
    const mcp = resp.data?.mcp as Record<string, { type?: string; command?: string[]; environment?: Record<string, string> }> | undefined;
    if (!mcp) return [];
    const configs: Array<{ name: string; type: "local"; command: string[]; environment?: Record<string, string> }> = [];
    for (const [name, cfg] of Object.entries(mcp)) {
      if (cfg.type === "local" && Array.isArray(cfg.command)) {
        configs.push({ name, type: "local", command: cfg.command, environment: cfg.environment });
      }
    }
    mcpConfigCache = configs;
    if (configs.length > 0) trace("mcp.configs.loaded", { servers: configs.map(c => c.name).join(",") });
    return configs;
  } catch { return []; }
}

const OC_TO_MCP: Record<string, string> = {
  read: "read",
  do_code: "do_code",
  do_noncode: "do_noncode",
  bash: "bash",
  webfetch: "webfetch",
};

const lastAllowedTools = new Map<string, string>();

// Per-session hash caches for hum payload dedup. On steady-state turns, the
// systemPrompt and permissions rarely change; re-shipping them every turn is
// pure IPC waste. Daemon-side falls back to its cached session values when
// these fields are absent from the hum message (see daemon.ts "prompt" case).
// Invalidated on compaction / cancel by clearSessionHashes(sid).
const lastSystemPromptHash = new Map<string, string>();
const lastPermissionsHash = new Map<string, string>();
const lastAllowedToolsHash = new Map<string, string>();

// Local plugin-side penny counters. Accumulate between hum sends, flush as
// `pennyDelta` piggyback on every prompt hum. Daemon merges into its global
// counters. Keeps the wire traffic to one field per turn instead of a separate
// hum tone per event.
const pendingPenny = {
  humDedup: 0,
  reminderStripped: 0,
  priorPetalsElided: 0,
};
function flushPenny(): Record<string, number> | undefined {
  if (pendingPenny.humDedup === 0 && pendingPenny.reminderStripped === 0
      && pendingPenny.priorPetalsElided === 0) {
    return undefined;
  }
  const snap = { ...pendingPenny };
  pendingPenny.humDedup = 0;
  pendingPenny.reminderStripped = 0;
  pendingPenny.priorPetalsElided = 0;
  return snap;
}

function cheapHash(s: string): string {
  // Non-cryptographic, fast, sufficient for same-content detection.
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h.toString(36) + ":" + s.length;
}

export function clearSessionHashes(sid: string): void {
  lastSystemPromptHash.delete(sid);
  lastPermissionsHash.delete(sid);
  lastAllowedToolsHash.delete(sid);
  lastAllowedTools.delete(sid);
}

export function clearSessionState(sid: string): void {
  clearSessionHashes(sid);
  sessionLastAgent.delete(sid);
  sessionPetalCounts.delete(sid);
  sessionJustCompacted.delete(sid);
  lastReminder.delete(sid);
}

const AGENT_DENY: Record<string, Set<string>> = {
  plan: new Set(["do_code", "do_noncode"]),
};

function deriveAllowedTools(sid: string, opts: LanguageModelV3CallOptions): string[] {
  const agent = opts.headers?.["x-clwnd-agent"] ?? "";
  let agentName = agent;
  try { const p = JSON.parse(agent); if (p?.name) agentName = p.name; } catch {}
  const denied = AGENT_DENY[agentName] ?? new Set();
  const all = ["read", "do_code", "do_noncode", "bash", "webfetch"];
  const result = all.filter(t => !denied.has(t));
  const key = result.join(",");
  const prev = lastAllowedTools.get(sid);
  if (prev !== key) {
    trace("allowedTools.changed", { sid, agent: agentName, old: prev ?? "none", new: key });
    lastAllowedTools.set(sid, key);
  }
  return result;
}

// ─── Finish Reason Mapping ───────────────────────────────────────────────

function mapFinishReason(raw: string | undefined): LanguageModelV3FinishReason {
  const r = raw ?? "stop";
  const unified: LanguageModelV3FinishReason["unified"] =
    r === "end_turn" ? "stop"
    : r === "max_tokens" ? "length"
    : r === "stop_sequence" ? "stop"
    : r === "tool_use" ? "tool-calls"
    : r === "tool-calls" ? "tool-calls"
    : r === "content_filter" ? "content-filter"
    : r === "stop" ? "stop"
    : r === "length" ? "length"
    : r === "error" ? "error"
    : "other";
  return { unified, raw: r };
}

function zeroUsage(): LanguageModelV3Usage {
  return {
    inputTokens: { total: 0, noCache: 0, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 0, text: 0, reasoning: 0 },
  };
}

// ─── ClwndModel ──────────────────────────────────────────────────────────

export class ClwndModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly modelId: string;
  readonly provider = "clwnd";
  readonly supportedUrls: Record<string, RegExp[]> = { "image/*": [] };

  constructor(
    modelId: string,
    private config: ClwndConfig = {},
  ) {
    this.modelId = modelId;
  }

  async doGenerate(opts: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    // Title agent is the only OC call we short-circuit — clwnd doesn't waste
    // tokens generating session titles. Every other call (including OC's
    // compaction agent) delegates to doStream and runs with the user's
    // selected model.
    const rawAgent = opts.headers?.["x-clwnd-agent"] ?? "";
    let agentName = rawAgent;
    try { const p = JSON.parse(rawAgent); if (p?.name) agentName = p.name; } catch {}
    if (agentName === "title") {
      return {
        content: [{ type: "text", text: "" }],
        usage: zeroUsage(),
        finishReason: { unified: "stop", raw: "stop" },
        warnings: [],
      };
    }
    // Delegate to stream and collect
    const { stream } = await this.doStream(opts);
    const reader = stream.getReader();
    const content: Array<{ type: "text"; text: string }> = [];
    let finishReason: LanguageModelV3FinishReason = { unified: "stop", raw: "stop" };
    let usage: LanguageModelV3Usage = zeroUsage();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.type === "text-delta") {
        // Accumulate text deltas for doGenerate
        const last = content[content.length - 1];
        if (last) last.text += value.delta;
        else content.push({ type: "text", text: value.delta });
      }
      if (value.type === "finish") {
        finishReason = value.finishReason;
        usage = value.usage;
      }
    }
    return { content, usage, finishReason, warnings: [] };
  }

  async doStream(opts: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const sid = opts.headers?.["x-opencode-session"] ?? makeSigil(Date.now().toString());
    const lastRole = opts.prompt.length > 0 ? opts.prompt[opts.prompt.length - 1].role : "none";
    trace("doStream.enter", { sid, promptLen: opts.prompt.length, lastRole });
    const content = extractContent(opts.prompt, sid);
    const text = content.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join("\n\n");
    const systemPrompt = sanitizePrompt(extractSystemPrompt(opts.prompt), "opencode");
    detectAgent(sid, opts.headers);
    const cwd = (this.config.client ? await getSessionDirectory(this.config.client, sid) : null) ?? this.config.cwd ?? process.cwd();
    const self = this;
    const sap = new Map<string, string>();
    const permissions = await getSessionPermissions(this.config.client, sid);
    const allowedTools = deriveAllowedTools(sid, opts);

    // Detect each OC built-in agent independently. NEVER unify these under
    // a generic "auxiliary" bucket — past revisions did that (via an
    // isEmptyTools heuristic) and it caused a silent model downgrade because
    // the nest pool cached the wrong model. OC defines agents explicitly;
    // treat each one explicitly.
    //
    //   title       — skipped entirely. clwnd does not generate titles.
    //   compaction  — passes through to Claude CLI with the user's selected
    //                 model (NO model swap). We just skip graft because OC
    //                 already owns the compacted history state and there is
    //                 nothing for the daemon to reconcile.
    //   build/chat  — normal flow, full graft.
    //
    // If OC adds more built-in agents in the future, add a new branch.
    // Do not introduce a generic fallback that treats them alike.
    const rawAgent = opts.headers?.["x-clwnd-agent"] ?? "";
    let agentName = rawAgent;
    try { const p = JSON.parse(rawAgent); if (p?.name) agentName = p.name; } catch {}
    const isTitleGen = agentName === "title";
    const isCompaction = agentName === "compaction";

    // Skip title generation entirely - return empty, don't pass to Claude
    if (isTitleGen) {
      trace("title.skip", { method: "doStream", sid });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: zeroUsage() });
            controller.close();
          },
        }),
      };
    }

    // Compaction is an OC-owned flow — OC has already decided the history
    // should be replaced with a summary, so we don't need to graft the old
    // turns into the JSONL. We still forward the request to Claude CLI so
    // the summary is generated on the user's actual model.
    const skipGraft = isCompaction;
    if (skipGraft) trace("graft.skip", { method: "doStream", sid, reason: "compaction" });

    // Hash-dedup of per-turn hygiene fields. systemPrompt / permissions /
    // allowedTools rarely change during a session — the daemon falls back to
    // its cached session values when these fields are omitted, so dedup'd
    // turns just skip the re-serialization and hum-socket transmission.
    const systemPromptHash = cheapHash(systemPrompt);
    const permissionsHash = cheapHash(JSON.stringify(permissions));
    const allowedToolsHash = cheapHash(allowedTools.join(","));
    const sendSystemPrompt = lastSystemPromptHash.get(sid) !== systemPromptHash;
    const sendPermissions = lastPermissionsHash.get(sid) !== permissionsHash;
    const sendAllowedTools = lastAllowedToolsHash.get(sid) !== allowedToolsHash;
    if (sendSystemPrompt) lastSystemPromptHash.set(sid, systemPromptHash);
    if (sendPermissions) lastPermissionsHash.set(sid, permissionsHash);
    if (sendAllowedTools) lastAllowedToolsHash.set(sid, allowedToolsHash);
    if (!sendSystemPrompt || !sendPermissions || !sendAllowedTools) pendingPenny.humDedup++;
    trace("hum.dedup", { sid, sp: sendSystemPrompt, perm: sendPermissions, tools: sendAllowedTools });

    // Brokered tool return — permission returns must listen for Claude's remaining output
    let permAskId: string | null = null;
    const isPermReturn = isBrokeredToolReturn(opts.prompt) && (() => {
      const lt = opts.prompt.findLast(m => m.role === "tool");
      if (!lt || !Array.isArray(lt.content)) return false;
      for (const p of lt.content) {
        if (p.type === "tool-result" && p.toolCallId?.startsWith("perm-")) {
          // V3 tool-result on the PROMPT side uses `output: {type,value}` —
          // see LanguageModelV3ToolResultPart. We still probe `.result` as a
          // compat shim for older plugin/AI-SDK revisions where the field
          // name differed. Double-cast through `unknown` because V3 tightly
          // types the output shape and we're reading a pre-envelope blob.
          const loose = p as unknown as { output?: unknown; result?: unknown };
          const rawOutput = loose.output ?? loose.result;
          try {
            const outer = typeof rawOutput === "string" ? JSON.parse(rawOutput) : rawOutput;
            const inner = outer?.value ?? outer;
            const str = typeof inner === "string" ? inner : JSON.stringify(inner ?? "");
            const parsed = JSON.parse(str);
            if (parsed.askId) permAskId = parsed.askId;
          } catch {}

          return true;
        }
      }
      return false;
    })();
    if (isBrokeredToolReturn(opts.prompt) && !isPermReturn) {
      trace("brokered.return", { sid });
      // Emit a minimal text block before finish so OC creates a new
      // assistant message. Without this, OC's prompt loop sees
      // lastAssistantMsg as the PREVIOUS message (which has the brokered
      // tool call with providerExecuted=false), hasToolCalls stays true,
      // and the loop re-enters — sending the user's message again.
      const textId = `brokered-${Date.now()}`;
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "text-start", id: textId });
            controller.enqueue({ type: "text-end", id: textId });
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: zeroUsage() });
            controller.close();
          },
        }),
      };
    }

    // Permission return: listen-only — Claude is finishing after MCP unblocked
    const listenOnly = !!isPermReturn;

    // Include prior petals — daemon compares with JSONL state and grafts only what's new
    const priorPetals = opts.prompt.filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool");
    trace("priorPetals", { 
      sid, 
      count: priorPetals.length, 
      roles: priorPetals.map(m => m.role).join(","),
      hasToolUse: priorPetals.some(p => 
        p.role === "assistant" && 
        Array.isArray(p.content) && 
        p.content.some((c: any) => c.type === "tool-call")
      ),
      toolCallCount: priorPetals.filter(p => 
        p.role === "assistant" && 
        Array.isArray(p.content)
      ).reduce((acc, p) => acc + (p.content as any[]).filter((c: any) => c.type === "tool-call").length, 0)
    });

    // Tell the daemon to reset its session view whenever we know OC just
    // compacted. Two signals, checked on the FIRST build turn after the
    // compaction agent call:
    //
    //   (1) The most recent prior turn was compaction (sessionLastAgent
    //       remembers it). This is the authoritative signal — OC explicitly
    //       named the agent.
    //   (2) Fallback heuristic: the petal count dropped by >= 2 since the
    //       previous build turn. OC's normal prompt loop is append-only so
    //       any shrink is abnormal. The absolute-drop threshold catches the
    //       real case (where post-compaction petals stay around 60% of the
    //       pre-compaction count, so a ratio threshold missed it).
    //
    // Also decide whether to elide priorPetals from the hum payload: if the
    // petal count hasn't changed since the last send, graft() would be a
    // no-op anyway (graft is count-idempotent), and we can save
    // re-serializing the whole history over the hum socket.
    let prevPetalCount = 0;
    let elidePriorPetals = false;
    if (!skipGraft) {
      prevPetalCount = sessionPetalCounts.get(sid) ?? 0;
      sessionPetalCounts.set(sid, priorPetals.length);
      const dropped = prevPetalCount - priorPetals.length;
      const justCompacted = sessionJustCompacted.get(sid) === true;
      if (justCompacted || (prevPetalCount > 0 && dropped >= 2)) {
        trace("compaction.detected", { sid, prev: prevPetalCount, now: priorPetals.length, dropped, reason: justCompacted ? "agent" : "petal-drop" });
        hum({ chi: "cancel", sid, reason: "compaction" });
        sessionJustCompacted.delete(sid);
      } else if (prevPetalCount === priorPetals.length && prevPetalCount > 0) {
        elidePriorPetals = true;
        pendingPenny.priorPetalsElided++;
        trace("priorPetals.elided", { sid, count: priorPetals.length });
      }
    }
    if (isCompaction) {
      // Mark so the NEXT build turn (the post-compaction one) recognizes
      // the transition and triggers the cancel + truncate flow.
      sessionJustCompacted.set(sid, true);
    }

    // Extract external MCP tools from opts.tools — anything OC has that
    // clwnd doesn't handle natively (e.g. context7). KNOWN_TOOLS includes
    // both our native surface (read/do_code/do_noncode/bash/…) AND the
    // legacy-replaced tools (edit/write/glob/grep) so neither gets
    // forwarded to Claude CLI as a pseudo-MCP tool.
    const externalTools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> = [];
    const externalToolNames = new Set<string>();
    if (opts.tools) {
      for (const t of opts.tools) {
        if (t.type !== "function") continue;
        const name = t.name;
        if (KNOWN_TOOLS.has(name)) continue;
        externalTools.push({ name, description: t.description, inputSchema: t.inputSchema as Record<string, unknown> });
        externalToolNames.add(name);
      }
    }
    const ocToolNames = opts.tools ? opts.tools.filter(t => t.type === "function").map(t => t.name) : [];
    trace("tools.available", { sid, count: ocToolNames.length, names: ocToolNames.join(",") });
    if (externalTools.length > 0) trace("external.tools.detected", { sid, names: [...externalToolNames].join(",") });
    // visibleTools in the hum is ONLY external names — clwnd's native tools
    // are always advertised by the MCP server regardless. Sending OC's whole
    // tool list used to pollute this channel with legacy names that got
    // looked up in a mapping table and either missed or created ghost tools.
    const visibleExternalNames = [...externalToolNames];

    // Send prompt before creating stream — survives OC plugin reload
    let promptSent = false;
    if (listenOnly && humAlive) {
      // Permission return: register listener FIRST, then release hold
      // Order matters — Claude's post-permission events must have a listener
      const pd = flushPenny();
      hum({
        chi: "prompt", sid, cwd,
        modelId: self.modelId,
        listenOnly: true,
        ...(pd ? { pennyDelta: pd } : {}),
        dusk: duskIn(30_000),
      });
      promptSent = true;
      if (permAskId) {
        trace("permission.hold.releasing", { sid, askId: permAskId });
        hum({ chi: "release-permit", askId: permAskId, decision: "allow" });
      }
    } else if (!listenOnly && humAlive) {
      const pd = flushPenny();
      hum({
        chi: "prompt", sid, cwd,
        modelId: self.modelId,
        content, text,
        ...(sendSystemPrompt ? { systemPrompt } : {}),
        ...(sendPermissions ? { permissions } : {}),
        ...(sendAllowedTools ? { allowedTools } : {}),
        listenOnly,
        skipGraft: skipGraft || undefined,
        ocServerUrl: self.config.pluginInput?.serverUrl?.toString(),
        ...(elidePriorPetals ? {} : { priorPetals }),
        externalTools: externalTools.length > 0 ? externalTools : undefined,
        mcpServerConfigs: await getMcpServerConfigs(this.config.client),
        visibleTools: visibleExternalNames,
        ...(pd ? { pennyDelta: pd } : {}),
        dusk: duskIn(30_000),
      });
      promptSent = true;
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let done = false;
        const tendrils = new Set<string>();
        // Brokered set — only native brokered tools (webfetch etc.), NOT external MCP tools
        // External tools are executed by daemon's MCP client — Claude gets real results
        const streamBrokered = new Set(BROKERED_TOOLS);
        const buds: LanguageModelV3StreamPart[] = [];
        const metaQueue: Array<{ tool: string; title?: string; metadata?: Record<string, unknown> }> = [];
        let textId = "t0";
        let textStarted = false;
        let reasoningId = "r0";
        let reasoningStarted = false;

        function petal(part: LanguageModelV3StreamPart): void {
          if (done) return;
          try { controller.enqueue(part); } catch { done = true; }
        }

        function wilt(): void {
          if (done) return;
          done = true;
          // Evict this session's listener even when wilting was triggered by
          // abort/error (not by chi=finish). Leaving a stale entry in the map
          // would leak memory and, worse, trap any same-sid follow-up events
          // intended for the next doStream.
          humHearers.delete(sid);
          try { controller.close(); } catch {}
        }

        function shed(): void {
          for (const b of buds) petal(b);
          buds.length = 0;
        }

        opts.abortSignal?.addEventListener("abort", () => {
          if (!done) hum({ chi: "cancel", sid, dusk: duskIn(5_000) });
          wilt();
        });

        await awaitHum();
        if (!humAlive) {
          petal({ type: "error", error: new Error("clwndHum not connected") });
          wilt();
          return;
        }

        petal({ type: "stream-start", warnings: [] });

        const humFade = humHear(sid, onHummin);
        if (!promptSent) {
          hum({
            chi: "prompt", sid, cwd,
            modelId: self.modelId,
            content, text, systemPrompt,
            permissions, allowedTools, listenOnly,
            skipGraft: skipGraft || undefined,
            ocServerUrl: self.config.pluginInput?.serverUrl?.toString(),
            priorPetals,
            dusk: duskIn(30_000),
          });
        }

        function onHummin(raw: Record<string, unknown>): void {
          if (raw.chi === "tool-meta") {
            metaQueue.push({
              tool: raw.tool as string,
              title: raw.title as string,
              metadata: raw.metadata as Record<string, unknown>,
            });
            return;
          }

          const chi = raw.chi as string;

          // ── Chunks from Claude CLI ──
          if (chi === "chunk") {
            const ct = raw.chunkType as string;

            // Text
            if (ct === "text_start" || (ct === "text_delta" && !textStarted)) {
              if (!textStarted) {
                textId = `t${Date.now()}`;
                textStarted = true;
                petal({ type: "text-start", id: textId });
              }
            }
            if (ct === "text_delta" && raw.delta) {
              petal({ type: "text-delta", id: textId, delta: raw.delta as string });
            }

            // Reasoning
            if (ct === "reasoning_start" || (ct === "reasoning_delta" && !reasoningStarted)) {
              if (!reasoningStarted) {
                reasoningId = `r${Date.now()}`;
                reasoningStarted = true;
                petal({ type: "reasoning-start", id: reasoningId });
              }
            }
            if (ct === "reasoning_delta" && raw.delta) {
              petal({ type: "reasoning-delta", id: reasoningId, delta: raw.delta as string });
            }
            if (ct === "reasoning_end") {
              petal({ type: "reasoning-end", id: reasoningId });
              reasoningStarted = false;
            }

            // Tool events — close open text/reasoning blocks first, then buffer.
            // providerExecuted MUST be set on tool-input-start (not tool-call) per
            // the v3 AI SDK contract — OC's processor reads the flag there and
            // ignores it on tool-call. Without this, OC treats every non-brokered
            // clwnd tool as a pending external call, hasToolCalls stays true,
            // the prompt loop never exits on a text-only end_turn, and OC auto-
            // re-enters doStream with the same user message. Claude sees the same
            // user prompt 2-4 times per turn and complains.
            if (ct === "tool_input_start" && raw.toolCallId && raw.toolName) {
              if (textStarted) { petal({ type: "text-end", id: textId }); textStarted = false; }
              if (reasoningStarted) { petal({ type: "reasoning-end", id: reasoningId }); reasoningStarted = false; }
              sap.set(raw.toolCallId as string, "");
              const ocToolName = mapToolName(raw.toolName as string);
              const isBrokered = streamBrokered.has(ocToolName);
              buds.push({ type: "tool-input-start", id: raw.toolCallId as string, toolName: ocToolName, providerExecuted: !isBrokered });
            }
            if (ct === "tool_input_delta" && raw.toolCallId && raw.partialJson) {
              const prev = sap.get(raw.toolCallId as string) ?? "";
              sap.set(raw.toolCallId as string, prev + raw.partialJson);
              buds.push({ type: "tool-input-delta", id: raw.toolCallId as string, delta: raw.partialJson as string });
            }
            if (ct === "tool_call" && raw.toolCallId && raw.toolName) {
              const ocToolName = mapToolName(raw.toolName as string);
              if (!sap.has(raw.toolCallId as string)) {
                const isBrokeredLate = streamBrokered.has(ocToolName);
                buds.push({ type: "tool-input-start", id: raw.toolCallId as string, toolName: ocToolName, providerExecuted: !isBrokeredLate });
              }
              const accumulated = sap.get(raw.toolCallId as string);
              let rawInput: string;
              if (accumulated) {
                rawInput = mapToolInput(raw.toolName as string, accumulated);
              } else if (raw.input && typeof raw.input === "object") {
                rawInput = mapToolInput(raw.toolName as string, JSON.stringify(raw.input));
              } else {
                rawInput = "{}";
              }
              const isBrokered = streamBrokered.has(ocToolName);
              if (isBrokered) tendrils.add(raw.toolCallId as string);
              buds.push({
                type: "tool-call",
                toolCallId: raw.toolCallId as string,
                toolName: ocToolName,
                input: rawInput,
                providerExecuted: !isBrokered,
              });
            }
            if (ct === "tool_result" && (raw.toolCallId || raw.toolUseId)) {
              const callId = (raw.toolCallId ?? raw.toolUseId) as string;
              if (tendrils.has(callId)) return;
              const rawResult = raw.result ?? "";
              const resultText = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
              const queued = metaQueue.shift();
              const output = queued ? resultText : parseToolResult(resultText).output;
              const title = queued?.title ?? parseToolResult(resultText).title;
              const metadata = queued?.metadata ?? parseToolResult(resultText).metadata;
              shed();
              petal({
                type: "tool-result",
                toolCallId: callId,
                toolName: mapToolName(raw.toolName as string ?? ""),
                result: { output, title, metadata },
                providerExecuted: true,
              } as LanguageModelV3StreamPart);
            }
          }

          // ── Permission ask ──
          if (chi === "permission-ask") {
            trace("permission.toolcall", { askId: raw.askId, tool: raw.tool, buffered: buds.length });
            buds.length = 0;
            const permCallId = `perm-${raw.askId}`;
            const permInput = JSON.stringify({ tool: raw.tool, path: raw.path ?? "", askId: raw.askId });
            petal({ type: "tool-input-start", id: permCallId, toolName: "clwnd_permission" });
            tendrils.add(permCallId);
            petal({
              type: "tool-call",
              toolCallId: permCallId,
              toolName: "clwnd_permission",
              input: permInput,
              providerExecuted: false,
            });
            if (textStarted) petal({ type: "text-end", id: textId });
            if (reasoningStarted) petal({ type: "reasoning-end", id: reasoningId });
            petal({
              type: "finish",
              finishReason: { unified: "tool-calls", raw: "tool-calls" },
              usage: zeroUsage(),
            });
            wilt();
            return;
          }

          // ── Finish ──
          if (chi === "finish") {
            shed();
            if (textStarted) petal({ type: "text-end", id: textId });
            if (reasoningStarted) petal({ type: "reasoning-end", id: reasoningId });

            const u = raw.usage as Record<string, unknown> | undefined;
            const cacheRead = Number(u?.cache_read_input_tokens ?? 0);
            const cacheWrite = Number(u?.cache_creation_input_tokens ?? 0);
            const inputBase = Number(u?.input_tokens ?? u?.inputTokens ?? 0);
            const outputTokens = Number(u?.output_tokens ?? u?.outputTokens ?? 0);

            const fr: LanguageModelV3FinishReason = tendrils.size > 0
              ? { unified: "tool-calls", raw: "tool-calls" }
              : mapFinishReason(raw.finishReason as string | undefined);

            trace("stream.finish", { sid, finishReason: fr.unified });

            petal({
              type: "finish",
              finishReason: fr,
              usage: {
                inputTokens: {
                  total: inputBase + cacheRead + cacheWrite,
                  noCache: inputBase,
                  cacheRead,
                  cacheWrite,
                },
                outputTokens: {
                  total: outputTokens,
                  text: undefined,
                  reasoning: undefined,
                },
              },
              providerMetadata: {
                anthropic: { cacheCreationInputTokens: cacheWrite },
              },
            });
            wilt();
            return;
          }

          // ── Error ──
          if (chi === "error") {
            petal({ type: "error", error: new Error(raw.message as string) });
            wilt();
            return;
          }
        }

        try {
          await humFade;
        } catch (e) {
          petal({ type: "error", error: e instanceof Error ? e : new Error(String(e)) });
          wilt();
        }
      },
    });

    return { stream };
  }
}

// ─── Factory ─────────────────────────────────────────────────────────────

let sharedClient: unknown = null;
let sharedPluginInput: ClwndConfig["pluginInput"] = undefined;
export function setSharedClient(client: unknown): void { sharedClient = client; }
export function setSharedPluginInput(input: ClwndConfig["pluginInput"]): void { sharedPluginInput = input; }

export function createClwnd(config: ClwndConfig = {}) {
  if (!config.client && sharedClient) config = { ...config, client: sharedClient };
  if (!config.pluginInput && sharedPluginInput) config = { ...config, pluginInput: sharedPluginInput };
  const fn = (modelId: string): LanguageModelV3 => new ClwndModel(modelId, config);
  fn.languageModel = (modelId: string) => new ClwndModel(modelId, config);
  return fn;
}
