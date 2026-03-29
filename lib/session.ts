/**
 * Shared session library — transforms between OpenCode sessions and
 * Claude CLI JSONL persistence. Both daemon and plugin import from here.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { randomUUID, createHash } from "crypto";
import { Database as BunDatabase } from "bun:sqlite";
import { trace } from "../log.ts";
import { join } from "path";

// ─── Claude CLI JSONL Types ────────────────────────────────────────────────
// Accurate to real JSONL files written by Claude CLI 2.1.86+.

export interface ClaudeContentText { type: "text"; text: string }
export interface ClaudeContentThinking { type: "thinking"; thinking: string; signature: string }
export interface ClaudeContentToolUse {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
  caller?: { type: string };
}
export interface ClaudeContentToolResult {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}
export type ClaudeContent = ClaudeContentText | ClaudeContentThinking | ClaudeContentToolUse | ClaudeContentToolResult;

export interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use?: { web_search_requests: number; web_fetch_requests: number };
  service_tier?: string;
  cache_creation?: { ephemeral_1h_input_tokens: number; ephemeral_5m_input_tokens: number };
  inference_geo?: string;
  iterations?: unknown[];
  speed?: string;
}

interface ClaudeEntryBase {
  uuid: string;
  timestamp: string;
  sessionId: string;
  parentUuid: string | null;
  isSidechain: boolean;
  userType: string;
  entrypoint: string;
  cwd: string;
  version?: string;
  gitBranch?: string;
}

export interface ClaudeUserEntry extends ClaudeEntryBase {
  type: "user";
  promptId: string;
  message: { role: "user"; content: ClaudeContent[] };
  permissionMode: string;
  toolUseResult?: Record<string, unknown>;
  sourceToolAssistantUUID?: string;
}

export interface ClaudeAssistantEntry extends ClaudeEntryBase {
  type: "assistant";
  requestId: string;
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: ClaudeContent[];
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: ClaudeUsage;
  };
}

export interface ClaudeSummaryEntry {
  type: "summary";
  summary: string;
  leafUuid: string | null;
  sessionId: string;
  timestamp: string;
}

export interface ClaudeQueueOperation {
  type: "queue-operation";
  operation: string;
  timestamp: string;
  sessionId: string;
}

export interface ClaudeLastPrompt {
  type: "last-prompt";
  lastPrompt: string;
  sessionId: string;
}

export type ClaudeEntry = ClaudeUserEntry | ClaudeAssistantEntry | ClaudeSummaryEntry | ClaudeQueueOperation | ClaudeLastPrompt;

// ─── OC Database ──────────────────────────────────────────────────────────

const OC_DATA = process.env.XDG_DATA_HOME
  ? join(process.env.XDG_DATA_HOME, "opencode")
  : join(process.env.HOME ?? "/", ".local", "share", "opencode");
const OC_DB_PATH = join(OC_DATA, "opencode.db");

interface OcMessageRow { id: string; session_id: string; data: string }
interface OcPartRow { id: string; message_id: string; data: string }

interface OcMessageInfo {
  role: "user" | "assistant";
  parentID?: string;
  providerID?: string;
  modelID?: string;
  summary?: boolean;
  time?: { created?: number; completed?: number };
}

interface OcPartData {
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: { status?: string; input?: Record<string, unknown>; output?: string };
}

export function readOcMessages(sessionId: string): Array<{ info: OcMessageInfo & { id: string }; parts: OcPartData[] }> {
  if (!existsSync(OC_DB_PATH)) {
    trace("oc.db.missing", { path: OC_DB_PATH });
    return [];
  }
  const db = new BunDatabase(OC_DB_PATH, { readonly: true });
  try {
    const msgs = db.query<OcMessageRow, [string]>(
      "SELECT id, session_id, data FROM message WHERE session_id = ? ORDER BY time_created, id"
    ).all(sessionId);

    const msgIds = msgs.map(m => m.id);
    const partsByMsg = new Map<string, OcPartData[]>();
    if (msgIds.length > 0) {
      const placeholders = msgIds.map(() => "?").join(",");
      const parts = db.query<OcPartRow, string[]>(
        `SELECT id, message_id, data FROM part WHERE message_id IN (${placeholders}) ORDER BY message_id, id`
      ).all(...msgIds);
      for (const p of parts) {
        const parsed = JSON.parse(p.data) as OcPartData;
        const list = partsByMsg.get(p.message_id);
        if (list) list.push(parsed);
        else partsByMsg.set(p.message_id, [parsed]);
      }
    }

    return msgs.map(m => ({
      info: { ...JSON.parse(m.data) as OcMessageInfo, id: m.id },
      parts: partsByMsg.get(m.id) ?? [],
    }));
  } finally {
    db.close();
  }
}

// ─── Path Resolution ───────────────────────────────────────────────────────

const CLAUDE_BASE = `${process.env.HOME}/.claude`;

export function cwdHash(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+$/g, "");
}

export function sessionDir(cwd: string): string {
  return `${CLAUDE_BASE}/projects/${cwdHash(cwd)}`;
}

export function sessionPath(cwd: string, id: string): string {
  return `${sessionDir(cwd)}/${id}.jsonl`;
}

// ─── JSONL Operations ──────────────────────────────────────────────────────

export function createSession(cwd: string, id: string): string {
  const dir = sessionDir(cwd);
  const path = sessionPath(cwd, id);
  try { mkdirSync(dir, { recursive: true }); } catch {}
  const summary: ClaudeSummaryEntry = {
    type: "summary",
    summary: "clwnd session",
    leafUuid: null,
    sessionId: id,
    timestamp: new Date().toISOString(),
  };
  writeFileSync(path, JSON.stringify(summary) + "\n");
  return path;
}

export function appendEntry(path: string, record: Record<string, unknown>): string {
  const uuid = randomUUID();
  const entry = { uuid, timestamp: new Date().toISOString(), ...record };
  appendFileSync(path, JSON.stringify(entry) + "\n");
  return uuid;
}

export function lastUuid(path: string): string | null {
  try {
    const lines = readFileSync(path, "utf-8").trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const e = JSON.parse(lines[i]);
        if (e.uuid) return e.uuid as string;
      } catch {}
    }
  } catch {}
  return null;
}

export function readEntries(path: string): ClaudeEntry[] {
  try {
    return readFileSync(path, "utf-8").trim().split("\n")
      .filter(Boolean)
      .map((l: string) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as ClaudeEntry[];
  } catch {
    return [];
  }
}

// ─── Shared Entry Writers ──────────────────────────────────────────────────
// Used by both fromPrompt() and graft(). No duplication.

const metaCache = new Map<string, { userType: string; entrypoint: string; version: string; gitBranch: string }>();

function clwndMeta(path?: string): { userType: string; entrypoint: string; version: string; gitBranch: string } {
  if (!path) return { userType: "external", entrypoint: "sdk-cli", version: "2.1.86", gitBranch: "main" };
  const cached = metaCache.get(path);
  if (cached) return cached;
  let version = "2.1.86";
  let gitBranch = "main";
  const entries = readEntries(path);
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as unknown as Record<string, unknown>;
    if (typeof e.version === "string" && e.version) { version = e.version; }
    if (typeof e.gitBranch === "string" && e.gitBranch) { gitBranch = e.gitBranch; }
    if (version !== "2.1.86") break; // found a real entry
  }
  const meta = { userType: "external", entrypoint: "sdk-cli", version, gitBranch };
  metaCache.set(path, meta);
  return meta;
}

const ZERO_USAGE: ClaudeUsage = {
  input_tokens: 0, output_tokens: 0,
  cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
  service_tier: "standard",
  cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
  inference_geo: "", iterations: [], speed: "standard",
};

function writeUserEntry(path: string, opts: {
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  content: ClaudeContent[];
  cwd: string;
  permissionMode?: string;
}): string {
  return appendEntry(path, {
    type: "user",
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    isSidechain: false,
    timestamp: opts.timestamp,
    promptId: randomUUID(),
    message: { role: "user", content: opts.content },
    permissionMode: opts.permissionMode ?? "default",
    ...clwndMeta(path),
    cwd: opts.cwd,
  });
}

function writeAssistantEntry(path: string, opts: {
  parentUuid: string | null;
  sessionId: string;
  timestamp: string;
  content: ClaudeContent[];
  cwd: string;
  model?: string;
  stopReason?: string;
}): string {
  return appendEntry(path, {
    type: "assistant",
    parentUuid: opts.parentUuid,
    sessionId: opts.sessionId,
    isSidechain: false,
    timestamp: opts.timestamp,
    requestId: `req_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
    message: {
      model: opts.model ?? "claude-sonnet-4-5-20250929",
      id: `msg_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      type: "message",
      role: "assistant",
      content: opts.content,
      stop_reason: opts.stopReason ?? "end_turn",
      stop_sequence: null,
      usage: ZERO_USAGE,
    },
    ...clwndMeta(path),
    cwd: opts.cwd,
  });
}

function updateLeafUuid(path: string, uuid: string): void {
  const lines = readFileSync(path, "utf-8").trim().split("\n");
  if (lines.length > 0) {
    const summary = JSON.parse(lines[0]) as ClaudeSummaryEntry;
    summary.leafUuid = uuid;
    lines[0] = JSON.stringify(summary);
    writeFileSync(path, lines.join("\n") + "\n");
  }
}

// ─── Timestamp Generator ───────────────────────────────────────────────────
// Grafted entries must have timestamps AFTER existing JSONL entries.
// Claude CLI resolves chain tip by timestamp — older entries become sidechains.

function makeTimestamps(count: number, afterPath?: string): () => string {
  let base: number;
  if (afterPath) {
    const entries = readEntries(afterPath);
    let latest = 0;
    for (const e of entries) {
      const ts = (e as unknown as Record<string, unknown>).timestamp;
      if (typeof ts === "string") {
        const t = new Date(ts).getTime();
        if (t > latest) latest = t;
      }
    }
    base = latest > 0 ? latest + 1000 : Date.now() - count * 1000;
  } else {
    base = Date.now() - count * 1000;
  }
  let idx = 0;
  return () => new Date(base + (idx++) * 1000).toISOString();
}

// ─── AI SDK Prompt → Claude JSONL ──────────────────────────────────────────
// Converts LanguageModelV2Prompt messages into Claude CLI JSONL entries.
// Used for cold-start seeding when no existing JSONL exists.

export function fromPrompt(
  path: string,
  sessionId: string,
  history: Array<{ role: string; content: unknown }>,
  cwd: string,
): void {
  let parentUuid: string | null = lastUuid(path);
  const ts = makeTimestamps(history.length, path);

  for (const msg of history) {
    const raw = msg.content;

    if (msg.role === "user") {
      const content: ClaudeContent[] = [];
      if (typeof raw === "string") {
        content.push({ type: "text", text: raw });
      } else if (Array.isArray(raw)) {
        for (const p of raw as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) content.push({ type: "text", text: p.text as string });
        }
      }
      if (content.length === 0) continue;
      parentUuid = writeUserEntry(path, { parentUuid, sessionId, timestamp: ts(), content, cwd });

    } else if (msg.role === "assistant") {
      const content: ClaudeContent[] = [];
      if (typeof raw === "string") {
        if (raw) content.push({ type: "text", text: raw });
      } else if (Array.isArray(raw)) {
        for (const p of raw as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) {
            content.push({ type: "text", text: p.text as string });
          } else if (p.type === "tool-call" && p.toolCallId && p.toolName) {
            let input: Record<string, unknown> = {};
            try { input = typeof p.input === "string" ? JSON.parse(p.input as string) : (p.input as Record<string, unknown>) ?? {}; } catch {}
            content.push({ type: "tool_use", id: p.toolCallId as string, name: p.toolName as string, input });
          } else if (p.type === "reasoning") {
            continue; // skip — requires cryptographic signature
          }
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no text response)" });
      parentUuid = writeAssistantEntry(path, { parentUuid, sessionId, timestamp: ts(), content, cwd });

    } else if (msg.role === "tool") {
      const content: ClaudeContent[] = [];
      if (Array.isArray(raw)) {
        for (const p of raw as Array<Record<string, unknown>>) {
          if (p.type === "tool-result" && p.toolCallId) {
            const result = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
            content.push({ type: "tool_result", tool_use_id: p.toolCallId as string, content: result });
          }
        }
      }
      if (content.length === 0) continue;
      parentUuid = writeUserEntry(path, { parentUuid, sessionId, timestamp: ts(), content, cwd });
    }
  }

  if (parentUuid) updateLeafUuid(path, parentUuid);
}

// ─── Graft: splice OC session into existing Claude JSONL ───────────────────
//
// Reads OC session via SDK. Pairs user+assistant messages into complete petals
// using parentID. Only grafts complete petals — unpaired messages (like the
// current user prompt) are skipped. This prevents duplicates (murmur handles
// the current message) and ghosts (no orphaned user entries).
//
// sinceId: assistant message ID of the last synced petal (non-inclusive).
//          null = cold start, graft everything.
// upToId:  assistant message ID to stop at (inclusive). null = latest.
//
// Returns the last grafted petal as [userMsgId, assistantMsgId], or null.

export interface GraftResult {
  grafted: number;
  lastPetal: [string, string] | null; // [userMsgId, assistantMsgId]
}

// ─── Chain Hash ───────────────────────────────────────────────────────────
// Rolling hash over user messages only. Each link = hash(prevHash + userText).
// User messages are invariant — same text in both JSONL and priorPetals.
// Assistant responses differ (Claude writes its own formatting) — excluded.
// The tip hash encodes the exact sequence of all user messages.

function chainLink(prev: string, text: string): string {
  return createHash("sha256").update(prev + text).digest("hex").slice(0, 16);
}

function promptText(msg: { role: string; content: unknown }): string {
  const raw = msg.content;
  if (typeof raw === "string") return raw;
  if (!Array.isArray(raw)) return "";
  return (raw as Array<Record<string, unknown>>)
    .filter(p => p.type === "text" && p.text)
    .map(p => p.text as string)
    .join("");
}

/** Build user-only hash chain from AI SDK prompt. Returns [hashes, convIdx] pairs. */
function chainFromPrompt(history: Array<{ role: string; content: unknown }>): { hash: string; convIdx: number }[] {
  const chain: { hash: string; convIdx: number }[] = [];
  let prev = "0";
  for (let i = 0; i < history.length; i++) {
    if (history[i].role === "user") {
      prev = chainLink(prev, promptText(history[i]));
      chain.push({ hash: prev, convIdx: i });
    }
  }
  return chain;
}

