// Penny-pincher counters. A single in-process tally of how often each
// cost-saving path fired since the daemon started. Exposed via the daemon's
// /savings HTTP endpoint and rendered by `clwnd savings`.
//
// Only measures daemon-process events. Plugin-side optimizations (system-
// reminder dedup, hum hash dedup, priorPetals elision, aux model routing)
// live in OpenCode's process — those are observed by grepping journal / OC
// log for their trace events.

export interface Penny {
  started: number; // epoch ms of daemon start
  // MCP tool-level
  readDedupHits: number;      // re-read of unchanged file returned placeholder
  readDedupBytes: number;     // approximate bytes NOT re-sent (file size × hits)
  bashTruncated: number;      // bash calls that hit the 16KB cap
  bashBytesTrimmed: number;   // total bytes trimmed off bash output
  // Daemon session-level
  rotations: number;          // context-threshold rotations fired
  contextOverThreshold: number; // turns where per-turn context exceeded the threshold
  // Plugin-side (incremented only if plugin hums a "savings" tone in the future;
  // left at 0 for now so `clwnd savings` can still render them uniformly)
  humDedup: number;
  reminderStripped: number;
  priorPetalsElided: number;
  auxModelRouted: number;
}

export const penny: Penny = {
  started: Date.now(),
  readDedupHits: 0,
  readDedupBytes: 0,
  bashTruncated: 0,
  bashBytesTrimmed: 0,
  rotations: 0,
  contextOverThreshold: 0,
  humDedup: 0,
  reminderStripped: 0,
  priorPetalsElided: 0,
  auxModelRouted: 0,
};

export function pennyReset(): void {
  penny.started = Date.now();
  penny.readDedupHits = 0;
  penny.readDedupBytes = 0;
  penny.bashTruncated = 0;
  penny.bashBytesTrimmed = 0;
  penny.rotations = 0;
  penny.contextOverThreshold = 0;
  penny.humDedup = 0;
  penny.reminderStripped = 0;
  penny.priorPetalsElided = 0;
  penny.auxModelRouted = 0;
}
