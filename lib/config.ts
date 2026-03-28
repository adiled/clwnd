import { readFileSync } from "fs";
import { join } from "path";

export interface ClwndConfig {
  maxProcs: number;
  idleTimeout: number;
  ocCompaction: boolean;
  smallModel: string;
  permissionDusk: number;
}

const DEFAULTS: ClwndConfig = {
  maxProcs: 4,
  idleTimeout: 30000,
  ocCompaction: false,
  smallModel: "",
  permissionDusk: 60_000,
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
        ocCompaction: raw.ocCompaction ?? DEFAULTS.ocCompaction,
        smallModel: raw.smallModel ?? DEFAULTS.smallModel,
        permissionDusk: raw.permissionDusk ?? DEFAULTS.permissionDusk,
      };
      return cached;
    } catch {}
  }

  cached = { ...DEFAULTS };
  return cached;
}
