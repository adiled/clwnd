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

const BROKERED_TOOLS = new Set(["webfetch", "websearch", "todowrite"]);

const INPUT_FIELD_MAP: Record<string, Record<string, string>> = {
  read:  { file_path: "filePath" },
  edit:  { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  write: { file_path: "filePath" },
  bash:  {},
  glob:  {},
  grep:  {},
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
let humHearer: HumListener | null = null;
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
          if (humHearer) humHearer(msg);
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
        // Strip repeated system reminders
        if (sessionId) {
          for (let j = parts.length - 1; j >= 0; j--) {
            if (parts[j].type !== "text") continue;
            const reminder = (parts[j] as { text: string }).text.match(/<system-reminder>[\s\S]*?<\/system-reminder>/)?.[0];
            if (reminder) {
              const prev = lastReminder.get(sessionId);
              if (prev === reminder) {
                const stripped = (parts[j] as { type: "text"; text: string }).text.replace(reminder, "").trim();
                if (stripped) { parts[j] = { type: "text", text: stripped }; }
                else { parts.splice(j, 1); }
                trace("reminder.stripped", { sid: sessionId });
              } else {
                lastReminder.set(sessionId, reminder);
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

// ─── Detection Helpers ───────────────────────────────────────────────────

function isAuxiliaryCall(opts: LanguageModelV3CallOptions): boolean {
  return !opts.tools || !Array.isArray(opts.tools) || opts.tools.length === 0;
}

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

const OC_TO_MCP: Record<string, string> = {
  read: "read", edit: "edit", write: "write", bash: "bash",
  glob: "glob", grep: "grep", apply_patch: "edit", webfetch: "webfetch",
};

const lastAllowedTools = new Map<string, string>();

const AGENT_DENY: Record<string, Set<string>> = {
  plan: new Set(["edit", "write"]),
};

function deriveAllowedTools(sid: string, opts: LanguageModelV3CallOptions): string[] {
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
    if (isAuxiliaryCall(opts)) {
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
    const content = extractContent(opts.prompt, sid);
    const text = content.filter((p): p is { type: "text"; text: string } => p.type === "text").map(p => p.text).join("\n\n");
    const systemPrompt = extractSystemPrompt(opts.prompt);
    detectAgent(sid, opts.headers);
    const cwd = (this.config.client ? await getSessionDirectory(this.config.client, sid) : null) ?? this.config.cwd ?? process.cwd();
    const self = this;
    const sap = new Map<string, string>();
    const permissions = await getSessionPermissions(this.config.client, sid);
    const allowedTools = deriveAllowedTools(sid, opts);

    // Auxiliary — empty response
    if (isAuxiliaryCall(opts) && !loadConfig().ocCompaction) {
      trace("auxiliary.reject", { method: "doStream" });
      return {
        stream: new ReadableStream<LanguageModelV3StreamPart>({
          start(controller) {
            controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: zeroUsage() });
            controller.close();
          },
        }),
      };
    }

    // Brokered tool return — finish immediately unless permission return
    if (isBrokeredToolReturn(opts.prompt)) {
      trace("brokered.return", { sid });
      let isPermissionReturn = false;
      const lastTool = opts.prompt.findLast(m => m.role === "tool");
      if (lastTool && Array.isArray(lastTool.content)) {
        for (const part of lastTool.content) {
          if (part.type === "tool-result" && part.toolCallId?.startsWith("perm-")) {
            isPermissionReturn = true;
          }
        }
      }
      if (!isPermissionReturn) {
        return {
          stream: new ReadableStream<LanguageModelV3StreamPart>({
            start(controller) {
              controller.enqueue({ type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: zeroUsage() });
              controller.close();
            },
          }),
        };
      }
    }

    const listenOnly = isBrokeredToolReturn(opts.prompt) && (() => {
      const lt = opts.prompt.findLast(m => m.role === "tool");
      return lt && Array.isArray(lt.content) && lt.content.some(p => p.type === "tool-result" && p.toolCallId?.startsWith("perm-"));
    })();

    // Include prior petals — daemon compares with JSONL state and grafts only what's new
    const priorPetals = opts.prompt.filter(m => m.role === "user" || m.role === "assistant" || m.role === "tool");
    trace("priorPetals", { sid, count: priorPetals.length, roles: priorPetals.map(m => m.role).join(",") });

    // Send prompt before creating stream — survives OC plugin reload
    let promptSent = false;
    if (!listenOnly && humAlive) {
      hum({
        chi: "prompt", sid, cwd,
        modelId: self.modelId,
        content, text, systemPrompt,
        permissions, allowedTools, listenOnly,
        ocServerUrl: self.config.pluginInput?.serverUrl?.toString(),
        priorPetals,
        dusk: duskIn(30_000),
      });
      promptSent = true;
    }

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        let done = false;
        const tendrils = new Set<string>();
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

        const humFade = humHear(onHummin);
        if (!promptSent) {
          hum({
            chi: "prompt", sid, cwd,
            modelId: self.modelId,
            content, text, systemPrompt,
            permissions, allowedTools, listenOnly,
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

            // Tool events — buffer until we know if permission_ask follows
            if (ct === "tool_input_start" && raw.toolCallId && raw.toolName) {
              sap.set(raw.toolCallId as string, "");
              buds.push({ type: "tool-input-start", id: raw.toolCallId as string, toolName: mapToolName(raw.toolName as string) });
            }
            if (ct === "tool_input_delta" && raw.toolCallId && raw.partialJson) {
              const prev = sap.get(raw.toolCallId as string) ?? "";
              sap.set(raw.toolCallId as string, prev + raw.partialJson);
              buds.push({ type: "tool-input-delta", id: raw.toolCallId as string, delta: raw.partialJson as string });
            }
            if (ct === "tool_call" && raw.toolCallId && raw.toolName) {
              const ocToolName = mapToolName(raw.toolName as string);
              if (!sap.has(raw.toolCallId as string)) {
                buds.push({ type: "tool-input-start", id: raw.toolCallId as string, toolName: ocToolName });
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
              const isBrokered = BROKERED_TOOLS.has(ocToolName);
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
