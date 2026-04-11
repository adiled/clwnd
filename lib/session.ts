/**
 * Shared session library — transforms between OpenCode sessions and
 * Claude CLI JSONL persistence. Both daemon and plugin import from here.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { randomUUID } from "crypto";
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
  lastPetal: string | null; // uuid of last synced JSONL entry
}

// ─── Graft ────────────────────────────────────────────────────────────────
// UUID-anchored + count-based. No text hashing, no exclusion rules.
//
// Merge-base: count completed turns in JSONL and priorPetals.
// If JSONL has fewer turns, graft the tail from priorPetals.
// lastSyncedPetal (uuid) is set after each turn for observability
// but the graft decision is purely count-based.

/** Count completed turns: a user message followed by at least one non-user message */
function countTurns(messages: Array<{ role: string }>): number {
  let turns = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i + 1 < messages.length && messages[i + 1].role !== "user") {
      turns++;
    }
  }
  return turns;
}

/** Count completed turns in JSONL — only user entries with text content count */
function countJsonlTurns(entries: ClaudeEntry[]): number {
  let turns = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type !== "user" || !("message" in entries[i])) continue;
    const hasText = (entries[i] as ClaudeUserEntry).message.content.some(c => c.type === "text");
    if (!hasText) continue;
    // Must be followed by an assistant entry
    for (let j = i + 1; j < entries.length; j++) {
      if (entries[j].type === "assistant") { turns++; break; }
      if (entries[j].type === "user") break;
    }
  }
  return turns;
}

/** Skip N turns in a message array, return the index after the Nth turn's last non-user */
function skipTurns(messages: Array<{ role: string }>, n: number): number {
  if (n <= 0) return 0;
  let skipped = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && i + 1 < messages.length && messages[i + 1].role !== "user") {
      skipped++;
      if (skipped >= n) {
        let j = i + 1;
        while (j < messages.length && messages[j].role !== "user") j++;
        return j;
      }
    }
  }
  return messages.length;
}

export function graft(
  priorPetals: Array<{ role: string; content: unknown }>,
  jsonlPath: string,
  sessionId: string,
  cwd: string,
  lastSyncedPetal?: string | null,
): GraftResult {
  // Strip system messages and trailing user — murmur handles the current prompt
  const conversation = priorPetals.filter(m => m.role !== "system");
  const history = conversation.length > 0 && conversation[conversation.length - 1].role === "user"
    ? conversation.slice(0, -1)
    : conversation;
  if (history.length === 0 || history.every(m => m.role === "user")) {
    return { grafted: 0, lastPetal: lastSyncedPetal ?? lastUuid(jsonlPath) };
  }

  const existing = readEntries(jsonlPath);

  // Count user-text messages (not tool_results) — same filter both sides
  const jUsers = countJsonlTurns(existing);
  const pUsers = countTurns(history);
  // existing is ClaudeEntry[] — a tagged union where some members (e.g.
  // ClaudeLastPrompt) don't declare `uuid`. All the real-on-disk entries do
  // carry one; we probe it opaquely via the double cast rather than adding
  // `uuid` to every member of the union for one lookup.
  const anchored = lastSyncedPetal && existing.some(e => (e as unknown as { uuid?: string }).uuid === lastSyncedPetal);

  // Synced: anchor valid AND JSONL covers all prompt turns
  if (anchored && jUsers >= pUsers) {
    trace("graft.synced", { anchor: lastSyncedPetal, jUsers, pUsers });
    return { grafted: 0, lastPetal: lastSyncedPetal };
  }

  // No gap: JSONL has enough turns even without anchor
  if (jUsers >= pUsers) {
    trace("graft.noop", { jUsers, pUsers });
    return { grafted: 0, lastPetal: lastUuid(jsonlPath) };
  }

  // Gap: skip past what JSONL already has, graft the rest
  const deltaStart = skipTurns(history, jUsers);
  const delta = history.slice(deltaStart);

  trace("graft.delta", { jUsers, pUsers, deltaStart, deltaLen: delta.length, roles: delta.map(m => m.role).join(",") });

  if (delta.length === 0 || delta.every(m => m.role === "user")) {
    return { grafted: 0, lastPetal: lastUuid(jsonlPath) };
  }

  fromPrompt(jsonlPath, sessionId, delta, cwd);
  const count = delta.filter(m => m.role === "assistant").length;
  return { grafted: count, lastPetal: lastUuid(jsonlPath) };
}

// ─── JSONL Sanitizer ──────────────────────────────────────────────────────
// Runs before every --resume. Fixes structural violations that cause
// "API Error: 400 due to tool use concurrency issues".

export interface SanitizeResult {
  removed: number;
  fixed: number;
  rules: string[];
}

