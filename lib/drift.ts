// drift — the felt passing of time. Records each turn's milestones, tools
// the daemon dispatched, and exposes a ring of recent turns for the
// `clwnd drift` CLI and HTTP endpoints to query.
//
// Naming follows the rest of the codebase: a turn drifts through phases,
// each milestone is a mark, each tool roundtrip is a tendril. Aggregation
// is purely lazy on read — the hot path only stamps a few timestamps.

export interface TendrilDrift {
  name: string;
  ms: number;
  at: number; // ms since turn start
}

export interface TurnDrift {
  sid: string;
  turnId: string;
  modelId?: string;
  startedAt: number;
  endedAt?: number;
  marks: Record<string, number>; // phase name → ms since startedAt
  tendrils: TendrilDrift[];
}

const RING_SIZE = 200;
const turns: TurnDrift[] = [];
const active = new Map<string, TurnDrift>();
let seq = 0;

export function start(sid: string, modelId?: string): void {
  if (active.has(sid)) return; // re-entrant guard — same turn, no reset
  const t: TurnDrift = {
    sid,
    turnId: `t${++seq}`,
    modelId,
    startedAt: Date.now(),
    marks: {},
    tendrils: [],
  };
  active.set(sid, t);
  turns.push(t);
  if (turns.length > RING_SIZE) turns.shift();
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

export function end(sid: string): void {
  const t = active.get(sid);
  if (!t) return;
  t.endedAt = Date.now();
  t.marks["turn"] = t.endedAt - t.startedAt;
  active.delete(sid);
}

export function recent(sid?: string, limit = 20): TurnDrift[] {
  const list = sid ? turns.filter((t) => t.sid === sid) : turns;
  return list.slice(-limit).reverse();
}

export function aggregate(limit = 100): {
  turns: number;
  marks: Record<string, { p50: number; p95: number; n: number }>;
  tendrils: Record<string, { p50: number; p95: number; n: number }>;
} {
  const sample = turns.slice(-limit);
  const byMark: Record<string, number[]> = {};
  const byTendril: Record<string, number[]> = {};
  for (const t of sample) {
    for (const [name, ms] of Object.entries(t.marks)) {
      (byMark[name] ??= []).push(ms);
    }
    for (const td of t.tendrils) {
      (byTendril[td.name] ??= []).push(td.ms);
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
    turns: sample.length,
    marks: stats(byMark),
    tendrils: stats(byTendril),
  };
}