/** Build user-only hash chain from Claude JSONL. */
function chainFromJSONL(entries: ClaudeEntry[]): string[] {
  const chain: string[] = [];
  let prev = "0";
  for (const e of entries) {
    if (e.type === "user" && "message" in e) {
      const text = (e as ClaudeUserEntry).message.content
        .filter(c => c.type === "text")
        .map(c => (c as ClaudeContentText).text)
        .join("");
      prev = chainLink(prev, text);
      chain.push(prev);
    }
  }
  return chain;
}

// ─── Graft ────────────────────────────────────────────────────────────────

export function graft(
  priorPetals: Array<{ role: string; content: unknown }>,
  jsonlPath: string,
  sessionId: string,
  cwd: string,
): GraftResult {
  // Strip system messages and trailing user — murmur handles the current prompt
  const conversation = priorPetals.filter(m => m.role !== "system");
  const history = conversation.length > 0 && conversation[conversation.length - 1].role === "user"
    ? conversation.slice(0, -1)
    : conversation;
  if (history.length === 0 || history.every(m => m.role === "user")) return { grafted: 0, lastPetal: null };

  // Build user-only hash chains
  const promptChain = chainFromPrompt(history);
  const existing = readEntries(jsonlPath);
  const jsonlChain = chainFromJSONL(existing);

  // Find merge-base: last JSONL tip in prompt chain
  let deltaStart = 0;
  if (jsonlChain.length > 0) {
    const tip = jsonlChain[jsonlChain.length - 1];
    for (let i = promptChain.length - 1; i >= 0; i--) {
      if (promptChain[i].hash === tip) {
        // Merge-base found at this user message in the conversation.
        // Skip past this user and its paired assistant.
        let skip = promptChain[i].convIdx + 1;
        // Skip the assistant(s) that follow the matched user
        while (skip < history.length && history[skip].role !== "user") skip++;
        deltaStart = skip;
        break;
      }
    }
  }

  const delta = history.slice(deltaStart);

  // Log delta content for debugging
  const deltaPreview = delta.slice(0, 4).map(m => {
    const t = promptText(m);
    return `${m.role}:${t.slice(0, 40)}`;
  }).join(" | ");

  trace("graft.chain", {
    promptUsers: promptChain.length,
    jsonlUsers: jsonlChain.length,
    deltaStart,
    deltaLen: delta.length,
    roles: delta.map(m => m.role).join(",") || "none",
    tip: jsonlChain.length > 0 ? jsonlChain[jsonlChain.length - 1] : "empty",
    delta: deltaPreview || "none",
  });

  if (delta.length === 0 || delta.every(m => m.role === "user")) return { grafted: 0, lastPetal: null };

  fromPrompt(jsonlPath, sessionId, delta, cwd);
  const count = delta.filter(m => m.role === "assistant").length;
  return { grafted: count, lastPetal: null };
}

// ─── JSONL → Messages ──────────────────────────────────────────────────────

export function toMessages(path: string): Array<{ role: string; content: ClaudeContent[] }> {
  const entries = readEntries(path);
  const messages: Array<{ role: string; content: ClaudeContent[] }> = [];
  for (const entry of entries) {
    if (entry.type === "user" && "message" in entry) {
      messages.push({ role: "user", content: (entry as ClaudeUserEntry).message.content });
    } else if (entry.type === "assistant" && "message" in entry) {
      messages.push({ role: "assistant", content: (entry as ClaudeAssistantEntry).message.content });
    }
  }
  return messages;
}
