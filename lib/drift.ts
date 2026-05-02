// drift — the felt passing of time. Records each bloom's milestones, tools
// the daemon dispatched, and exposes a ring of recent blooms for the
// `clwnd drift` CLI and HTTP endpoints to query.
//
// Naming follows the rest of the codebase: a bloom is one assistant turn
// (prompt → wilt). Each milestone within is a mark, each tool roundtrip
// is a tendril. Aggregation is purely lazy on read — the hot path only
// stamps a few timestamps.
//
// Persistence: when configured, each bloom appends one JSON line to
//   ${stateDir}/drift/YYYY-MM-DD.ndjson
// at wilt time. The in-memory ring stays primary for "recent N blooms";
// historical reads cross over to disk via readSince().

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "fs";
import { join } from "path";

export interface TendrilDrift {
  name: string;
  ms: number;
  at: number; // ms since turn start
}

export interface HumSample {
  to: "nest" | "oc"; // destination endpoint (anchored on receiver, not perspective)
  ms: number;
  at: number;        // ms since bloom start
}

export interface BloomDrift {
  sid: string;
  bloomId: string;
  modelId?: string;
  version?: string;                  // clwnd build that recorded this turn
  startedAt: number;
  endedAt?: number;
  marks: Record<string, number>;     // phase name → ms since startedAt (first-only)
  spans: Record<string, number>;     // named duration accumulator (cumulative)
  flags: Record<string, boolean | number | string>; // arbitrary tags (warm, withered, …)
  tendrils: TendrilDrift[];
  hums: HumSample[];                 // per-hum transit samples — aggregated as p50/p95
}

const RING_SIZE = 200;
const blooms: BloomDrift[] = [];
const active = new Map<string, BloomDrift>();
let seq = 0;

// Persistence config — set by daemon at startup via configure().
let storeDir: string | null = null;
let retentionDays = 0;
let buildVersion: string | undefined;

export function configure(opts: { storeDir: string; retentionDays: number; version?: string }): void {
  storeDir = opts.storeDir;
  retentionDays = opts.retentionDays;
  buildVersion = opts.version;
  if (retentionDays > 0 && storeDir) {
    try { mkdirSync(storeDir, { recursive: true }); } catch {}
    pruneOldFiles();
  }
}

