/**
 * Shared session library — abstraction between Claude CLI's JSONL persistence
 * and OpenCode's prompt format. Both daemon and plugin import from here.
 */

import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync } from "fs";
import { randomUUID } from "crypto";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserEntry {
  type: "user";
  parentUuid: string | null;
  sessionId: string;
  uuid: string;
  timestamp: string;
  isSidechain: boolean;
  promptId: string;
  message: { role: "user"; content: Array<{ type: string; [key: string]: unknown }> };
  permissionMode: string;
  userType: string;
  entrypoint: string;
  cwd: string;
}

export interface AssistantEntry {
  type: "assistant";
  parentUuid: string | null;
  sessionId: string;
  uuid: string;
  timestamp: string;
  isSidechain: boolean;
  requestId: string;
  message: {
    model: string;
    id: string;
    type: "message";
    role: "assistant";
    content: Array<{ type: string; [key: string]: unknown }>;
    stop_reason: string | null;
    stop_sequence: string | null;
    usage: { input_tokens: number; output_tokens: number };
  };
  userType: string;
  entrypoint: string;
  cwd: string;
}

export interface SummaryEntry {
  type: "summary";
  summary: string;
  leafUuid: string | null;
  sessionId: string;
  timestamp: string;
}

export type Entry = UserEntry | AssistantEntry | SummaryEntry | { type: string; [key: string]: unknown };

// ─── Path Resolution ────────────────────────────────────────────────────────

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

// ─── JSONL Operations ───────────────────────────────────────────────────────

export function createSession(cwd: string, id: string): string {
  const dir = sessionDir(cwd);
  const path = sessionPath(cwd, id);
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

export function appendEntry(path: string, record: Record<string, unknown>): string {
  const uuid = randomUUID();
  const entry = { uuid, timestamp: new Date().toISOString(), ...record };
  if (!entry.uuid) entry.uuid = uuid; // ensure uuid even if record had one
  appendFileSync(path, JSON.stringify(entry) + "\n");
  return uuid;
}

export function lastUuid(path: string): string | null {
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

export function readEntries(path: string): Entry[] {
  try {
    return readFileSync(path, "utf-8").trim().split("\n")
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean) as Entry[];
  } catch {
    return [];
  }
}

// ─── Prompt → JSONL Conversion ──────────────────────────────────────────────
// Converts OC's LanguageModelV2Prompt messages into Claude CLI JSONL entries.
// Entries match Claude CLI's exact structure for --resume to accept them.

// Consolidate multi-turn history into a single user+assistant pair.
// Claude CLI's --resume generates ghost entries for multi-pair JSOSNLs.
// A single pair avoids this while preserving all conversation context.
function consolidate(history: Array<{ role: string; content: unknown }>): Array<{ role: string; content: unknown }> {
  const userParts: string[] = [];
  const assistantParts: string[] = [];

  for (const msg of history) {
    const contentArr = msg.content;
    let text = "";
    if (typeof contentArr === "string") {
      text = contentArr;
    } else if (Array.isArray(contentArr)) {
      const texts: string[] = [];
      for (const p of contentArr as Array<Record<string, unknown>>) {
        if (p.type === "text" && p.text) texts.push(p.text as string);
        else if (p.type === "tool-call" && p.toolName) texts.push(`[Used tool: ${p.toolName}]`);
        else if (p.type === "tool-result" && p.result) {
          const r = typeof p.result === "string" ? p.result : JSON.stringify(p.result);
          texts.push(`[Tool result: ${r.slice(0, 200)}]`);
        }
      }
      text = texts.join("\n");
    }
    if (!text) continue;

    if (msg.role === "user") userParts.push(text);
    else if (msg.role === "assistant") assistantParts.push(text);
    else if (msg.role === "tool") userParts.push(text);
  }

  if (userParts.length === 0) return history;

  return [
    { role: "user", content: userParts.join("\n\n") },
    { role: "assistant", content: assistantParts.length > 0
      ? assistantParts.join("\n\n")
      : "Understood." },
  ];
}

export function fromPrompt(
  sessionPath: string,
  sessionId: string,
  history: Array<{ role: string; content: unknown }>,
  cwd: string,
): void {
  // True multi-entry — each turn as its own JSONL entry.
  // Sequential timestamps + leafUuid prevent --resume ghost generation.
  let parentUuid: string | null = lastUuid(sessionPath);
  const baseTime = Date.now() - history.length * 10_000;
  let entryIdx = 0;
  const ts = () => new Date(baseTime + (entryIdx++) * 10_000).toISOString();

  for (const msg of history) {
    const contentArr = msg.content;

    if (msg.role === "user") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof contentArr === "string") {
        content.push({ type: "text", text: contentArr });
      } else if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) {
            content.push({ type: "text", text: p.text });
          }
        }
      }
      if (content.length === 0) continue;
      parentUuid = appendEntry(sessionPath, {
        type: "user", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        promptId: randomUUID(),
        message: { role: "user", content },
        permissionMode: "default",
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });

    } else if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof contentArr === "string") {
        if (contentArr) content.push({ type: "text", text: contentArr });
      } else if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) {
            content.push({ type: "text", text: p.text });
          } else if (p.type === "tool-call" && p.toolCallId && p.toolName) {
            let input: unknown = {};
            try { input = typeof p.input === "string" ? JSON.parse(p.input as string) : p.input; } catch {}
            content.push({ type: "tool_use", id: p.toolCallId, name: p.toolName, input });
          } else if (p.type === "reasoning" && p.text) {
            // Skip thinking blocks — they require a cryptographic signature
            // from the original API response which we can't forge.
            continue;
          }
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no text response)" });
      parentUuid = appendEntry(sessionPath, {
        type: "assistant", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        requestId: `req_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        message: {
          model: "claude-sonnet-4-5-20250929", id: `msg_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          type: "message", role: "assistant", content,
          stop_reason: "end_turn", stop_sequence: null,
          usage: {
            input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "", iterations: [], speed: "standard",
          },
        },
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });

    } else if (msg.role === "tool") {
      const content: Array<Record<string, unknown>> = [];
      if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "tool-result" && p.toolCallId) {
            const result = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
            content.push({ type: "tool_result", tool_use_id: p.toolCallId, content: result });
          }
        }
      }
      if (content.length === 0) continue;
      parentUuid = appendEntry(sessionPath, {
        type: "user", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        promptId: randomUUID(),
        message: { role: "user", content },
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });
    }
  }

  // Update summary leafUuid to point to last entry — tells --resume where the conversation ends
  if (parentUuid) {
    const entries = readFileSync(sessionPath, "utf-8").trim().split("\n");
    if (entries.length > 0) {
      const summary = JSON.parse(entries[0]);
      summary.leafUuid = parentUuid;
      entries[0] = JSON.stringify(summary);
      writeFileSync(sessionPath, entries.join("\n") + "\n");
    }
  }
}

