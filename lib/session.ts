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
  const entry = { ...record, uuid, timestamp: new Date().toISOString() };
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

export function fromPrompt(
  sessionPath: string,
  sessionId: string,
  history: Array<{ role: string; content: unknown }>,
  cwd: string,
): void {
  let parentUuid: string | null = lastUuid(sessionPath);

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
        type: "user", parentUuid, sessionId, isSidechain: false,
        promptId: randomUUID(),
        message: { role: "user", content },
        permissionMode: "default",
        userType: "external", entrypoint: "sdk-cli", cwd,
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
            content.push({ type: "thinking", thinking: p.text });
          }
        }
      }
      if (content.length === 0) content.push({ type: "text", text: "(no text response)" });
      parentUuid = appendEntry(sessionPath, {
        type: "assistant", parentUuid, sessionId, isSidechain: false,
        requestId: `req_seed_${randomUUID().slice(0, 12)}`,
        message: {
          model: "seeded", id: `msg_seed_${randomUUID().slice(0, 12)}`,
          type: "message", role: "assistant", content,
          stop_reason: "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        userType: "external", entrypoint: "sdk-cli", cwd,
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
        type: "user", parentUuid, sessionId, isSidechain: false,
        promptId: randomUUID(),
        message: { role: "user", content },
        userType: "external", entrypoint: "sdk-cli", cwd,
      });
    }
  }
}

// ─── Future: JSONL → Messages ───────────────────────────────────────────────
// Read Claude CLI JSONL and convert to OC-compatible message array.
// Placeholder for bidirectional session transfer.

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
