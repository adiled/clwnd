// Penny-pincher counters. A single in-process tally of how often each
// cost-saving path fired. Exposed via the daemon's /savings HTTP endpoint
// and rendered by `clwnd savings`. Persisted to disk so counters survive
// daemon restart — accumulating a lifetime view by default.
//
// Plugin-side optimizations (system-reminder dedup, hum hash dedup,
// priorPetals elision) live in OpenCode's plugin process, not the daemon.
// The plugin piggybacks a `pennyDelta` field on every prompt hum; the
// daemon adds it into this shared struct on receipt. See provider.ts
// flushPennyDelta() and daemon.ts case "prompt".
//
// NOTE: an earlier revision had an `auxModelRouted` counter tracking turns
// where clwnd silently swapped opus → sonnet-4-6 on empty-tool calls. That
// swap was ripped because it polluted the nest pool with the wrong model
// and silently downgraded the next build turn. Do not reintroduce it: OC
// built-in agents (title, compaction) should each be detected and handled
// independently, never unified under a generic "auxiliary" bucket.

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface Penny {
  started: number;            // epoch ms when counters started (load or reset)
  // MCP tool-level (daemon process)
  readDedupHits: number;      // re-read of unchanged file returned placeholder
  readDedupBytes: number;     // bytes NOT re-sent (file size × hits)
  bashTruncated: number;      // bash calls that hit the 16KB cap
  bashBytesTrimmed: number;   // total bytes trimmed off bash output
  // Daemon session-level
  contextOverThreshold: number; // prompts where last turn's per-turn context exceeded the warning threshold
  // Plugin-side (sent via pennyDelta on each prompt hum)
  humDedup: number;           // prompt hums with ≥1 dedup'd field (sp/perm/tools)
  reminderStripped: number;   // system-reminder blocks stripped as duplicates
  priorPetalsElided: number;  // prompt hums where priorPetals was elided
}

export type PennyDelta = Partial<Omit<Penny, "started">>;

export const penny: Penny = {
  started: Date.now(),
  readDedupHits: 0,
  readDedupBytes: 0,
  bashTruncated: 0,
  bashBytesTrimmed: 0,
  contextOverThreshold: 0,
  humDedup: 0,
  reminderStripped: 0,
  priorPetalsElided: 0,
};

export function pennyReset(): void {
  penny.started = Date.now();
  penny.readDedupHits = 0;
  penny.readDedupBytes = 0;
  penny.bashTruncated = 0;
  penny.bashBytesTrimmed = 0;
  penny.contextOverThreshold = 0;
  penny.humDedup = 0;
  penny.reminderStripped = 0;
  penny.priorPetalsElided = 0;
}

// Merge a delta (from the plugin) into the live counters.
export function pennyAdd(delta: PennyDelta): void {
  if (!delta || typeof delta !== "object") return;
  if (typeof delta.readDedupHits === "number") penny.readDedupHits += delta.readDedupHits;
  if (typeof delta.readDedupBytes === "number") penny.readDedupBytes += delta.readDedupBytes;
  if (typeof delta.bashTruncated === "number") penny.bashTruncated += delta.bashTruncated;
  if (typeof delta.bashBytesTrimmed === "number") penny.bashBytesTrimmed += delta.bashBytesTrimmed;
  if (typeof delta.contextOverThreshold === "number") penny.contextOverThreshold += delta.contextOverThreshold;
  if (typeof delta.humDedup === "number") penny.humDedup += delta.humDedup;
  if (typeof delta.reminderStripped === "number") penny.reminderStripped += delta.reminderStripped;
  if (typeof delta.priorPetalsElided === "number") penny.priorPetalsElided += delta.priorPetalsElided;
}

// Load persisted counters. Called once on daemon startup. Missing or corrupt
// file is non-fatal — counters stay at zero. `started` is always reset to now
// so uptime reflects the current daemon session.
export function pennyLoad(path: string): void {
  try {
    const data = JSON.parse(readFileSync(path, "utf-8")) as Partial<Penny>;
    penny.readDedupHits = data.readDedupHits ?? 0;
    penny.readDedupBytes = data.readDedupBytes ?? 0;
    penny.bashTruncated = data.bashTruncated ?? 0;
    penny.bashBytesTrimmed = data.bashBytesTrimmed ?? 0;
    penny.contextOverThreshold = data.contextOverThreshold ?? 0;
    penny.humDedup = data.humDedup ?? 0;
    penny.reminderStripped = data.reminderStripped ?? 0;
    penny.priorPetalsElided = data.priorPetalsElided ?? 0;
  } catch {
    // First run, corrupt file, missing file — all fine, stay at zero.
  }
  penny.started = Date.now();
}

// Save counters to disk. Cheap: ~300-byte JSON blob, atomic via writeFileSync.
export function pennySave(path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(penny) + "\n");
  } catch {
    // Persistence is best-effort — losing counters on disk failure is fine.
  }
}
