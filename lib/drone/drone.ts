// ─── Drone ─────────────────────────────────────────────────────────────────
// The sentinel's awareness. Not called, not invoked — it observes every tone
// that flows through the hum and acts on what it sees. The drone is never
// manual. If you have to call it, it's not a drone.
//
// The drone watches the hum. Every tone that passes through updates the
// assessment. The rhythm adapts. Retries fire. Resyncs happen. The user
// never sees a failure because the drone already handled it.

import { heuristicSuspicion } from "./classify.ts";

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
  responseText: string;
  suspicious: boolean;
}

export interface DroneBeat {
  chi: "drone";
  sigil: string;
  wane: number;
  assessment: Assessment;
  rhythm: number;
  pendingEchoes: string[];
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

/** Derive assessment from observable state — no external calls */
export function assess(state: DroneState): Assessment {
  if (state.missedBeats >= 3) return "critical";
  const now = Date.now();
  for (const [, pending] of state.pendingEchoes) {
    if (now - pending.time > state.rhythm * 2) return "critical";
  }
  if (state.localWane !== state.remoteWane && state.lastBeatReceived > 0) return "critical";

  if (state.pendingPermissions > 0) return "tense";
  if (state.inflightTools > 3) return "tense";
  if (state.pendingEchoes.size > 0) return "tense";

  if (state.inflightTools > 0) return "alert";
  if (state.tokensBurned > 0) return "alert";

  return "serene";
}

/** Update rhythm from assessment */
export function rerhythm(state: DroneState): void {
  state.assessment = assess(state);
  state.rhythm = RHYTHM[state.assessment];
}

export type DroneAction =
  | { type: "beat"; sigil: string; beat: DroneBeat }
  | { type: "retry"; sigil: string; rid: string; chi: string }
  | { type: "lost"; sigil: string; rid: string; chi: string }
  | { type: "drift"; sigil: string; local: number; remote: number }
  | { type: "dead"; sigil: string; missedBeats: number }
  | { type: "swallow"; sigil: string; reason: string; text: string };

/** Neural evaluation callback — injected at creation, called when heuristics flag suspicion */
export type DroneEvaluator = (text: string, state: DroneState) => Promise<number>; // returns probability 0-1

/**
 * Drone: self-governing observer of a hum channel.
 *
 * The drone wraps the hum's I/O. It sees every tone that flows in either
 * direction. Nobody calls the drone — it intercepts naturally.
 */
export class Drone {
  private states = new Map<string, DroneState>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private evaluating = new Set<string>();

  constructor(
    private side: string,
    private onAction: (action: DroneAction) => void,
    private evaluate?: DroneEvaluator,
    private swallowThreshold = 0.7,
    private llmAssess?: (sigil: string, state: DroneState) => void,
  ) {}

  private getOrCreate(s: string): DroneState {
    let state = this.states.get(s);
    if (!state) { state = createDroneState(s); this.states.set(s, state); }
    return state;
  }

  private resetSilence(s: string): void {
    const existing = this.timers.get(s);
    if (existing) clearTimeout(existing);
    const state = this.getOrCreate(s);
    this.timers.set(s, setTimeout(() => this.onSilence(s), state.rhythm));
  }

  private onSilence(s: string): void {
    const state = this.getOrCreate(s);
    const now = Date.now();

    if (state.lastBeatReceived > 0 && now - state.lastBeatReceived > state.rhythm * 2) {
      state.missedBeats++;
    }

    rerhythm(state);

    if (this.llmAssess && state.assessment !== "serene" && state.responseText.length > 0) {
      this.llmAssess(s, state);
    }

    this.emitBeat(s, state);

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

    if (state.localWane !== state.remoteWane && state.lastBeatReceived > 0) {
      this.onAction({ type: "drift", sigil: s, local: state.localWane, remote: state.remoteWane });
    }

    if (state.missedBeats >= 3) {
      this.onAction({ type: "dead", sigil: s, missedBeats: state.missedBeats });
      this.states.delete(s);
      this.timers.delete(s);
      return;
    }

    this.resetSilence(s);
  }

  private static TRACKED_CHI = new Set(["prompt", "seeded", "cancel", "release-permit"]);

  /** Wired into hum send path — observes outgoing tones */
  sent(tone: Record<string, unknown>): void {
    if (tone.chi === "drone" || tone.chi === "echo") return;
    const s = tone.sigil as string;
    if (!s) return;
    const state = this.getOrCreate(s);
    if (tone.rid && Drone.TRACKED_CHI.has(tone.chi as string)) {
      state.pendingEchoes.set(tone.rid as string, {
        rid: tone.rid as string, chi: tone.chi as string, time: Date.now(), retries: 0,
      });
    }
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
        this.resetSilence(s);
      }
      return;
    }

    const s = tone.sigil as string;
    if (s) {
      const state = this.getOrCreate(s);
      // Process-death pulse resets per-process counters. Plugin↔daemon
      // channel state (pendingEchoes, wane, missedBeats) survives the kill.
      if (chi === "pulse" && (tone.kind === "roost-died" || tone.kind === "roost-evicted" || tone.kind === "roost-idle")) {
        state.inflightTools = 0;
        state.responseText = "";
        state.suspicious = false;
      }
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
      state.responseText += event.text;
    } else if (event.type === "turn_end") {
      if (state.responseText.length > 20) {
        state.suspicious = heuristicSuspicion(state.responseText);
      }
      if (state.suspicious && this.evaluate && !this.evaluating.has(s)) {
        this.evaluating.add(s);
        const text = state.responseText;
        this.evaluate(text, state).then((probability) => {
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

  inspect(): Map<string, DroneState> { return this.states; }

  setWane(s: string, w: number): void {
    const state = this.getOrCreate(s);
    state.localWane = w;
  }

  private emitBeat(s: string, state: DroneState): void {
    state.lastBeatSent = Date.now();
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
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}