// ─── Graft: splice OC history into an existing Claude JSONL ────────────────
//
// Pure function. Reads OC messages (from opts.prompt), transforms the slice
// [start, end) into Claude CLI JSONL entries, appends them to an existing
// JSONL at the current tail. Updates leafUuid. No new file, no new session ID.
//
// ocMessages: the full OC conversation (from opts.prompt, excluding system)
// start: index of first message to graft (inclusive)
// end: index of last message to graft (exclusive), or undefined for all remaining
// jsonlPath: path to the existing Claude CLI JSONL
// sessionId: the existing Claude CLI session ID
// cwd: working directory

export async function graft(
  ocSessionId: string,
  start: number,
  end: number | undefined,
  jsonlPath: string,
  sessionId: string,
  cwd: string,
  ocPort = 4096,
): Promise<number> {
  // Read OC session messages directly from the source
  const resp = await fetch(`http://127.0.0.1:${ocPort}/session/${ocSessionId}/message`);
  if (!resp.ok) throw new Error(`graft: failed to read OC session ${ocSessionId}: ${resp.status}`);
  const ocData = await resp.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; input?: unknown; result?: unknown }> }>;

  // Transform OC messages to the format graft understands
  const ocMessages: Array<{ role: string; content: unknown }> = [];
  for (const m of ocData) {
    const role = m.info.role;
    if (role === "user") {
      const content = m.parts
        .filter(p => p.type === "text" && p.text)
        .map(p => ({ type: "text", text: p.text }));
      if (content.length > 0) ocMessages.push({ role: "user", content });
    } else if (role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      for (const p of m.parts) {
        if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        if (p.type === "tool" && p.toolCallId && p.toolName) {
          content.push({ type: "tool-call", toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
        }
      }
      if (content.length > 0) ocMessages.push({ role: "assistant", content });
    }
  }

  const slice = ocMessages.slice(start, end);
  if (slice.length === 0) return 0;

  let parentUuid = lastUuid(jsonlPath);
  const baseTime = Date.now() - slice.length * 10_000;
  let idx = 0;
  const ts = () => new Date(baseTime + (idx++) * 10_000).toISOString();
  let grafted = 0;

  for (const msg of slice) {
    const contentArr = msg.content;

    if (msg.role === "user") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof contentArr === "string") {
        content.push({ type: "text", text: contentArr });
      } else if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
        }
      }
      if (content.length === 0) continue;
      parentUuid = appendEntry(jsonlPath, {
        type: "user", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        promptId: randomUUID(),
        message: { role: "user", content },
        permissionMode: "default",
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });
      grafted++;

    } else if (msg.role === "assistant") {
      const content: Array<Record<string, unknown>> = [];
      if (typeof contentArr === "string") {
        if (contentArr) content.push({ type: "text", text: contentArr });
      } else if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "text" && p.text) content.push({ type: "text", text: p.text });
          else if (p.type === "tool-call" && p.toolCallId && p.toolName) {
            let input: unknown = {};
            try { input = typeof p.input === "string" ? JSON.parse(p.input as string) : p.input; } catch {}
            content.push({ type: "tool_use", id: p.toolCallId, name: p.toolName, input });
          } else if (p.type === "reasoning") continue; // skip — requires cryptographic signature
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no text response)" });
      parentUuid = appendEntry(jsonlPath, {
        type: "assistant", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        requestId: `req_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
        message: {
          model: "claude-sonnet-4-5-20250929",
          id: `msg_01${randomUUID().replace(/-/g, "").slice(0, 20)}`,
          type: "message", role: "assistant", content,
          stop_reason: "end_turn", stop_sequence: null,
          usage: {
            input_tokens: 0, output_tokens: 0,
            cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
            server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
            service_tier: "standard",
            cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
            inference_geo: "", iterations: [], speed: "standard",
          },
        },
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });
      grafted++;

    } else if (msg.role === "tool") {
      const content: Array<Record<string, unknown>> = [];
      if (Array.isArray(contentArr)) {
        for (const p of contentArr as Array<Record<string, unknown>>) {
          if (p.type === "tool-result" && p.toolCallId) {
            const result = typeof p.result === "string" ? p.result : JSON.stringify(p.result ?? "");
            content.push({ type: "tool_result", tool_use_id: p.toolCallId, content: result });
          }
        }
      }
      if (content.length === 0) continue;
      parentUuid = appendEntry(jsonlPath, {
        type: "user", parentUuid, sessionId, isSidechain: false, timestamp: ts(),
        promptId: randomUUID(),
        message: { role: "user", content },
        userType: "external", entrypoint: "sdk-cli", cwd, version: "2.1.80", gitBranch: "main",
      });
      grafted++;
    }
  }

  // Update leafUuid — tells --resume where the conversation ends
  if (parentUuid) {
    const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n");
    if (lines.length > 0) {
      const summary = JSON.parse(lines[0]);
      summary.leafUuid = parentUuid;
      lines[0] = JSON.stringify(summary);
      writeFileSync(jsonlPath, lines.join("\n") + "\n");
    }
  }

  return grafted;
}

// ─── JSONL → Messages ──────────────────────────────────────────────────────
// Read Claude CLI JSONL and convert to OC-compatible message array.

export function toMessages(path: string): Array<{ role: string; content: unknown }> {
  const entries = readEntries(path);
  const messages: Array<{ role: string; content: unknown }> = [];
  for (const entry of entries) {
    if (entry.type === "user" && "message" in entry) {
      const msg = (entry as UserEntry).message;
      if (msg.role === "user") messages.push({ role: "user", content: msg.content });
    } else if (entry.type === "assistant" && "message" in entry) {
      const msg = (entry as AssistantEntry).message;
      if (msg.role === "assistant") messages.push({ role: "assistant", content: msg.content });
    }
  }
  return messages;
}
