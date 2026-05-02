// drone — clwnd's context-loss watcher. Opt-in via `droned: true`.
//
// Architecture: when the cup catches text in the first ~80 bytes of a
// turn, classify (heuristic) → if suspicious, llm (judge) → if confirmed,
// the daemon withers (kills + respawns the Claude CLI process and re-sends
// the prompt). User sees no flicker.
//
// Off-switch: see lib/config.ts `droned` field. When false, daemon and
// plugin instantiate stub objects from this module — zero overhead.

export {
  Drone,
  createDroneState,
  assess,
  rerhythm,
  type Assessment,
  type DroneState,
  type DroneBeat,
  type DroneAction,
  type DroneEvaluator,
} from "./drone.ts";

export {
  classifySuspicion,
  heuristicSuspicion,
  type SuspicionLevel,
} from "./classify.ts";

export {
  droneThink,
  setDroneWorkspace,
  releaseDroneSession,
  type DroneJudgment,
} from "./llm.ts";

export {
  Cup,
  type CupOpts,
  type CupCallbacks,
  type CupVerdict,
} from "./cup.ts";

import { Drone } from "./drone.ts";

/**
 * Stub drone — no-op object used when `droned: false`.
 * Same shape as Drone but does nothing.
 */
export function stubDrone(): Drone {
  return {
    sent() {},
    heard() {},
    observed() {},
    setWane() {},
    inspect() { return new Map(); },
    stop() {},
  } as unknown as Drone;
}
