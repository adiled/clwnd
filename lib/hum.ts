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

// ─── Reach ─────────────────────────────────────────────────────────────────
// Addressing. Today: local unix socket. Tomorrow: network.

export interface Reach {
  clientId: string;       // unique per connection
  sigils: Set<string>;    // session pairings this client cares about
  socket: any;            // the underlying socket
}