export function sanitizeJsonl(path: string): SanitizeResult {
  let entries: ClaudeEntry[];
  try { entries = readEntries(path); } catch { return { removed: 0, fixed: 0, rules: [] }; }
  if (entries.length === 0) return { removed: 0, fixed: 0, rules: [] };

  const rules: string[] = [];
  const original = entries.length;
  let clean: ClaudeEntry[] = [];

  // Pass 1: filter out ghosts, API errors, fix empty tool_results
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const next = entries[i + 1];

    // Rule 2: skip ghost pairs ("Continue from where you left off" + "No response requested")
    if (e.type === "user" && "message" in e) {
      const text = (e as ClaudeUserEntry).message.content
        .filter(c => c.type === "text").map(c => (c as ClaudeContentText).text).join("");
      if (text.trim() === "Continue from where you left off." && next?.type === "assistant") {
        const nextText = "message" in next
          ? (next as ClaudeAssistantEntry).message.content
              .filter(c => c.type === "text").map(c => (c as ClaudeContentText).text).join("")
          : "";
        if (nextText.includes("No response requested")) {
          rules.push("ghost");
          i++; // skip both
          continue;
        }
      }
    }

    // Rule 3: skip API error entries
    if (e.type === "assistant" && "message" in e) {
      const text = (e as ClaudeAssistantEntry).message.content
        .filter(c => c.type === "text").map(c => (c as ClaudeContentText).text).join("");
      if (text.includes("API Error:")) {
        rules.push("api-error");
        continue;
      }
    }

    // Rule 6: fix empty tool_results
    if (e.type === "user" && "message" in e) {
      const content = (e as ClaudeUserEntry).message.content;
      let fixed = false;
      for (const c of content) {
        if (c.type === "tool_result") {
          const tr = c as ClaudeContentToolResult;
          if (!tr.content || tr.content === "" || tr.content === "[Old tool result content cleared]") {
            tr.content = "(tool result unavailable)";
            fixed = true;
          }
        }
      }
      if (fixed) rules.push("empty-result");
    }

    clean.push(e);
  }

  // Pass 2: remove trailing incomplete turn (assistant with tool_use, no following tool_result)
  while (clean.length > 0) {
    const last = clean[clean.length - 1];
    if (last.type === "assistant" && "message" in last) {
      const hasToolUse = (last as ClaudeAssistantEntry).message.content
        .some(c => c.type === "tool_use");
      if (hasToolUse) {
        clean.pop();
        rules.push("trailing-tool-use");
        continue;
      }
    }
    // Also remove trailing last-prompt, queue-operation
    if (last.type === "last-prompt" || last.type === "queue-operation") {
      clean.pop();
      continue;
    }
    break;
  }

  // Pass 2.5: coalesce runs of consecutive pure-tool_result user entries into
  // one. Claude CLI and OC both inject their own user entries mid-stream
  // (system-reminders, ghosts, etc.), so the same assistant turn's tool_results
  // sometimes land as multiple adjacent user entries in the JSONL. Pass 3 only
  // inspects clean[i+1] when validating tool_use/tool_result pairing — a split
  // would make it see a subset of the expected ids and delete the whole turn.
  // Fixing at the source isn't possible (we don't control Claude/OC's writers);
  // the sanitizer is the right layer.
  const merged: ClaudeEntry[] = [];
  for (let i = 0; i < clean.length; i++) {
    const e = clean[i];
    const isPureToolResult = (entry: ClaudeEntry): boolean =>
      entry.type === "user" && "message" in entry &&
      (entry as ClaudeUserEntry).message.content.every(c => c.type === "tool_result");

    if (isPureToolResult(e)) {
      const anchor = e as ClaudeUserEntry;
      // Greedily absorb every adjacent pure-tool_result user entry.
      while (i + 1 < clean.length && isPureToolResult(clean[i + 1])) {
        const next = clean[i + 1] as ClaudeUserEntry;
        anchor.message.content = [...anchor.message.content, ...next.message.content];
        rules.push("merge-tool-results");
        i++;
      }
      merged.push(anchor);
      continue;
    }
    merged.push(e);
  }

  // Pass 3: validate tool_use/tool_result pairing
  const validated: ClaudeEntry[] = [];
  for (let i = 0; i < merged.length; i++) {
    const e = merged[i];

    if (e.type === "assistant" && "message" in e) {
      const toolUseIds = (e as ClaudeAssistantEntry).message.content
        .filter(c => c.type === "tool_use")
        .map(c => (c as ClaudeContentToolUse).id);

      if (toolUseIds.length > 0) {
        // Find the next user entry with tool_results
        const nextUser = merged[i + 1];
        if (nextUser?.type === "user" && "message" in nextUser) {
          const resultIds = new Set(
            (nextUser as ClaudeUserEntry).message.content
              .filter(c => c.type === "tool_result")
              .map(c => (c as ClaudeContentToolResult).tool_use_id)
          );
          const allMatched = toolUseIds.every(id => resultIds.has(id));
          if (!allMatched) {
            // Mismatch — remove both
            rules.push("tool-mismatch");
            i++; // skip the user entry too
            continue;
          }
        } else {
          // No user entry following tool_use — dangling. (Any ClaudeUserEntry
          // with type "user" is guaranteed to have "message" by construction,
          // so the previous branch fully covers the "user-with-results" case.)
          rules.push("dangling-tool-use");
          continue;
        }
      }
    }

    validated.push(e);
  }

  if (rules.length === 0) return { removed: 0, fixed: 0, rules: [] };

  // Pass 4: relink the uuid chain. Every removal/merge in Passes 1-3 leaves
  // downstream entries with parentUuid pointing at an entry that no longer
  // exists, and the summary's leafUuid pointing at a removed tip. Claude CLI
  // walks leafUuid → parentUuid back to the root on --resume; a dangling
  // pointer makes it refuse to continue the session. Re-sequence the chain
  // linearly across surviving entries and fix leafUuid at the tail.
  let summary: Record<string, unknown> | null = null;
  const contents: Array<Record<string, unknown>> = [];
  for (const e of validated) {
    const rec = e as unknown as Record<string, unknown>;
    if (rec.type === "summary") summary = rec;
    else contents.push(rec);
  }
  let prevUuid: string | null = null;
  for (const rec of contents) {
    if (typeof rec.uuid === "string") {
      if ("parentUuid" in rec) rec.parentUuid = prevUuid;
      prevUuid = rec.uuid as string;
    }
  }
  if (summary) summary.leafUuid = prevUuid;
  if (prevUuid !== null || contents.length === 0) rules.push("relink");

  // Write back
  writeFileSync(path, validated.map(e => JSON.stringify(e)).join("\n") + "\n");
  return { removed: original - validated.length, fixed: rules.length, rules: [...new Set(rules)] };
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
