import type { PluginInput } from "@opencode-ai/plugin";
import type { createOpencodeClient } from "@opencode-ai/sdk";

export interface ClwndConfig {
  cwd?: string;
  client?: ReturnType<typeof createOpencodeClient>;
  pluginInput?: PluginInput;
}
