// ─── Hum Protocol ──────────────────────────────────────────────────────────
//
// The hum is the bidirectional NDJSON socket between daemon and plugin.
// It carries tones — structured messages with protocol semantics.
//
// Primitives:
//   sigil  — deterministic hash binding an OC session to a backend session
//   tone   — the message frame: chi, rid, from, to, sigil
//   echo   — acknowledgment: proof the tone landed
//   breath — handshake on connect: full state sync
//   pulse  — lifecycle events: spawned, ready, idle, gone
//   reach  — addressing: who receives the tone
//

import { createHash } from "crypto";

// ─── Sigil ─────────────────────────────────────────────────────────────────
// Deterministic identity for a session pairing.
// Survives restarts, reconnects, forks. Derived, not assigned.

export function sigil(ocSessionId: string, harness = "claude"): string {
  return createHash("sha256")
    .update(`${harness}:${ocSessionId}`)
    .digest("hex")
    .slice(0, 12);
}

// ─── Tone ──────────────────────────────────────────────────────────────────
// Every hum message is a tone. The frame gives it accountability.

export interface Tone {
  chi: string;           // what — the message type (prompt, finish, cancel, ...)
  rid: string;           // request id — correlation key for echo
  from: string;          // sender identity
  to?: string;           // recipient identity (omit = broadcast to session)
  sigil?: string;        // session pairing hash
  sid?: string;          // OC session id (legacy compat, derived from sigil)
  wane?: number;         // sender's wane for this sigil at send time
  dusk?: number;         // absolute timestamp — tone expires after this
  [key: string]: unknown; // payload fields
}

let ridCounter = 0;
export function rid(): string {
  return `${Date.now().toString(36)}-${(ridCounter++).toString(36)}`;
}

// ─── Echo ──────────────────────────────────────────────────────────────────
// Acknowledgment. Sender waits for echo; retries or fails fast.

export interface Echo {
  chi: "echo";
  rid: string;           // the rid being acknowledged
  ok: boolean;           // delivery succeeded
  error?: string;        // reason if not ok
}

export function echo(tone: Tone, ok = true, error?: string): Echo {
  return { chi: "echo", rid: tone.rid, ok, error };
}

// ─── Breath ────────────────────────────────────────────────────────────────
// Handshake on connect. Daemon sends full state for the client's sessions.

export interface BreathSession {
  sigil: string;
  sid: string;
  claudeSessionId: string | null;
  claudeSessionPath: string | null;
  turnsSent: number;
  wane: number;
  modelId: string;
  cwd: string;
  roostAlive: boolean;
  roostPid?: number;
}

export interface Breath {
  chi: "breath";
  from: string;          // daemon identity
  sessions: BreathSession[];
}

// ─── Pulse ─────────────────────────────────────────────────────────────────
// Lifecycle events. The sentinel's heartbeat.

export type PulseKind =
  | "roost-spawned"      // process created
  | "roost-ready"        // system init received, accepting input
  | "roost-idle"         // turn complete, no listeners
  | "roost-died"         // process exited (idle timeout, crash, cancel)
  | "roost-evicted";     // killed to make room (maxProcs)

export interface Pulse {
  chi: "pulse";
  kind: PulseKind;
  sigil: string;
  sid: string;
  rid: string;
  pid?: number;
  reason?: string;
}

export function pulse(kind: PulseKind, sigil: string, sid: string, extra?: Partial<Pulse>): Pulse {
  return { chi: "pulse", kind, sigil, sid, rid: rid(), ...extra };
}

// ─── Wane ──────────────────────────────────────────────────────────────────
// Drift detection. Monotonic counter per sigil. Incremented on every state
// mutation. Both sides track their own wane. When wanes diverge, drift is
// visible — the stale side resyncs.

export class WaneTracker {
  private counters = new Map<string, number>();

  /** Get current wane for a sigil */
  get(s: string): number {
    return this.counters.get(s) ?? 0;
  }

  /** Increment wane — call on every state mutation */
  tick(s: string): number {
    const next = (this.counters.get(s) ?? 0) + 1;
    this.counters.set(s, next);
    return next;
  }

  /** Set wane to a known value (from breath or persistence) */
  set(s: string, value: number): void {
    this.counters.set(s, value);
  }

  /** Check if remote wane is ahead of local — drift detected */
  behind(s: string, remote: number): boolean {
    return remote > this.get(s);
  }
}

// ─── Dusk ──────────────────────────────────────────────────────────────────
// Temporal value. A tone's dusk is when its value expires. Past dusk,
// the tone is dead on arrival — discard, don't process.

export function duskIn(ms: number): number {
  return Date.now() + ms;
}

export function isDusk(tone: { dusk?: number }): boolean {
  return typeof tone.dusk === "number" && Date.now() > tone.dusk;
}

// ─── Reach ─────────────────────────────────────────────────────────────────
// Addressing. Today: local unix socket. Tomorrow: network.

export interface Reach {
  clientId: string;       // unique per connection
  sigils: Set<string>;    // session pairings this client cares about
  socket: any;            // the underlying socket
}
