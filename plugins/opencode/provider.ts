import { generateId } from "@ai-sdk/provider-utils";
import { randomUUID } from "crypto";
import * as session from "../../lib/session.ts";
import { loadConfig } from "../../lib/config.ts";

// ─── Logging ────────────────────────────────────────────────────────────────
// Three destinations: plugin log file (always), hum → daemon (when connected), OC debug (when client ready).

import { appendFileSync, mkdirSync } from "fs";

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
import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  LanguageModelV2Prompt,
} from "@ai-sdk/provider";
import type { ClwndConfig } from "./types.ts";

// ─── Tool Mapping (Claude CLI MCP → OpenCode native) ────────────────────────

const MCP_PREFIX = "mcp__clwnd__";

// Map tool names to OpenCode equivalents
const TOOL_NAME_MAP: Record<string, string> = {
  WebFetch: "webfetch", WebSearch: "websearch",
  TodoWrite: "todowrite", AskUserQuestion: "question",
  Task: "task", Skill: "skill",
};

function mapToolName(name: string): string {
  if (name.startsWith(MCP_PREFIX)) return name.slice(MCP_PREFIX.length);
  return TOOL_NAME_MAP[name] ?? name;
}

// Tools that OpenCode should execute (providerExecuted: false).
// These are brokered: MCP server runs them for Claude CLI, but we
// tell OpenCode to also execute them natively for state/UI integration.
// Tools that OpenCode should execute (providerExecuted: false).
// MCP server still runs them for Claude CLI, but we tell OpenCode
// to also execute them natively for state/UI integration.
const BROKERED_TOOLS = new Set(["webfetch", "websearch", "todowrite"]);

