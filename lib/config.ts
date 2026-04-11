import { readFileSync } from "fs";
import { join } from "path";

export interface ClwndConfig {
  maxProcs: number;
  idleTimeout: number;
  smallModel: string;
  permissionDusk: number;
  droned: boolean;
  droneModel: { providerID: string; modelID: string };
  // Whether to let OpenCode tell clwnd when it has compacted a session.
  //
  // Every 100k–200k tokens OC "compacts" your session: it summarises the
  // conversation so far and starts fresh from that summary. Clwnd has to
  // reset its own view of the Claude CLI session at that moment or the next
  // prompt will double up the history.
  //
  //   true  — clwnd listens directly to OC's "session.compacted" signal and
  //           resets instantly. Recommended if you see the chatbot getting
  //           confused or repeating itself right after a compaction.
  //   false — (default) clwnd figures it out on the next prompt instead.
  //           Slightly lazier but works against any version of OC.
  //
  // Turn this on if you hit weirdness after OC compacts. Leave it off if
  // everything feels fine.
  ocCompaction: boolean;
}

const DEFAULTS: ClwndConfig = {
  maxProcs: 4,
  idleTimeout: 30000,
  smallModel: "",
  permissionDusk: 60_000,
  droned: false,
  droneModel: { providerID: "opencode-clwnd", modelID: "claude-haiku-4-5" },
  ocCompaction: false,
};

const CONFIG_PATHS = [
  join(process.env.XDG_CONFIG_HOME ?? join(process.env.HOME ?? "/", ".config"), "clwnd", "clwnd.json"),
];

let cached: ClwndConfig | null = null;

export function loadConfig(): ClwndConfig {
  if (cached) return cached;

  for (const path of CONFIG_PATHS) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8"));
      cached = {
        maxProcs: raw.maxProcs ?? DEFAULTS.maxProcs,
        idleTimeout: raw.idleTimeout ?? DEFAULTS.idleTimeout,
        smallModel: raw.smallModel ?? DEFAULTS.smallModel,
        permissionDusk: raw.permissionDusk ?? DEFAULTS.permissionDusk,
        droned: raw.droned ?? DEFAULTS.droned,
        droneModel: raw.droneModel ?? DEFAULTS.droneModel,
        ocCompaction: raw.ocCompaction ?? DEFAULTS.ocCompaction,
      };
      return cached;
    } catch {}
  }

  cached = { ...DEFAULTS };
  return cached;
}
