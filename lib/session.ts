/**
 * Shared session library — transforms between OpenCode sessions and
 * Claude CLI JSONL persistence. Both daemon and plugin import from here.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { randomUUID } from "crypto";
import type { Message, Part, TextPart, ToolPart, ToolStateCompleted } from "@opencode-ai/sdk";
import { createOpencodeClient } from "@opencode-ai/sdk";
import { trace } from "../log.ts";

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

// ─── OC Client Type ────────────────────────────────────────────────────────

export type OcClient = ReturnType<typeof createOpencodeClient>;

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

const CLWND_META = { userType: "external", entrypoint: "sdk-cli", version: "2.1.80", gitBranch: "main" } as const;

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
    ...CLWND_META,
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
    ...CLWND_META,
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
// Sequential timestamps 10s apart — prevents --resume ghost generation.

function makeTimestamps(count: number): () => string {
  const base = Date.now() - count * 10_000;
  let idx = 0;
  return () => new Date(base + (idx++) * 10_000).toISOString();
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
  const ts = makeTimestamps(history.length);

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

export async function graft(
  ocClient: OcClient,
  ocSessionId: string,
  sinceId: string | null,
  upToId: string | null,
  jsonlPath: string,
  sessionId: string,
  cwd: string,
): Promise<GraftResult> {
  const resp = await ocClient.session.messages({ path: { id: ocSessionId } });
  const ocData = (resp.data ?? []) as Array<{
    info: Message & { id: string; summary?: boolean; parentID?: string };
    parts: Part[];
  }>;

  // Separate user and assistant messages, index by ID
  interface OcEntry { id: string; content: ClaudeContent[]; toolResults: ClaudeContent[] }
  const userMsgs = new Map<string, OcEntry>();
  const assistantMsgs: Array<{ id: string; parentId: string; content: ClaudeContent[]; toolResults: ClaudeContent[] }> = [];

  for (const m of ocData) {
    if (m.info.role === "assistant" && m.info.summary) continue;
    if (m.parts.every(p => p.type === "compaction" || p.type === "step-start" || p.type === "step-finish")) continue;

    if (m.info.role === "user") {
      const content: ClaudeContent[] = [];
      for (const p of m.parts) {
        if (p.type === "text") content.push({ type: "text", text: (p as TextPart).text });
      }
      if (content.length > 0) userMsgs.set(m.info.id, { id: m.info.id, content, toolResults: [] });

    } else if (m.info.role === "assistant" && m.info.parentID) {
      // Skip in-flight responses — only graft completed petals
      const time = (m.info as unknown as { time?: { completed?: number } }).time;
      if (!time?.completed) continue;
      // Skip clwnd's own turns — already in the JSONL via Claude CLI
      const providerID = (m.info as unknown as { providerID?: string }).providerID;
      if (providerID?.startsWith("opencode-clwnd")) continue;
      const content: ClaudeContent[] = [];
      const toolResults: ClaudeContent[] = [];
      for (const p of m.parts) {
        if (p.type === "text") {
          content.push({ type: "text", text: (p as TextPart).text });
        } else if (p.type === "tool") {
          const tp = p as ToolPart;
          content.push({
            type: "tool_use",
            id: tp.callID,
            name: tp.tool,
            input: (tp.state as { input?: Record<string, unknown> }).input ?? {},
          });
          if (tp.state.status === "completed") {
            toolResults.push({
              type: "tool_result",
              tool_use_id: tp.callID,
              content: (tp.state as ToolStateCompleted).output,
            });
          }
        }
      }
      if (content.length > 0) {
        assistantMsgs.push({ id: m.info.id, parentId: m.info.parentID, content, toolResults });
      }
    }
  }

  // Pair into complete petals: user + assistant linked by parentID
  interface CompletePetal {
    userId: string;
    assistantId: string;
    userContent: ClaudeContent[];
    assistantContent: ClaudeContent[];
    toolResults: ClaudeContent[];
  }
  const petals: CompletePetal[] = [];
  const pairedUsers = new Set<string>();
  for (const asst of assistantMsgs) {
    const user = userMsgs.get(asst.parentId);
    if (!user) continue; // orphaned assistant — skip
    if (pairedUsers.has(user.id)) continue; // already paired — skip duplicate
    pairedUsers.add(user.id);
    petals.push({
      userId: user.id,
      assistantId: asst.id,
      userContent: user.content,
      assistantContent: asst.content,
      toolResults: asst.toolResults,
    });
  }

  // Slice by assistant IDs: after sinceId (non-inclusive), up to upToId (inclusive)
  let startIdx = 0;
  if (sinceId) {
    const idx = petals.findIndex(p => p.assistantId === sinceId);
    startIdx = idx >= 0 ? idx + 1 : 0;
  }
  let endIdx = petals.length;
  if (upToId) {
    const idx = petals.findIndex(p => p.assistantId === upToId);
    if (idx >= 0) endIdx = idx + 1;
  }

  trace("graft.paired", { ocMessages: ocData.length, users: userMsgs.size, completedAssistants: assistantMsgs.length, petals: petals.length, sinceId: sinceId ?? "null", startIdx, endIdx: petals.length });

  const slice = petals.slice(startIdx, endIdx);
  trace("graft.sliced", { count: slice.length, startIdx, endIdx });
  if (slice.length === 0) return { grafted: 0, lastPetal: sinceId ? null : null };

  // Append to existing JSONL
  let parentUuid = lastUuid(jsonlPath);
  const entryCount = slice.length * 2 + slice.filter(p => p.toolResults.length > 0).length;
  const ts = makeTimestamps(entryCount);
  let grafted = 0;

  for (const petal of slice) {
    trace("graft.petal", { userId: petal.userId, assistantId: petal.assistantId, userText: petal.userContent[0]?.type === "text" ? (petal.userContent[0] as ClaudeContentText).text.slice(0, 60) : "?" });
    // User message
    parentUuid = writeUserEntry(jsonlPath, {
      parentUuid, sessionId, timestamp: ts(), content: petal.userContent, cwd,
    });
    // Assistant response
    parentUuid = writeAssistantEntry(jsonlPath, {
      parentUuid, sessionId, timestamp: ts(), content: petal.assistantContent, cwd,
    });
    // Tool results (as user entry in Claude JSONL format)
    if (petal.toolResults.length > 0) {
      parentUuid = writeUserEntry(jsonlPath, {
        parentUuid, sessionId, timestamp: ts(), content: petal.toolResults, cwd,
      });
    }
    grafted++;
  }

  if (parentUuid) updateLeafUuid(jsonlPath, parentUuid);

  const last = slice[slice.length - 1];
  return { grafted, lastPetal: [last.userId, last.assistantId] };
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