function dayBucket(t: number): string {
  const d = new Date(t);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fileFor(t: number): string | null {
  if (!storeDir || retentionDays <= 0) return null;
  return join(storeDir, `${dayBucket(t)}.ndjson`);
}

function appendBloom(t: BloomDrift): void {
  const path = fileFor(t.endedAt ?? t.startedAt);
  if (!path) return;
  try {
    appendFileSync(path, JSON.stringify(t) + "\n");
  } catch {
    // Disk full / EROFS / permission — drift is not critical, drop silently.
  }
}

function pruneOldFiles(): void {
  if (!storeDir || retentionDays <= 0) return;
  try {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    for (const name of readdirSync(storeDir)) {
      if (!name.endsWith(".ndjson")) continue;
      const path = join(storeDir, name);
      try {
        const st = statSync(path);
        if (st.mtimeMs < cutoff) unlinkSync(path);
      } catch {}
    }
  } catch {}
}

// Periodic prune — daemon invokes once per ~24h.
export function prune(): void { pruneOldFiles(); }

export function open(sid: string, modelId?: string): void {
  if (active.has(sid)) return; // re-entrant guard — same bloom, no reset
  const t: BloomDrift = {
    sid,
    bloomId: `b${++seq}`,
    modelId,
    version: buildVersion,
    startedAt: Date.now(),
    marks: {},
    spans: {},
    flags: {},
    tendrils: [],
    hums: [],
  };
  active.set(sid, t);
  blooms.push(t);
  if (blooms.length > RING_SIZE) blooms.shift();
}

export function mark(sid: string, phase: string): void {
  const t = active.get(sid);
  if (!t) return;
  if (t.marks[phase] !== undefined) return; // first observation wins
  t.marks[phase] = Date.now() - t.startedAt;
}

export function tendril(sid: string, name: string, ms: number): void {
  const t = active.get(sid);
  if (!t) return;
  t.tendrils.push({ name, ms, at: Date.now() - t.startedAt });
}

/**
 * Record one hum sample — a single tone's transit across the hum socket.
 * `to` names the destination endpoint (nest = daemon, oc = plugin), so
 * direction is unambiguous regardless of who's reading. Aggregates as
 * p50/p95 across all sampled hums per bloom.
 */
export function hum(sid: string, to: "nest" | "oc", ms: number): void {
  const t = active.get(sid);
  if (!t) return;
  if (ms < 0) ms = 0; // clock-skew clamp
  // Cap per-bloom samples to avoid memory blow on chatty turns. p95 stays
  // representative; tail samples after the cap are dropped.
  if (t.hums.length >= 200) return;
  t.hums.push({ to, ms, at: Date.now() - t.startedAt });
}

/** Cumulative span — call multiple times to add (e.g. multiple reasoning blocks). */
export function span(sid: string, name: string, ms: number): void {
  const t = active.get(sid);
  if (!t) return;
  t.spans[name] = (t.spans[name] ?? 0) + ms;
}

/** Set an arbitrary tag on the turn (warm flag, witherCount, etc.). */
export function flag(sid: string, key: string, value: boolean | number | string): void {
  const t = active.get(sid);
  if (!t) return;
  t.flags[key] = value;
}

/**
 * Reset turn marks but keep startedAt. Used when the drone withers and
 * the turn restarts; the original marks (first_petal at the bad output)
 * would otherwise lock in misleading numbers. Sets `withered: <count>` flag.
 */
export function witherReset(sid: string): void {
  const t = active.get(sid);
  if (!t) return;
  t.marks = {};
  t.flags["withered"] = ((t.flags["withered"] as number) ?? 0) + 1;
}

export function wilt(sid: string): void {
  const t = active.get(sid);
  if (!t) return;
  t.endedAt = Date.now();
  t.marks["wilt"] = t.endedAt - t.startedAt;
  active.delete(sid);
  appendBloom(t);
}

/**
 * Read blooms from disk for the given window. Used when the in-memory ring
 * is colder than the requested range (typical for `clwnd drift --days N`).
 * Returns blooms sorted oldest → newest. Caller may .reverse() if desired.
 */
export function readSince(sinceMs: number, sid?: string): BloomDrift[] {
  if (!storeDir || retentionDays <= 0) return [];
  const out: BloomDrift[] = [];
  let names: string[] = [];
  try { names = readdirSync(storeDir).filter((n) => n.endsWith(".ndjson")).sort(); } catch { return []; }
  for (const name of names) {
    const path = join(storeDir, name);
    let raw: string;
    try { raw = readFileSync(path, "utf8"); } catch { continue; }
    for (const line of raw.split("\n")) {
      if (!line) continue;
      let t: BloomDrift;
      try { t = JSON.parse(line) as BloomDrift; } catch { continue; }
      if (t.startedAt < sinceMs) continue;
      if (sid && t.sid !== sid) continue;
      out.push(t);
    }
  }
  return out;
}

/** Days for which a drift bucket exists on disk. Useful for UI listing. */
export function listDays(): string[] {
  if (!storeDir) return [];
  try {
    return readdirSync(storeDir)
      .filter((n) => n.endsWith(".ndjson"))
      .map((n) => n.replace(/\.ndjson$/, ""))
      .sort();
  } catch { return []; }
}

export function recent(sid?: string, limit = 20): BloomDrift[] {
  const list = sid ? blooms.filter((t) => t.sid === sid) : blooms;
  return list.slice(-limit).reverse();
}

export function aggregate(limit = 100): {
  blooms: number;
  marks: Record<string, { p50: number; p95: number; n: number }>;
  spans: Record<string, { p50: number; p95: number; n: number }>;
  tendrils: Record<string, { p50: number; p95: number; n: number }>;
  hums: Record<string, { p50: number; p95: number; n: number }>;
} {
  const sample = blooms.slice(-limit);
  const byMark: Record<string, number[]> = {};
  const bySpan: Record<string, number[]> = {};
  const byTendril: Record<string, number[]> = {};
  const byHum: Record<string, number[]> = {};
  for (const t of sample) {
    for (const [name, ms] of Object.entries(t.marks)) {
      (byMark[name] ??= []).push(ms);
    }
    for (const [name, ms] of Object.entries(t.spans)) {
      (bySpan[name] ??= []).push(ms);
    }
    for (const td of t.tendrils) {
      (byTendril[td.name] ??= []).push(td.ms);
    }
    for (const h of t.hums ?? []) {
      (byHum[`hum_to_${h.to}`] ??= []).push(h.ms);
    }
  }
  const stats = (vs: Record<string, number[]>) => {
    const out: Record<string, { p50: number; p95: number; n: number }> = {};
    for (const [name, arr] of Object.entries(vs)) {
      const sorted = [...arr].sort((a, b) => a - b);
      out[name] = {
        n: sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)] ?? 0,
        p95: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      };
    }
    return out;
  };
  return {
    blooms: sample.length,
    marks: stats(byMark),
    spans: stats(bySpan),
    tendrils: stats(byTendril),
    hums: stats(byHum),
  };
}