// snake_case → camelCase field mapping per tool
const INPUT_FIELD_MAP: Record<string, Record<string, string>> = {
  read:  { file_path: "filePath" },
  edit:  { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  write: { file_path: "filePath" },
  bash:  {}, // command, description, timeout are already correct
  glob:  {}, // pattern, path are already correct
  grep:  {}, // pattern, path, include are already correct
};

function mapToolInput(toolName: string, input: string): string {
  const ocName = mapToolName(toolName);

  // TodoWrite: ensure each todo has 'priority', remove 'activeForm'
  if (ocName === "todowrite") {
    try {
      const parsed = JSON.parse(input);
      if (parsed.todos && Array.isArray(parsed.todos)) {
        parsed.todos = parsed.todos.map((t: any) => ({
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

// Extract <!--clwnd-meta:...--> from MCP tool result text
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


function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/clwnd/clwnd.sock`;
  return "/tmp/clwnd/clwnd.sock";
}

const HUM_PATH = (process.env.CLWND_SOCKET ?? defaultSocketPath()) + ".hum";

// ─── clwndHum: Bidirectional NDJSON socket ─────────────────────────────────
// Persistent connection to daemon via net.connect (Node-compatible).
// Both sides push typed messages (chi field).

import { connect as netConnect, type Socket as NetSocket } from "net";

type HumListener = (msg: Record<string, unknown>) => void;

let humSocket: NetSocket | null = null;
let humEcho = "";
let humHearer: HumListener | null = null;
let humAlive = false;
let humReady: { resolve: () => void } | null = null;
let humAwaken: Promise<void> = awakenHum();

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
          // Echo: daemon acknowledges receipt of our tone
          if (msg.chi === "echo") {
            trace("hum.echo", { rid: msg.rid, ok: msg.ok });
            continue;
          }
          // Breath: daemon sends full state on connect — restore turnsSent
          if (msg.chi === "breath") {
            const sessions = (msg.sessions ?? []) as Array<{ sid: string; turnsSent: number }>;
            for (const s of sessions) {
              if (typeof s.turnsSent === "number" && s.turnsSent >= 0 && !turnsSent.has(s.sid)) {
                turnsSent.set(s.sid, s.turnsSent);
              }
            }
            trace("hum.breath.received", { sessions: sessions.length, restored: sessions.filter(s => s.turnsSent >= 0).length });
            continue;
          }
          // Pulse: lifecycle events from the sentinel
          if (msg.chi === "pulse") {
            const kind = msg.kind as string;
            const sid = msg.sid as string;
            trace("hum.pulse", { kind, sid });
            if (kind === "roost-died" || kind === "roost-idle" || kind === "roost-evicted") {
              // Process gone — clear any pending state for this session
              // turnsSent preserved (restored via breath on reconnect)
            }
            continue;
          }
          if (humHearer) humHearer(msg);
        } catch {}
      }
    });

    humSocket.on("close", () => {
      humAlive = false;
      humSocket = null;
      // Don't clear turnsSent — OC's prompt history doesn't change on hum reconnect.
      // The daemon tracks needsRespawn separately for process lifecycle.
      trace("hum.disconnected");
      // Refresh the await-able promise so doStream waits for reconnect
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
  if (!msg.rid) msg.rid = makeRid();
  msg.from = "plugin";
  try {
    const data = JSON.stringify(msg) + "\n";
    writeLog("trace", "hum.send", { chi: msg.chi as string, rid: msg.rid as string, len: data.length });
    humSocket.write(data);
  } catch (e) {
    writeLog("trace", "hum.send.failed", { err: String(e) });
  }
}

/**
 * Send a prompt on the hum and return a promise that collects messages
 * until "finish" or "error" arrives. The consumer reads messages via
 * the callback. Returns when the turn is done.
 */
async function humSpeak(msg: Record<string, unknown>, onMessage: HumListener): Promise<void> {
  // Wait for hum reconnect if it dropped (e.g., OC plugin reload on model switch)
  if (!humAlive) {
    writeLog("trace", "humSpeak.waiting", { chi: msg.chi as string });
    await humAwaken;
  }
  return new Promise<void>((resolve, reject) => {
    humHearer = (incoming) => {
      onMessage(incoming);
      if (incoming.chi === "finish" || incoming.chi === "error") {
        humHearer = null;
        resolve();
      }
    };
    hum({ chi: "prompt", ...msg });
  });
}

/**
 * Listen on the hum without sending a prompt (for permission return continuation).
 * Returns when the turn finishes.
 */
function humHear(onMessage: HumListener): Promise<void> {
  return new Promise<void>((resolve) => {
    humHearer = (incoming) => {
      onMessage(incoming);
      if (incoming.chi === "finish" || incoming.chi === "error") {
        humHearer = null;
        resolve();
      }
    };
  });
}


/**
 * Detect auxiliary calls — provider calls with no tools attached.
 *
 * OpenCode uses `small_model` (config) for lightweight tasks that don't need
 * tools: title generation, session compaction, and summarization. When
 * `small_model` is set (the daemon auto-detects a free opencode/* model on
 * startup), these calls are routed to that provider and never reach us.
 *
 * This guard exists as a safety net for when `small_model` is unset or the
 * free model is unavailable — in that case OpenCode falls back to the main
 * provider (us). We return an empty response immediately rather than spawning
 * a claude CLI process for something that doesn't need session context, MCP
 * tools, or any clwnd machinery.
 *
 * Detection: auxiliary calls have no tools in `opts.tools`. All real chat
 * calls from OpenCode always include the tool list.
 */
function isAuxiliaryCall(opts: { prompt: LanguageModelV2Prompt; tools?: unknown[] | unknown }): boolean {
  const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
  return !hasTools;
}


// Detect brokered tool return — OpenCode executed the tool and is sending
// the result back. We short-circuit: Claude already responded with real data.
function isBrokeredToolReturn(prompt: LanguageModelV2Prompt): boolean {
  if (prompt.length < 2) return false;
  const last = prompt[prompt.length - 1];
  if (last.role !== "tool" || !Array.isArray(last.content)) return false;
  for (const part of last.content as Array<{ type: string; toolName?: string; toolCallId?: string }>) {
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

// Derive allowed MCP tools from OpenCode's resolved tool set.
// OpenCode's resolveTools() already filters tools based on agent+session permissions.
// If edit/write are denied (e.g. plan mode), they won't be in opts.tools.
// We map OpenCode tool names to our MCP tool names.
const OC_TO_MCP: Record<string, string> = {
  read: "read", edit: "edit", write: "write", bash: "bash",
  glob: "glob", grep: "grep", apply_patch: "edit", webfetch: "webfetch",
};

const lastAllowedTools = new Map<string, string>();

// Agent-based tool restrictions
const AGENT_DENY: Record<string, Set<string>> = {
  plan: new Set(["edit", "write"]),
};

function deriveAllowedTools(sid: string, opts: { tools?: Array<{ name: string }> | unknown, headers?: Record<string, string | undefined> }): string[] {
  const agent = opts.headers?.["x-clwnd-agent"] ?? "";
  let agentName = agent;
  try { const p = JSON.parse(agent); if (p?.name) agentName = p.name; } catch {}

  const denied = AGENT_DENY[agentName] ?? new Set();
  const all = ["read", "edit", "write", "bash", "glob", "grep", "webfetch"];
  const result = all.filter(t => !denied.has(t));

  const key = result.join(",");
  const prev = lastAllowedTools.get(sid);
  if (prev !== key) {
    trace("allowedTools.changed", { sid, agent: agentName, old: prev ?? "none", new: key });
    lastAllowedTools.set(sid, key);
  }
  return result;
}

const lastReminder = new Map<string, string>();

type ContentPart =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

function extractContent(prompt: LanguageModelV2Prompt, sessionId?: string): ContentPart[] {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return [{ type: "text", text: m.content }];
      if (Array.isArray(m.content)) {
        const parts: ContentPart[] = [];
        for (const p of m.content as Array<{ type: string; text?: string; image?: Uint8Array | URL; mimeType?: string; data?: Uint8Array | string | URL; mediaType?: string; url?: string }>) {
          if (p.type === "text" && p.text) parts.push({ type: "text", text: p.text });
          // V1 ImagePart: { type: "image", image: Uint8Array | URL, mimeType }
          if (p.type === "image" && p.image) {
            const b64 = p.image instanceof Uint8Array
              ? Buffer.from(p.image).toString("base64")
              : p.image.toString();
            parts.push({
              type: "image",
              source: { type: "base64", media_type: p.mimeType ?? "image/png", data: b64 },
            });
          }
          // V2 FilePart: { type: "file", data: Uint8Array | string | URL, mediaType }
          // Also handles OC's format: { type: "file", url: "data:...", mediaType }
          if (p.type === "file" && (p.mediaType ?? "").startsWith("image/")) {
            let b64: string | undefined;
            const raw = p.data ?? p.url;
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
              parts.push({
                type: "image",
                source: { type: "base64", media_type: p.mediaType ?? "image/png", data: b64 },
              });
            }
          }
        }
        if (parts.length === 0) continue;
        // Strip repeated system reminders — only send when changed
        if (sessionId) {
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j].type !== "text") continue;
            const reminder = (parts[j] as { text: string }).text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
            if (reminder) {
              const prev = lastReminder.get(sessionId);
              if (prev === reminder) {
                // Remove this part entirely if it's only the reminder, or strip it
                const stripped = parts[j].text.replace(reminder, "").trim();
                if (stripped) { parts[j] = { type: "text", text: stripped }; }
                else { parts.splice(j, 1); }
                trace("reminder.stripped", { sid: sessionId });
              } else {
                lastReminder.set(sessionId, reminder);
                trace("reminder.updated", { sid: sessionId });
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

// Flatten content parts to string — used where a single string is needed
function extractText(prompt: LanguageModelV2Prompt, sessionId?: string): string {
  return extractContent(prompt, sessionId)
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map(p => p.text).join("\n\n");
}

// ─── History Seeding (#7) ────────────────────────────────────────────────────
// Two paths: cold start (JSONL export) and gap fill (content injection).

const turnsSent = new Map<string, number>();

/** Reset turn counter after compaction — forces full re-seed on next message */
export function resetTurnsSent(sid: string): void {
  turnsSent.delete(sid);
}

// turnsSent restored via breath on hum connect — no filesystem IPC needed

function countHistoryTurns(prompt: LanguageModelV2Prompt): number {
  let lastUserIdx = -1;
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "user") { lastUserIdx = i; break; }
  }
  let turns = 0;
  for (let i = 0; i < lastUserIdx; i++) {
    if (prompt[i].role === "user") turns++;
  }
  return turns;
}

// Path A: Extract history EXCLUDING current user message for JSONL export.
// The current message arrives via stdin (murmur). Seed provides context only.
function extractHistoryForExport(prompt: LanguageModelV2Prompt): Array<{ role: string; content: unknown }> | null {
  let lastUserIdx = -1;
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "user") { lastUserIdx = i; break; }
  }
  const history = prompt.slice(0, lastUserIdx).filter(m => m.role !== "system");
  return history.length > 0 ? history.map(m => ({ role: m.role, content: m.content })) : null;
}

// Path B: Extract gap turns EXCLUDING current user message for JSONL export.
function extractGapForExport(prompt: LanguageModelV2Prompt, after: number): Array<{ role: string; content: unknown }> | null {
  let lastUserIdx = -1;
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "user") { lastUserIdx = i; break; }
  }
  const allHistory = prompt.slice(0, lastUserIdx).filter(m => m.role !== "system");
  // Count user turns to find the gap start point
  let userCount = 0;
  let gapStart = 0;
  for (let i = 0; i < allHistory.length; i++) {
    if (allHistory[i].role === "user") {
      userCount++;
      if (userCount > after) { gapStart = i; break; }
    }
  }
  if (userCount <= after) return null;
  const gap = allHistory.slice(gapStart);
  return gap.length > 0 ? gap.map(m => ({ role: m.role, content: m.content })) : null;
}

function extractSystemPrompt(prompt: LanguageModelV2Prompt): string {
  const parts: string[] = [];
  for (const m of prompt) {
    if (m.role === "system") {
      if (typeof m.content === "string") {
        parts.push(m.content);
      } else if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{ type: string; text?: string }>) {
          if (p.type === "text" && p.text) parts.push(p.text);
        }
      }
    }
  }
  return parts.join("\n\n");
}

// Track agent per session via x-clwnd-agent header (injected by chat.headers hook)
const sessionLastAgent = new Map<string, string>();

function detectAgent(sid: string, headers?: Record<string, string | undefined>): string | null {
  const raw = headers?.["x-clwnd-agent"] ?? null;
  if (!raw) return null;
  // Parse agent name — could be string or JSON object
  let agent = raw;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === "object" && parsed.name) agent = parsed.name;
  } catch {}
  const prev = sessionLastAgent.get(sid);
  if (prev && prev !== agent) {
    trace("agent.changed", { sid, old: prev, new: agent });
  }
  sessionLastAgent.set(sid, agent);
  trace("agent.current", { sid, agent });
  return agent;
}

// Fetch session directory from OpenCode (may change via opencode-dir /cd)
async function getSessionDirectory(client: any, sessionId: string): Promise<string | null> {
  if (!client) return null;
  try {
    const resp = await client.session.get({ path: { sessionID: sessionId } });
    return resp.data?.directory ?? null;
  } catch {
    return null;
  }
}

// Fetch session permission rules from OpenCode

// Cache agent permission rules — fetched once per agent name
const agentPermissionCache = new Map<string, Array<{ permission: string; pattern: string; action: string }>>();

async function getSessionPermissions(client: any, sessionId: string): Promise<Array<{ permission: string; pattern: string; action: string }>> {
  if (!client) return [];
  const agentName = sessionLastAgent.get(sessionId) ?? "build";

  // Check cache first
  if (agentPermissionCache.has(agentName)) return agentPermissionCache.get(agentName)!;

  try {
    // Fetch all agents and find the matching one
    const resp = await client.app.agents();
    const agents = resp.data ?? [];
    const agent = agents.find((a: any) => a.name === agentName);
    const perms = agent?.permission ?? [];
    agentPermissionCache.set(agentName, perms);
    trace("permissions.loaded", { agent: agentName, count: perms.length });
    return perms;
  } catch (e: any) {
    trace("permissions.error", { agent: agentName, err: e?.message ?? String(e) });
    return [];
  }
}

// Parse NDJSON lines from buffer
export class ClwndModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly modelId: string;
  readonly provider = "clwnd";
  readonly supportedUrls: Record<string, RegExp[]> = {
    "image/*": [],  // accept all image types (data URLs handled inline)
  };

  constructor(
    modelId: string,
    private config: ClwndConfig = {},
  ) {
    this.modelId = modelId;
  }

  async doGenerate(
    opts: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<{
    content: LanguageModelV2Content[];
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: LanguageModelV2CallWarning[];
    request: { body: unknown };
    response: { id: string; timestamp: Date; modelId: string };
    providerMetadata: Record<string, unknown>;
  }> {
    // Auxiliary call (title gen, compaction) — reject gracefully unless ocCompaction is on
    if (isAuxiliaryCall(opts) && !loadConfig().ocCompaction) {
      trace("auxiliary.reject", { method: "doGenerate" });
      return {
        content: [{ type: "text" as const, text: "" }],
        finishReason: "stop" as LanguageModelV2FinishReason,
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: undefined },
        warnings: [],
        request: { body: {} },
        response: { id: generateId(), timestamp: new Date(), modelId: this.modelId },
        providerMetadata: {},
      };
    }

    const sid = opts.headers?.["x-opencode-session"] ?? generateId();
    const text = extractText(opts.prompt, sid);
    const systemPrompt = extractSystemPrompt(opts.prompt);
    detectAgent(sid, opts.headers);
    const warnings: LanguageModelV2CallWarning[] = [];
    const cwd = (this.config.client ? await getSessionDirectory(this.config.client, sid) : null) ?? this.config.cwd ?? process.cwd();
    const permissions = await getSessionPermissions(this.config.client, sid);
    const allowedTools = deriveAllowedTools(sid, opts);

    let reasoning = "";
    let responseText = "";
    const toolCalls: LanguageModelV2Content[] = [];
    const sap = new Map<string, string>();

    await humAwaken;
    if (!humAlive) throw new Error("clwndHum not connected");

    const result = await new Promise<{
      content: LanguageModelV2Content[];
      finishReason: LanguageModelV2FinishReason;
      usage: LanguageModelV2Usage;
      providerMetadata: Record<string, unknown>;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("doGenerate timeout")), 120_000);
      opts.abortSignal?.addEventListener("abort", () => { clearTimeout(timeout); reject(new Error("aborted")); });

      humSpeak({
        sid, cwd, modelId: this.modelId, text,
        systemPrompt, permissions, allowedTools,
      }, (msg) => {
        const chi = msg.chi as string;
        if (chi === "tool-meta") return; // out-of-band, not needed for doGenerate

        if (chi === "chunk") {
          const ct = msg.chunkType as string;
          if (ct === "reasoning_delta" && typeof msg.delta === "string") reasoning += msg.delta;
          if (ct === "text_delta" && typeof msg.delta === "string") responseText += msg.delta;
          if (ct === "tool_input_start" && msg.toolCallId) sap.set(msg.toolCallId as string, "");
          if (ct === "tool_input_delta" && msg.toolCallId && msg.partialJson) {
            const prev = sap.get(msg.toolCallId as string) ?? "";
            sap.set(msg.toolCallId as string, prev + msg.partialJson);
          }
          if (ct === "tool_call" && msg.toolCallId && msg.toolName) {
            const accumulated = sap.get(msg.toolCallId as string) ?? "{}";
            const mapped = mapToolInput(msg.toolName as string, accumulated);
            let input: unknown = {};
            try { input = JSON.parse(mapped); } catch { input = {}; }
            toolCalls.push({
              type: "tool-call", toolCallId: msg.toolCallId,
              toolName: mapToolName(msg.toolName as string), input,
            } as LanguageModelV2Content);
          }
        }

        if (chi === "finish") {
          clearTimeout(timeout);
          const content: LanguageModelV2Content[] = [];
          if (reasoning) content.push({ type: "reasoning", text: reasoning } as LanguageModelV2Content);
          if (responseText) content.push({ type: "text", text: responseText } as LanguageModelV2Content);
          content.push(...toolCalls);
          const fu = msg.usage as Record<string, unknown> | undefined;
          const fCacheRead = (fu?.cache_read_input_tokens ?? 0) as number;
          const fCacheWrite = (fu?.cache_creation_input_tokens ?? 0) as number;
          const fInput = (fu?.input_tokens ?? 0) as number;
          resolve({
            content,
            finishReason: (msg.finishReason ?? "stop") as LanguageModelV2FinishReason,
            usage: {
              inputTokens: fInput + fCacheRead + fCacheWrite,
              outputTokens: (fu?.output_tokens ?? 0) as number,
              totalTokens: undefined,
              cachedInputTokens: fCacheRead,
            } as LanguageModelV2Usage,
            providerMetadata: {
              ...((msg.providerMetadata ?? {}) as Record<string, unknown>),
              anthropic: { cacheCreationInputTokens: fCacheWrite },
            },
          });
        }

        if (chi === "error") {
          clearTimeout(timeout);
          reject(new Error(msg.message as string));
        }
      }).catch(reject);
    });

    return {
      ...result,
      warnings,
      request: { body: { text } },
      response: { id: sid, timestamp: new Date(), modelId: this.modelId },
    };
  }

  async doStream(
    opts: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    rawCall: { raw: unknown; rawHeaders: unknown };
    warnings: LanguageModelV2CallWarning[];
  }> {
    // Debug: log prompt content types
    for (const m of opts.prompt) {
      if (m.role === "user" && Array.isArray(m.content)) {
        for (const p of m.content) {
        }
      }
    }
    // Auxiliary call (title gen, compaction) — reject gracefully unless ocCompaction is on.
    // When ocCompaction is enabled, compaction calls come through us — let them proceed.
    if (isAuxiliaryCall(opts) && !loadConfig().ocCompaction) {
      trace("auxiliary.reject", { method: "doStream" });
      const bloom = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: undefined }, providerMetadata: {} } as LanguageModelV2StreamPart);
          controller.close();
        },
      });
      return { stream: bloom, rawCall: { raw: {}, rawHeaders: {} }, warnings: [] };
    }

    const sid = opts.headers?.["x-opencode-session"] ?? generateId();
    const content = extractContent(opts.prompt, sid);
    const text = content.map(p => p.text).join("\n\n");
    const systemPrompt = extractSystemPrompt(opts.prompt);
    detectAgent(sid, opts.headers);
    const warnings: LanguageModelV2CallWarning[] = [];
    const cwd = (this.config.client ? await getSessionDirectory(this.config.client, sid) : null) ?? this.config.cwd ?? process.cwd();
    const self = this;
    const sap = new Map<string, string>();
    const permissions = await getSessionPermissions(this.config.client, sid);
    const allowedTools = deriveAllowedTools(sid, opts);

    // History seeding (#7) — plugin writes JSONL directly, signals daemon
    // turnsSent restored via breath on hum connect
    const historyTurns = countHistoryTurns(opts.prompt);
    const sent = turnsSent.get(sid) ?? -1;
    let seedClaudeId: string | undefined;
    let seedClaudePath: string | undefined;

    if (!isAuxiliaryCall(opts) && !isBrokeredToolReturn(opts.prompt)) {
      let seedHistory: Array<{ role: string; content: unknown }> | null = null;

      if (sent === -1 && historyTurns > 0) {
        seedHistory = extractHistoryForExport(opts.prompt);
        if (seedHistory) {
          trace("seed.export", { sid, turns: historyTurns, promptLen: opts.prompt.length, roles: opts.prompt.map(m => m.role).join(","), seedLen: seedHistory.length });
        }
      } else if (sent >= 0 && historyTurns > sent) {
        seedHistory = extractGapForExport(opts.prompt, sent);
        if (seedHistory) trace("seed.gap", { sid, from: sent, to: historyTurns });
      }

      if (seedHistory) {
        // Write JSONL directly — synchronous, survives plugin reload
        seedClaudeId = randomUUID();
        seedClaudePath = session.createSession(cwd, seedClaudeId);
        session.fromPrompt(seedClaudePath, seedClaudeId, seedHistory, cwd);
        log("seed.written", { sid, claudeId: seedClaudeId, path: seedClaudePath, turns: seedHistory.length });
        // Lightweight signal to daemon — even if lost, prompt carries the info
        hum({ chi: "seeded", sid, claudeSessionId: seedClaudeId, claudeSessionPath: seedClaudePath, cwd });
      }

      // +1 because the current turn (being sent now) will be history on the next call
      turnsSent.set(sid, historyTurns + 1);
    }

    // Brokered tool return — OpenCode executed the tool, sending result back.
    if (isBrokeredToolReturn(opts.prompt)) {
      trace("brokered.return", { sid });

      // Check if this is a permission return — if so, fall through to normal
      // stream handling so Claude CLI's continuation (write + response) flows to OC
      let isPermissionReturn = false;
      const lastTool = opts.prompt.findLast(m => m.role === "tool");
      if (lastTool && Array.isArray(lastTool.content)) {
        for (const part of lastTool.content as Array<{ type: string; toolCallId?: string; result?: unknown; isError?: boolean }>) {
          if (part.type === "tool-result" && part.toolCallId?.startsWith("perm-")) {
            isPermissionReturn = true;
            trace("permission.return", { callId: part.toolCallId });
          }
        }
      }

      // Non-permission brokered return — finish immediately
      if (!isPermissionReturn) {
        const bloom = new ReadableStream<LanguageModelV2StreamPart>({
          start(controller) {
            controller.enqueue({ type: "finish", finishReason: "stop", usage: { inputTokens: 0, outputTokens: 0, totalTokens: undefined }, providerMetadata: {} } as LanguageModelV2StreamPart);
            controller.close();
          },
        });
        return { stream: bloom, rawCall: { raw: {}, rawHeaders: {} }, warnings };
      }

      // Permission return — fall through to open a new ear to clwndHum.
      // Claude CLI already executed the tool and is continuing. The daemon's
      // stream endpoint will attach to the persistent process and forward
      // the write tool call + result + text response to OC.
      trace("permission.continue", { sid });
    }

    // Flag for permission return — daemon should listen only, not send a prompt
    const listenOnly = isBrokeredToolReturn(opts.prompt) && (() => {
      const lt = opts.prompt.findLast(m => m.role === "tool");
      return lt && Array.isArray(lt.content) && (lt.content as any[]).some((p: any) => p.toolCallId?.startsWith("perm-"));
    })();

    // Send prompt synchronously BEFORE creating the stream — survives OC plugin reload
    let promptSent = false;
    if (!listenOnly && humAlive) {
      hum({
        chi: "prompt", sid, cwd,
        modelId: self.modelId,
        content, text, systemPrompt,
        permissions, allowedTools, listenOnly,
        turnsSent: turnsSent.get(sid) ?? -1,
        // Carry seed info in prompt — daemon uses this even if chi:"seeded" was lost
        ...(seedClaudeId ? { seedClaudeId, seedClaudePath } : {}),
      });
      promptSent = true;
    }

    const bloom = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        const textId = generateId();
        const reasoningId = generateId();
        let done = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let textStarted = false;
        let reasoningStarted = false;
        const tendrils = new Set<string>(); // tool calls OpenCode should execute
        const buds: LanguageModelV2StreamPart[] = []; // buffered tool events pending permit check
        function shed() {
          for (const part of buds) petal(part);
          buds.length = 0;
        }

        function petal(part: LanguageModelV2StreamPart) {
          if (done) return;
          try { controller.enqueue(part); } catch { done = true; }
        }

        function wilt() {
          if (done) return;
          done = true;
          try { reader?.releaseLock(); } catch {}
          try { controller.close(); } catch {}
        }

        opts.abortSignal?.addEventListener("abort", () => {
          if (!done) {
            // Mid-turn abort — kill the Claude CLI process.
            // Session state preserved — next message respawns via --resume.
            hum({ chi: "cancel", sid });
          }
          wilt();
        });

        // Wait for hum connection (refreshable — survives plugin reload)
        await humAwaken;
        if (!humAlive) {
          petal({ type: "error", error: new Error("clwndHum not connected") } as LanguageModelV2StreamPart);
          wilt();
          return;
        }

        petal({ type: "stream-start", warnings } as LanguageModelV2StreamPart);

        // Listen for responses — prompt already sent before stream creation
        const humFade = humHear(onHummin);
        if (!promptSent) {
          // Hum was dead during sync send — send now that we've reconnected
          hum({
            chi: "prompt", sid, cwd,
            modelId: self.modelId,
            content, text, systemPrompt,
            permissions, allowedTools, listenOnly,
            turnsSent: turnsSent.get(sid) ?? -1,
            ...(seedClaudeId ? { seedClaudeId, seedClaudePath } : {}),
          });
        }

        // Out-of-band tool metadata queue — daemon hums meta before Claude CLI streams the result
        const metaQueue: Array<{ tool: string; title?: string; metadata?: Record<string, unknown> }> = [];

        function onHummin(raw: Record<string, unknown>): void {
          // Tool metadata arrives out-of-band — queue it for the next tool_result
          if (raw.chi === "tool-meta") {
            metaQueue.push({ tool: raw.tool as string, title: raw.title as string, metadata: raw.metadata as Record<string, unknown> });
            trace("meta.received", { tool: raw.tool });
            return;
          }

          // Map chi → action for compatibility with existing processing code
          const msg: Record<string, unknown> = { ...raw };
          if (raw.chi === "chunk") msg.action = "chunk";
          else if (raw.chi === "finish") msg.action = "finish";
          else if (raw.chi === "session-ready") msg.action = "session_ready";
          else if (raw.chi === "error") msg.action = "error";
          else if (raw.chi === "permission-ask") msg.action = "permission_ask";
          else msg.action = raw.chi;
              if (msg.action === "chunk") {
                const ct = msg.chunkType;
                if (ct === "text_start" || (ct === "text_delta" && !textStarted)) {
                  if (!textStarted) {
                    textStarted = true;
                    petal({ type: "text-start", id: textId } as LanguageModelV2StreamPart);
                  }
                }
                if (ct === "text_delta" && msg.delta) {
                  petal({ type: "text-delta", id: textId, delta: msg.delta } as LanguageModelV2StreamPart);
                }
                if (ct === "reasoning_start" || (ct === "reasoning_delta" && !reasoningStarted)) {
                  if (!reasoningStarted) {
                    reasoningStarted = true;
                    petal({ type: "reasoning-start", id: reasoningId } as LanguageModelV2StreamPart);
                  }
                }
                if (ct === "reasoning_delta" && msg.delta) {
                  petal({ type: "reasoning-delta", id: reasoningId, delta: msg.delta } as LanguageModelV2StreamPart);
                }
                if (ct === "reasoning_end") {
                  petal({ type: "reasoning-end", id: reasoningId } as LanguageModelV2StreamPart);
                  reasoningStarted = false; // prevent double-end at finish
                }
                // Buffer tool events — don't emit until we know if permission_ask follows.
                // If permission_ask arrives, drop the buffer and emit clwnd_permission instead.
                // If finish arrives, flush the buffer as normal.
                if (ct === "tool_input_start" && msg.toolCallId && msg.toolName) {
                  sap.set(msg.toolCallId as string, "");
                  buds.push({ type: "tool-input-start", id: msg.toolCallId, toolName: mapToolName(msg.toolName as string) } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_input_delta" && msg.toolCallId && msg.partialJson) {
                  const prev = sap.get(msg.toolCallId as string) ?? "";
                  sap.set(msg.toolCallId as string, prev + msg.partialJson);
                  buds.push({ type: "tool-input-delta", id: msg.toolCallId, delta: msg.partialJson } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_call" && msg.toolCallId && msg.toolName) {
                  const ocToolName = mapToolName(msg.toolName as string);
                  if (!sap.has(msg.toolCallId as string)) {
                    buds.push({ type: "tool-input-start", id: msg.toolCallId, toolName: ocToolName } as LanguageModelV2StreamPart);
                  }
                  const accumulated = sap.get(msg.toolCallId as string);
                  let rawInput: string;
                  if (accumulated) {
                    rawInput = mapToolInput(msg.toolName as string, accumulated);
                  } else if (msg.input && typeof msg.input === "object") {
                    rawInput = mapToolInput(msg.toolName as string, JSON.stringify(msg.input));
                  } else {
                    rawInput = "{}";
                  }
                  const isBrokered = BROKERED_TOOLS.has(ocToolName);
                  if (isBrokered) tendrils.add(msg.toolCallId as string);
                  buds.push({
                    type: "tool-call",
                    toolCallId: msg.toolCallId,
                    toolName: ocToolName,
                    input: rawInput,
                    providerExecuted: !isBrokered,
                  } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_result" && (msg.toolCallId || msg.toolUseId)) {
                  const callId = (msg.toolCallId ?? msg.toolUseId) as string;
                  if (tendrils.has(callId)) return;
                  const rawResult = (msg as Record<string, unknown>).result ?? "";
                  const resultText = typeof rawResult === "string" ? rawResult : JSON.stringify(rawResult);
                  // Prefer out-of-band metadata (hummed separately, never touched Claude CLI)
                  // Fall back to parsing <!--clwnd-meta:--> for backward compat
                  const queued = metaQueue.shift();
                  const output = queued ? resultText : parseToolResult(resultText).output;
                  const title = queued?.title ?? parseToolResult(resultText).title;
                  const metadata = queued?.metadata ?? parseToolResult(resultText).metadata;
                  shed();
                  petal({
                    type: "tool-result",
                    toolCallId: callId,
                    result: { output, title, metadata },
                    providerExecuted: true,
                  } as LanguageModelV2StreamPart);
                }
              }

              // Permission ask — drop buffered tool events, emit clwnd_permission instead
              if (msg.action === "permission_ask") {
                trace("permission.toolcall", { askId: msg.askId, tool: msg.tool, buffered: buds.length });
                buds.length = 0; // drop the buffered tool-call
                const permCallId = `perm-${msg.askId}`;
                const permInput = JSON.stringify({ tool: msg.tool, path: msg.path ?? "", askId: msg.askId });
                petal({ type: "tool-input-start", id: permCallId, toolName: "clwnd_permission" } as LanguageModelV2StreamPart);
                tendrils.add(permCallId);
                petal({
                  type: "tool-call",
                  toolCallId: permCallId,
                  toolName: "clwnd_permission",
                  input: permInput,
                  providerExecuted: false,
                } as LanguageModelV2StreamPart);
                // Close bloom so OC processes the permission tool call immediately
                if (textStarted) petal({ type: "text-end", id: textId } as LanguageModelV2StreamPart);
                if (reasoningStarted) petal({ type: "reasoning-end", id: reasoningId } as LanguageModelV2StreamPart);
                petal({
                  type: "finish",
                  finishReason: "tool-calls",
                  usage: { inputTokens: 0, outputTokens: 0, totalTokens: undefined },
                  providerMetadata: {},
                } as LanguageModelV2StreamPart);
                wilt();
                return;
              }

              if (msg.action === "finish") {
                // Flush any buffered tool events (no permission_ask came)
                shed();
                // Emit text-end / reasoning-end before finish
                if (textStarted) {
                  petal({ type: "text-end", id: textId } as LanguageModelV2StreamPart);
                }
                if (reasoningStarted) {
                  petal({ type: "reasoning-end", id: reasoningId } as LanguageModelV2StreamPart);
                }
                const u = msg.usage as Record<string, unknown> | undefined;
                const cacheRead = (u?.cache_read_input_tokens ?? 0) as number;
                const cacheWrite = (u?.cache_creation_input_tokens ?? 0) as number;
                const inputBase = (u?.input_tokens ?? u?.inputTokens ?? 0) as number;
                const fr = tendrils.size > 0
                  ? "tool-calls"
                  : (msg.finishReason ?? "stop");
                petal({
                  type: "finish",
                  finishReason: fr as LanguageModelV2FinishReason,
                  usage: {
                    inputTokens: inputBase + cacheRead + cacheWrite,
                    outputTokens: (u?.output_tokens ?? u?.outputTokens) as number | undefined,
                    totalTokens: undefined,
                    // OC reads cachedInputTokens for cache read
                    cachedInputTokens: cacheRead,
                  },
                  providerMetadata: {
                    ...((msg.providerMetadata ?? {}) as Record<string, unknown>),
                    // OC reads anthropic.cacheCreationInputTokens for cache write
                    anthropic: { cacheCreationInputTokens: cacheWrite },
                  },
                } as LanguageModelV2StreamPart);
                wilt();
                return;
              }

              if (msg.action === "error") {
                petal({ type: "error", error: new Error(msg.message) } as LanguageModelV2StreamPart);
                wilt();
                return;
              }
        } // end onHummin

        try {
          await humFade;
        } catch (e) {
          petal({ type: "error", error: new Error(String(e)) } as LanguageModelV2StreamPart);
          wilt();
        }
      },

      cancel() {
        // Don't send destroy — daemon manages session lifecycle for --resume.
      },
    });

    return {
      stream: bloom,
      rawCall: { raw: { text }, rawHeaders: {} },
      warnings,
    };
  }
}

// Shared client — set by the plugin on init, used as fallback when the
// provider loader calls createClwnd() without args.
let sharedClient: any = null;
export function setSharedClient(client: any): void { sharedClient = client; }

export function createClwnd(config: ClwndConfig = {}) {
  if (!config.client && sharedClient) config = { ...config, client: sharedClient };
  const fn = (modelId: string): LanguageModelV2 => new ClwndModel(modelId, config);
  fn.languageModel = (modelId: string) => new ClwndModel(modelId, config);
  return fn;
}
