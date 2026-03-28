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

// ─── Drone ─────────────────────────────────────────────────────────────────
// The sentinel's awareness. Not called, not invoked — it observes every tone
// that flows through the hum and acts on what it sees. The drone is never
// manual. If you have to call it, it's not a drone.
//
// The drone watches the hum. Every tone that passes through updates the
// assessment. The rhythm adapts. Retries fire. Resyncs happen. The user
// never sees a failure because the drone already handled it.

export type Assessment = "serene" | "alert" | "tense" | "critical";

const RHYTHM: Record<Assessment, number> = {
  serene: 30_000,
  alert: 5_000,
  tense: 1_000,
  critical: 500,
};

export interface DroneState {
  sigil: string;
  assessment: Assessment;
  rhythm: number;              // current beat interval in ms
  localWane: number;
  remoteWane: number;
  pendingEchoes: Map<string, { rid: string; chi: string; time: number; retries: number }>;
  lastBeatSent: number;
  lastBeatReceived: number;
  missedBeats: number;
  inflightTools: number;
  pendingPermissions: number;
  tokensBurned: number;
  // Response accumulation — drone reads what the LLM says
  responseText: string;
  suspicious: boolean;         // heuristic engine flagged this response
}

export interface DroneBeat {
  chi: "drone";
  sigil: string;
  wane: number;
  assessment: Assessment;
  rhythm: number;
  pendingEchoes: string[];     // rids we sent but haven't heard back
  load: {
    activeSessions: number;
    pendingPermissions: number;
    inflightTools: number;
    tokensBurned: number;
  };
}

export function createDroneState(s: string): DroneState {
  return {
    sigil: s,
    assessment: "serene",
    rhythm: RHYTHM.serene,
    localWane: 0,
    remoteWane: 0,
    pendingEchoes: new Map(),
    lastBeatSent: 0,
    lastBeatReceived: 0,
    missedBeats: 0,
    inflightTools: 0,
    pendingPermissions: 0,
    tokensBurned: 0,
    responseText: "",
    suspicious: false,
  };
}

// ─── Heuristic Engine ────────────────────────────────────────────────────
// Fast, deterministic first gate. Flags suspicion — doesn't decide.

