// Penny-pincher counters. Lifetime tally of every cost-saving and
// value-adding path in clwnd. Exposed via /savings, rendered by
// `clwnd savings`. Persisted to disk across daemon restarts.
//
// Plugin-side counters piggyback on the prompt hum via `pennyDelta`.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface Penny {
  started: number;

  // ── MCP tool surface ──────────────────────────────────────────────
  readDedupHits: number;       // re-read of unchanged file returned placeholder
  readDedupBytes: number;      // bytes NOT re-sent
  bashTruncated: number;       // bash output hit cap
  bashBytesTrimmed: number;    // bytes trimmed from bash output
  bashWriteBlocked: number;    // bash commands blocked for file writes
  toolCalls: number;           // total MCP tool calls executed
  validationRejected: number;  // post-edit validation caught corruption

  // ── Curate (replaces OC compaction) ───────────────────────────────
  curateEvents: number;        // compactions intercepted + pruned
  curateBytesSaved: number;    // bytes removed from JSONL by pruning
  curateThinkingStripped: number; // thinking blocks stripped

  // ── Task tool ─────────────────────────────────────────────────────
  taskExecutions: number;      // tendril-hold task executions

  // ── Title skip ────────────────────────────────────────────────────
  titleSkipped: number;        // title-gen requests skipped (saved inference)

  // ── Daemon session-level ──────────────────────────────────────────
  contextOverThreshold: number;
  droneWithers: number;        // context corruption caught by cupping

  // ── Plugin-side (via pennyDelta) ──────────────────────────────────
  humDedup: number;
  reminderStripped: number;
  priorPetalsElided: number;

  // ── Cost tracking ─────────────────────────────────────────────────
  totalCost: number;           // USD routed through clwnd (from usage)
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheWriteTokens: number;
  blooms: number;              // total assistant turns (one prompt → one wilt)
}

export type PennyDelta = Partial<Omit<Penny, "started">>;

export const penny: Penny = {
  started: Date.now(),
  readDedupHits: 0,
  readDedupBytes: 0,
  bashTruncated: 0,
  bashBytesTrimmed: 0,
  bashWriteBlocked: 0,
  toolCalls: 0,
  validationRejected: 0,
  curateEvents: 0,
  curateBytesSaved: 0,
  curateThinkingStripped: 0,
  taskExecutions: 0,
  titleSkipped: 0,
  contextOverThreshold: 0,
  droneWithers: 0,
  humDedup: 0,
  reminderStripped: 0,
  priorPetalsElided: 0,
  totalCost: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCacheReadTokens: 0,
  totalCacheWriteTokens: 0,
  blooms: 0,
};

export function pennyReset(): void {
  const keys = Object.keys(penny) as (keyof Penny)[];
  for (const k of keys) {
    if (k === "started") { penny.started = Date.now(); continue; }
    (penny as any)[k] = 0;
  }
}

export function pennyAdd(delta: PennyDelta): void {
  if (!delta || typeof delta !== "object") return;
  for (const [k, v] of Object.entries(delta)) {
    if (k === "started" || typeof v !== "number") continue;
    (penny as any)[k] = ((penny as any)[k] ?? 0) + v;
  }
}

export function pennyLoad(path: string): void {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<Penny> & { turns?: number };
    for (const [k, v] of Object.entries(data)) {
      if (k === "started" || typeof v !== "number") continue;
      // Migrate legacy field name `turns` → `blooms`. Read once, drop forever.
      if (k === "turns") { penny.blooms = (penny.blooms ?? 0) + (v as number); continue; }
      (penny as any)[k] = v;
    }
  } catch {}
  penny.started = Date.now();
}

export function pennySave(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(penny) + "\n");
  } catch {}
}
