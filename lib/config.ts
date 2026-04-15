import { readFileSync } from "fs";
import { join } from "path";

export interface ClwndConfig {
  maxProcs: number;
  idleTimeout: number;
  smallModel: string;
  permissionDusk: number;
  droned: boolean;
  droneModel: { providerID: string; modelID: string };
  /**
   * Experimental feature toggles. Off by default. Promoted into the
   * main config surface (or removed) once stable. Grouped here so new
   * experiments don't clutter the top level.
   */
  experimental: {
    /**
     * Linguistic sub-symbol addressing for do_code / read:
     * foo.when.body, foo.try.otherwise, foo.loop.body, foo.return, …
     * See lib/ast.ts — resolveAliasPath.
     */
    subpath: boolean;
  };
}

const DEFAULTS: ClwndConfig = {
  maxProcs: 4,
  idleTimeout: 30000,
  smallModel: "",
  permissionDusk: 60_000,
  droned: false,
  droneModel: { providerID: "opencode-clwnd", modelID: "claude-haiku-4-5" },
  experimental: {
    subpath: false,
  },
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
        experimental: {
          subpath: raw.experimental?.subpath ?? DEFAULTS.experimental.subpath,
        },
      };
      return cached;
    } catch {}
  }

  cached = { ...DEFAULTS };
  return cached;
}
