export interface ClwndConfig {
  cwd?: string;
  client?: any; // OpenCode SDK client for session/permission queries
  pluginInput?: any; // Full PluginInput — project, directory, worktree, $, serverUrl
}