const CONTEXT_LOSS_PATTERNS = [
  /\bi don'?t (have|see|recall|remember) (any )?(previous|prior|earlier|context|history|conversation)/i,
  /\bno (previous|prior) (context|history|conversation|messages?)/i,
  /\b(new|fresh|blank) (session|conversation|chat)\b/i,
  /\bthere'?s nothing (before|prior|earlier)/i,
  /\byour (first|very first) message/i,
  /\bno (history|context) (available|found|stored|present)/i,
  /\bI (can'?t|cannot) (access|see|view|read) (any )?(previous|prior|earlier)/i,
  /\bthis (is|appears to be) (a |the )?(start|beginning) of (our|a|the) conversation/i,
];

export function heuristicSuspicion(text: string): boolean {
  return CONTEXT_LOSS_PATTERNS.some(p => p.test(text));
}

/** Derive assessment from observable state — no external calls */
export function assess(state: DroneState): Assessment {
  // Critical: missed beats, unacknowledged tones for too long
  if (state.missedBeats >= 3) return "critical";
  const now = Date.now();
  for (const [, pending] of state.pendingEchoes) {
    if (now - pending.time > state.rhythm * 2) return "critical";
  }
  if (state.localWane !== state.remoteWane && state.lastBeatReceived > 0) return "critical";

  // Tense: permissions pending, many in-flight tools, high token burn
  if (state.pendingPermissions > 0) return "tense";
  if (state.inflightTools > 3) return "tense";
  if (state.pendingEchoes.size > 0) return "tense";

  // Alert: any activity
  if (state.inflightTools > 0) return "alert";
  if (state.tokensBurned > 0) return "alert";

  return "serene";
}

/** Update rhythm from assessment */
export function rerhythm(state: DroneState): void {
  state.assessment = assess(state);
  state.rhythm = RHYTHM[state.assessment];
}

/**
 * Drone: self-governing observer of a hum channel.
 *
 * The drone wraps the hum's I/O. It sees every tone that flows in either
 * direction. Nobody calls the drone — it intercepts naturally.
 *
 * Usage: wrap your hum send/receive with drone.observe() and the drone
 * runs itself. The onAction callback fires when the drone needs the
 * channel to do something (send a beat, retry a tone, resync state).
 */
export class Drone {
  private states = new Map<string, DroneState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private evaluating = new Set<string>(); // sigils currently being evaluated

  constructor(
    private side: string,  // "daemon" or "plugin"
    private onAction: (action: DroneAction) => void,
    private evaluate?: DroneEvaluator,
    private swallowThreshold = 0.7,
  ) {}

  private getOrCreate(s: string): DroneState {
    let state = this.states.get(s);
    if (!state) { state = createDroneState(s); this.states.set(s, state); }
    return state;
  }

  /** Reset the silence timer for a sigil — fires when the hum goes quiet */
  private resetSilence(s: string): void {
    const existing = this.timers.get(s);
    if (existing) clearTimeout(existing);
    const state = this.getOrCreate(s);
    this.timers.set(s, setTimeout(() => this.onSilence(s), state.rhythm));
  }

  /** Silence detected — the hum went quiet for one rhythm interval */
  private onSilence(s: string): void {
    const state = this.getOrCreate(s);
    const now = Date.now();

    // Missed beat detection
    if (state.lastBeatReceived > 0 && now - state.lastBeatReceived > state.rhythm * 2) {
      state.missedBeats++;
      rerhythm(state);
    }

    // Emit beat — silence is when we speak
    state.lastBeatSent = now;
    const beat: DroneBeat = {
      chi: "drone",
      sigil: s,
      wane: state.localWane,
      assessment: state.assessment,
      rhythm: state.rhythm,
      pendingEchoes: [...state.pendingEchoes.keys()],
      load: {
        activeSessions: this.states.size,
        pendingPermissions: state.pendingPermissions,
        inflightTools: state.inflightTools,
        tokensBurned: state.tokensBurned,
      },
    };
    this.onAction({ type: "beat", sigil: s, beat });

    // Stale echoes — retry
    for (const [rid, pending] of state.pendingEchoes) {
      if (now - pending.time > state.rhythm * 2 && pending.retries < 3) {
        pending.retries++;
        this.onAction({ type: "retry", sigil: s, rid, chi: pending.chi });
      }
      if (pending.retries >= 3) {
        state.pendingEchoes.delete(rid);
        this.onAction({ type: "lost", sigil: s, rid, chi: pending.chi });
      }
    }

    // Wane drift
    if (state.localWane !== state.remoteWane && state.lastBeatReceived > 0) {
      this.onAction({ type: "drift", sigil: s, local: state.localWane, remote: state.remoteWane });
    }

    // Dead connection
    if (state.missedBeats >= 3) {
      this.onAction({ type: "dead", sigil: s, missedBeats: state.missedBeats });
    }

    // Re-arm — silence detection is recursive
    this.resetSilence(s);
  }

  /** Wired into hum send path — observes outgoing tones */
  sent(tone: Record<string, unknown>): void {
    if (tone.chi === "drone" || tone.chi === "echo") return;
    const s = tone.sigil as string;
    if (!s) return;
    const state = this.getOrCreate(s);
    if (tone.rid) {
      state.pendingEchoes.set(tone.rid as string, {
        rid: tone.rid as string, chi: tone.chi as string, time: Date.now(), retries: 0,
      });
    }
    rerhythm(state);
    this.resetSilence(s);
  }

  /** Wired into hum receive path — observes incoming tones */
  heard(tone: Record<string, unknown>): void {
    const chi = tone.chi as string;

    if (chi === "echo") {
      const echoRid = tone.rid as string;
      for (const [s, state] of this.states) {
        if (state.pendingEchoes.has(echoRid)) {
          state.pendingEchoes.delete(echoRid);
          rerhythm(state);
          this.resetSilence(s);
          break;
        }
      }
      return;
    }

    if (chi === "drone") {
      const s = tone.sigil as string;
      if (s) {
        const state = this.getOrCreate(s);
        state.lastBeatReceived = Date.now();
        state.missedBeats = 0;
        state.remoteWane = (tone.wane as number) ?? state.remoteWane;
        rerhythm(state);
        this.resetSilence(s);
      }
      return;
    }

    const s = tone.sigil as string;
    if (s) {
      const state = this.getOrCreate(s);
      if (chi === "pulse" && tone.kind === "roost-died") {
        state.inflightTools = 0;
      }
      rerhythm(state);
      this.resetSilence(s);
    }
  }

  /** Wired into Claude CLI stream — observes what the LLM is doing */
  observed(s: string, event: { type: string; toolName?: string; tokensDelta?: number; text?: string }): void {
    const state = this.getOrCreate(s);

    if (event.type === "tool_start") {
      state.inflightTools++;
    } else if (event.type === "tool_end") {
      state.inflightTools = Math.max(0, state.inflightTools - 1);
    } else if (event.type === "tokens") {
      state.tokensBurned += event.tokensDelta ?? 0;
    } else if (event.type === "permission_ask") {
      state.pendingPermissions++;
    } else if (event.type === "permission_resolved") {
      state.pendingPermissions = Math.max(0, state.pendingPermissions - 1);
    } else if (event.type === "text_delta" && event.text) {
      // Accumulate response — the drone reads what the LLM says
      state.responseText += event.text;
      // Heuristic engine: fast check on accumulated text
      if (!state.suspicious && state.responseText.length > 20) {
        state.suspicious = heuristicSuspicion(state.responseText);
      }
    } else if (event.type === "turn_end") {
      // Turn complete — evaluate if suspicious, then reset
      if (state.suspicious && this.evaluate && !this.evaluating.has(s)) {
        this.evaluating.add(s);
        const text = state.responseText;
        this.evaluate(text).then(probability => {
          this.evaluating.delete(s);
          if (probability >= this.swallowThreshold) {
            this.onAction({ type: "swallow", sigil: s, reason: `context loss probability ${probability.toFixed(2)}`, text });
          }
        }).catch(() => { this.evaluating.delete(s); });
      }
      state.responseText = "";
      state.suspicious = false;
    }

    rerhythm(state);
    this.resetSilence(s);
  }

  /** Get state for inspection (observability) */
  inspect(): Map<string, DroneState> { return this.states; }

  /** Update local wane — called when wane tracker ticks */
  setWane(s: string, w: number): void {
    this.getOrCreate(s).localWane = w;
  }

  /** Clean up */
  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export type DroneAction =
  | { type: "beat"; sigil: string; beat: DroneBeat }
  | { type: "retry"; sigil: string; rid: string; chi: string }
  | { type: "lost"; sigil: string; rid: string; chi: string }
  | { type: "drift"; sigil: string; local: number; remote: number }
  | { type: "dead"; sigil: string; missedBeats: number }
  | { type: "swallow"; sigil: string; reason: string; text: string };

/** Neural evaluation callback — injected at creation, called when heuristics flag suspicion */
export type DroneEvaluator = (text: string) => Promise<number>; // returns probability 0-1
