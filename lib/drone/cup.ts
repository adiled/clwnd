// ─── Cup ───────────────────────────────────────────────────────────────────
// The drone's cup. Holds the first ~80 bytes of a turn so the heuristic
// classifier can scan for context-loss patterns BEFORE the user sees them.
// Triggers an early flush on `tool_input_start` (model picked a tool —
// structurally healthy) and `reasoning_start` (model is thinking — same).
//
// When `enabled: false`, the cup is pure passthrough — feed() returns
// "passthrough" for every chunk, classifier never runs, no buffering.
//
// Lifecycle per turn:
//   feed(type, payload, chunk) → "passthrough" | "buffered" | "withered"
//   forceFlush() — turn ended, emit whatever's left
//   reset() — wither-retry, fresh state
//
// The cup does NOT own socket batching. It owns the suspicion-detection
// buffer. Caller batches uncupped chunks elsewhere.

import { classifySuspicion, type SuspicionLevel } from "./classify.ts";

export interface CupOpts {
  enabled: boolean;
  threshold?: number;     // default 80 chars
  maxWithers?: number;    // default 1
}

export interface CupCallbacks {
  /** Emit chunks downstream — fired when the cup uncups (threshold reached, tool/reasoning start, or forceFlush). */
  onBloom: (chunks: string[]) => void;
  /** Drone confirmed a wither — caller should kill the process and respawn. */
  onWither: (level: SuspicionLevel) => void;
  /** "API Error:" prefix detected mid-stream. Caller should hum an error and interrupt. */
  onApiError: (text: string) => void;
  /** Diagnostic trace hook (drone.cup.* / nest.uncup events). */
  onTrace?: (event: string, data: Record<string, unknown>) => void;
}

export type CupVerdict = "passthrough" | "buffered" | "withered";

export class Cup {
  private uncupped: boolean;
  private buffered: string[] = [];
  private text = "";
  private withers = 0;
  withered = false;

  private threshold: number;
  private maxWithers: number;

  constructor(private opts: CupOpts, private cb: CupCallbacks) {
    this.uncupped = !opts.enabled;
    this.threshold = opts.threshold ?? 80;
    this.maxWithers = opts.maxWithers ?? 1;
  }

  get isUncupped(): boolean { return this.uncupped; }
  get bufferedCount(): number { return this.buffered.length; }
  get bufferedTextLen(): number { return this.text.length; }

  feed(type: string, payload: Record<string, unknown>, chunk: string): CupVerdict {
    if (this.withered) return "withered";
    if (this.uncupped) return "passthrough";

    // API error detection on text_delta — Claude CLI sometimes inlines
    // "API Error: ..." instead of a structured error event.
    if (type === "text_delta" && payload.delta) {
      this.text += payload.delta as string;
      if (this.text.startsWith("API Error:")) {
        this.cb.onApiError(this.text.slice(0, 200));
        this.withered = true;
        return "withered";
      }
    }

    this.buffered.push(chunk);

    const isToolStart = type === "tool_input_start";
    const isReasoningStart = type === "reasoning_start";

    if (this.text.length >= this.threshold || isToolStart || isReasoningStart) {
      const level = classifySuspicion(this.text);
      if ((level === "critical" || level === "suspicious") && this.withers < this.maxWithers) {
        this.withers++;
        this.cb.onTrace?.(`drone.cup.${level}`, { len: this.text.length, wither: this.withers });
        this.witherNow(level);
        return "withered";
      }
      if (level !== "none" && this.withers >= this.maxWithers) {
        this.cb.onTrace?.("drone.cup.exhausted", { level, withers: this.withers });
      }
      this.uncup();
    }

    return "buffered";
  }

  /** Force flush — called at turn end (onWilt). */
  forceFlush(): void {
    this.uncup();
  }

  /** Reset state for a fresh turn (after a wither-retry). */
  reset(): void {
    this.uncupped = !this.opts.enabled;
    this.buffered = [];
    this.text = "";
    this.withered = false;
  }

  private uncup(): void {
    if (this.uncupped) return;
    this.uncupped = true;
    this.cb.onTrace?.("nest.uncup", {
      cuppedChunks: this.buffered.length,
      cuppedLen: this.text.length,
    });
    if (this.buffered.length > 0) {
      this.cb.onBloom(this.buffered);
      this.buffered = [];
    }
  }

  private witherNow(_level: SuspicionLevel): void {
    this.withered = true;
    this.buffered = [];
    this.text = "";
    this.cb.onWither(_level);
  }
}
