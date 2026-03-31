/**
 * MCP tool definitions and execution.
 * Shared between the stdio server and the daemon's HTTP MCP endpoint.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, relative, extname } from "path";

import { trace } from "../log.ts";
import { fileSymbols, formatSymbols, readSymbol, isSupported as astSupported, astGrep, formatGrepMatches, searchSymbols, type Symbol } from "../lib/ast.ts";

let CWD = process.env.CLWND_CWD ?? process.cwd();

export function setCwd(cwd: string): void { CWD = cwd; }
export function getCwd(): string { return CWD; }

// ─── Permissions ────────────────────────────────────────────────────────────

interface PermRule { permission: string; pattern: string; action: string }

let permissions: PermRule[] = [];
let allowedToolSet: Set<string> | null = null; // null = all allowed

export function setPermissions(rules: PermRule[]): void { permissions = rules; }
export function setAllowedTools(tools?: string[]): void {
  allowedToolSet = tools && tools.length > 0 ? new Set(tools) : null;
}

export function loadPermissionsFromFile(): void {
  const permFile = process.env.CLWND_PERMISSIONS_FILE;
  if (!permFile) return;
  try { permissions = JSON.parse(readFileSync(permFile, "utf-8")); } catch {}
}

function checkPermission(tool: string, path?: string): void {
  // Check allowed tools list (derived from OpenCode's agent permissions)
  if (allowedToolSet && !allowedToolSet.has(tool)) {
    throw new Error(`Tool "${tool}" is not allowed in the current agent mode`);
  }
  if (permissions.length === 0) return;
  for (const rule of permissions) {
    if (rule.permission !== tool && rule.permission !== "*") continue;
    if (path) {
      const pat = rule.pattern;
      if (pat === "*" || path.startsWith(pat.replace("/*", "/")) || path === pat) {
        if (rule.action === "deny") throw new Error(`Permission denied: ${tool} on ${path}`);
        if (rule.action === "allow") return;
      }
    } else {
      if (rule.action === "deny") throw new Error(`Permission denied: ${tool}`);
      if (rule.action === "allow") return;
    }
  }
}

// ─── Directory enforcement ──────────────────────────────────────────────────

const EXTRA_ALLOWED = ["/tmp"];

function assertPath(p: string): string {
  const resolved = resolve(p);
  const dirs = [CWD, ...EXTRA_ALLOWED];
  if (dirs.some(dir => resolved.startsWith(dir + "/") || resolved === dir)) return resolved;
  throw new Error(`Path ${resolved} is outside allowed directories`);
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export const TOOLS = [
  {
    name: "read",
    description: "Read a file, directory, or code symbols. For code files (ts/js/py/go/rs), automatically returns a symbol outline showing all functions/classes/methods with line ranges, followed by the source. Use `symbol` to read ONLY a specific function/class (e.g. 'Server.start') — much cheaper than reading the whole file. Use `query` to fuzzy-search symbols and get their source (e.g. query='handle' finds handleRequest, handleAuth etc). Always print tool results to the user — they cannot see tool output directly.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file or directory to read" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read (default 500)" },
        symbol: { type: "string", description: "Read a specific symbol by name (e.g. 'graft', 'Server.start'). Dot-separated for nested." },
        query: { type: "string", description: "Fuzzy search symbols by name (e.g. 'handle', 'Config'). Returns matching symbols with source." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "edit",
    description: "Make exact string replacements in a file. old_string must be unique in the file. Use read with symbol parameter first to get the exact text to replace.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to modify" },
        old_string: { type: "string", description: "The exact text to find and replace" },
        new_string: { type: "string", description: "The replacement text" },
        replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  {
    name: "write",
    description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file to write" },
        content: { type: "string", description: "The content to write" },
      },
      required: ["file_path", "content"],
    },
  },
  {
    name: "bash",
    description: "Execute a shell command. Use ONLY for running programs, scripts, git, tests, package managers, and system commands. Do NOT use for searching code or reading files — use the read and grep tools instead, they have AST-powered symbol search.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The shell command to execute" },
        description: { type: "string", description: "Short description of what the command does" },
        timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns matching file paths. Use this to discover files, then use read with symbol/query to explore their contents — do NOT use bash for file discovery.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Glob pattern to match (e.g. '**/*.ts')" },
        path: { type: "string", description: "Directory to search in (default: cwd)" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "grep",
    description: "Search file contents using regex. For code files, returns matches with enclosing function/class context. For directories, searches recursively. Do NOT use bash grep — this tool is AST-aware and shows which symbol each match belongs to.",
    inputSchema: {
      type: "object" as const,
      properties: {
        pattern: { type: "string", description: "Regex pattern to search for" },
        path: { type: "string", description: "Directory or file to search in (default: cwd)" },
        include: { type: "string", description: "Glob pattern to filter files (e.g. '*.ts')" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "permission_prompt",
    description: "Handle permission prompts from Claude CLI. Called automatically via --permission-prompt-tool.",
    inputSchema: {
      type: "object" as const,
      properties: {
        tool_name: { type: "string", description: "Name of the tool requesting permission" },
        input: { type: "object", description: "Tool input arguments" },
      },
      required: ["tool_name"],
    },
  },
];

// ─── Permission Prompt ──────────────────────────────────────────────────────

// Callback for permission decisions — set by the daemon
let permissionCallback: ((tool: string, input: Record<string, unknown>, sessionId?: string) => Promise<{ decision: "allow" | "deny" }>) | null = null;

export function setPermissionCallback(cb: typeof permissionCallback): void {
  permissionCallback = cb;
}

// Callback for tool metadata — daemon hums it out-of-band instead of embedding in MCP response
let metaCallback: ((toolName: string, callId: string, title?: string, metadata?: Record<string, unknown>) => void) | null = null;

export function setMetaCallback(cb: typeof metaCallback): void {
  metaCallback = cb;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

function execRead(args: { file_path: string; offset?: number; limit?: number; symbol?: string; query?: string }): ToolResult {
  const p = assertPath(args.file_path);
  checkPermission("read", p);
  if (!existsSync(p)) return { output: `Error: ${p} does not exist`, title: p };

  try {
    const stat = statSync(p);
    if (stat.isDirectory()) {
      const out = execSync(`ls -la "${p}"`, { encoding: "utf-8", timeout: 5000 });
      return { output: out, title: relative(CWD, p) || p };
    }
  } catch {}

  const relPath = relative(CWD, p) || p;

  // Symbol-based read: extract just the requested symbol
  if (args.symbol) {
    const result = readSymbol(p, args.symbol);
    if (!result) return { output: `Symbol "${args.symbol}" not found in ${relPath}`, title: relPath };
    return {
      output: result.source,
      title: `${relPath}:${args.symbol}`,
      metadata: { loaded: [p] },
    };
  }

  // Fuzzy symbol search: find matching symbols and return their source
  if (args.query && astSupported(p)) {
    const allResults = searchSymbols(p, args.query);
    // Prefer functions/classes/methods over individual properties
    const results = allResults.filter(s => s.kind !== "property") .length > 0
      ? allResults.filter(s => s.kind !== "property")
      : allResults;
    if (results.length === 0) return { output: `No symbols matching "${args.query}" in ${relPath}`, title: relPath };
    const source = readFileSync(p, "utf-8").split("\n");
    const sections: string[] = [];
    for (const s of results.slice(0, 10)) {
      const range = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
      const lines = source.slice(s.startLine - 1, s.endLine).map((l, i) => `${s.startLine + i}\t${l}`).join("\n");
      sections.push(`--- ${s.kind} ${s.name} ${range} ---\n${lines}`);
    }
    const suffix = results.length > 10 ? `\n[+${results.length - 10} more matches]` : "";
    return {
      output: sections.join("\n\n") + suffix,
      title: `${relPath} ? ${args.query}`,
      metadata: { count: results.length, loaded: [p] },
    };
  }

  try {
    const content = readFileSync(p, "utf-8");
    const lines = content.split("\n");
    const totalLines = lines.length;

    // For supported code files without offset, prepend a symbol outline
    let outline = "";
    if (!args.offset && astSupported(p)) {
      try {
        const symbols = fileSymbols(p);
        if (symbols && symbols.length > 0) {
          outline = `--- symbols ---\n${formatSymbols(symbols)}\n--- source ---\n`;
        }
      } catch {}
    }

    const offset = (args.offset ?? 1) - 1;
    const limit = Math.min(args.limit ?? 500, 1000);
    const slice = lines.slice(offset, offset + limit);
    const truncated = totalLines > offset + limit;
    const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
    const suffix = truncated ? `\n[... truncated — showing ${slice.length} of ${totalLines} lines. Use offset/limit or symbol parameter to read specific sections.]` : "";
    return {
      output: outline + numbered + suffix,
      title: relPath,
      metadata: { truncated, loaded: [p] },
    };
  } catch (e: any) {
    return { output: `Error reading ${p}: ${e.message}`, title: p };
  }
}

function execEdit(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): ToolResult {
  const p = assertPath(args.file_path);
  checkPermission("edit", p);
  if (!existsSync(p)) return { output: `Error: ${p} does not exist` };

  const original = readFileSync(p, "utf-8");
  let content = original;

  if (args.replace_all) {
    if (!content.includes(args.old_string)) return { output: `Error: old_string not found in ${p}` };
    content = content.replaceAll(args.old_string, args.new_string);
  } else {
    const idx = content.indexOf(args.old_string);
    if (idx === -1) return { output: `Error: old_string not found in ${p}` };
    const secondIdx = content.indexOf(args.old_string, idx + 1);
    if (secondIdx !== -1) return { output: `Error: old_string is not unique in ${p}. Provide more context or use replace_all.` };
    content = content.replace(args.old_string, args.new_string);
  }

  writeFileSync(p, content);

  // Generate unified diff
  let diff = "";
  try {
    const { createPatch } = require("diff");
    diff = createPatch(relative(CWD, p) || p, original, content, "", "");
  } catch {}

  return {
    output: `Updated ${p}`,
    title: relative(CWD, p) || p,
    metadata: { diff, diagnostics: [] },
  };
}

function execWrite(args: { file_path: string; content: string }): ToolResult {
  const p = assertPath(args.file_path);
  checkPermission("write", p);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const existed = existsSync(p);
  writeFileSync(p, args.content);
  return {
    output: `Wrote ${p}`,
    title: relative(CWD, p) || p,
    metadata: { filepath: p, exists: existed, diagnostics: [] },
  };
}

const BASH_MAX_OUTPUT = 50 * 1024; // 50KB

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function execBash(args: { command: string; description?: string; timeout?: number }): ToolResult {
  checkPermission("bash", args.command);
  const timeout = args.timeout ?? 120_000;
  let output = "";
  let exitCode: number | null = 0;
  try {
    output = execSync(args.command, {
      encoding: "utf-8", timeout, cwd: CWD,
      env: { ...process.env, TERM: "dumb" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    output = (e.stdout ?? "") + (e.stderr ? "\n" + e.stderr : "");
    exitCode = e.status ?? 1;
  }
  output = stripAnsi(output);
  if (output.length > BASH_MAX_OUTPUT) {
    output = output.slice(0, BASH_MAX_OUTPUT) + `\n[... output truncated at ${Math.round(BASH_MAX_OUTPUT / 1024)}KB — pipe to file for full output]`;
  }
  return {
    output: output || `(exit ${exitCode ?? 0})`,
    title: args.description ?? args.command.slice(0, 80),
    metadata: {
      exit: exitCode,
      description: args.description ?? args.command.slice(0, 80),
    },
  };
}

function execGlob(args: { pattern: string; path?: string }): ToolResult {
  const dir = assertPath(args.path ?? CWD);
  checkPermission("glob", dir);
  try {
    const out = execSync(
      `shopt -s globstar nullglob; cd "${dir}" && printf '%s\\n' ${args.pattern} 2>/dev/null | head -100`,
      { encoding: "utf-8", timeout: 10000, shell: "/bin/bash" },
    );
    const files = out.trim().split("\n").filter(Boolean);
    return {
      output: files.join("\n") || "No matches found",
      title: relative(CWD, dir) || args.pattern,
      metadata: { count: files.length, truncated: files.length >= 100 },
    };
  } catch {
    return { output: "No matches found", title: args.pattern, metadata: { count: 0, truncated: false } };
  }
}

function execGrep(args: { pattern: string; path?: string; include?: string }): ToolResult {
  const target = assertPath(args.path ?? CWD);
  checkPermission("grep", target);

  // Single file + AST supported → AST grep with symbol context
  try {
    const stat = statSync(target);
    if (stat.isFile() && astSupported(target)) {
      const matches = astGrep(target, args.pattern);
      const truncated = matches.length > 100;
      const shown = truncated ? matches.slice(0, 100) : matches;
      const output = formatGrepMatches(shown, CWD);
      return {
        output: output + (truncated ? `\n[+${matches.length - 100} more matches]` : ""),
        title: args.pattern,
        metadata: { matches: matches.length, truncated },
      };
    }
  } catch {}

  // Directory or non-AST file → rg for raw search, then enrich code file hits with symbols
  let cmd = `rg --no-heading --line-number`;
  if (args.include) cmd += ` --glob "${args.include}"`;
  cmd += ` -- "${args.pattern}" "${target}" | head -100`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    const lines = out.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return { output: "No matches found", title: args.pattern, metadata: { matches: 0, truncated: false } };

    // Enrich: for each hit in a code file, try to add the enclosing symbol
    const enriched: string[] = [];
    const fileSymbolCache = new Map<string, Map<number, { name: string; kind: string }>>();

    for (const line of lines) {
      // rg output: file:line:text or line:text (single file)
      const match = line.match(/^(.+?):(\d+):(.*)$/);
      if (!match) { enriched.push(line); continue; }

      const [, file, lineNum, text] = match;
      const absFile = resolve(target, file);
      const num = parseInt(lineNum, 10);

      if (astSupported(absFile) || astSupported(file)) {
        // Build symbol map for this file (cached)
        const filePath = existsSync(absFile) ? absFile : resolve(CWD, file);
        if (!fileSymbolCache.has(filePath)) {
          try {
            const syms = fileSymbols(filePath);
            const map = new Map<number, { name: string; kind: string }>();
            if (syms) {
              const fill = (ss: Symbol[], parent = "") => {
                for (const s of ss) {
                  const full = parent ? `${parent}.${s.name}` : s.name;
                  for (let l = s.startLine; l <= s.endLine; l++) map.set(l, { name: full, kind: s.kind });
                  if (s.children) fill(s.children, full);
                }
              };
              fill(syms);
            }
            fileSymbolCache.set(filePath, map);
          } catch {
            fileSymbolCache.set(filePath, new Map());
          }
        }
        const sym = fileSymbolCache.get(filePath)?.get(num);
        if (sym) {
          enriched.push(`${file}:${lineNum}: [${sym.kind} ${sym.name}] ${text.trim()}`);
          continue;
        }
      }
      enriched.push(line);
    }

    return {
      output: enriched.join("\n"),
      title: args.pattern,
      metadata: { matches: lines.length, truncated: lines.length >= 100 },
    };
  } catch {
    return { output: "No matches found", title: args.pattern, metadata: { matches: 0, truncated: false } };
  }
}

async function execPermissionPrompt(args: { tool_name: string; input?: Record<string, unknown> }, sessionId?: string): Promise<ToolResult> {
  trace("mcp.permission.prompted", { tool: args.tool_name, sessionId });
  if (!permissionCallback) {
    return { output: JSON.stringify({ behavior: "allow", updatedInput: args.input ?? {} }) };
  }
  const result = await permissionCallback(args.tool_name, args.input ?? {}, sessionId);
  if (result.decision === "allow") {
    return { output: JSON.stringify({ behavior: "allow", updatedInput: args.input ?? {} }) };
  }
  return { output: JSON.stringify({ behavior: "deny", message: "Permission denied by user" }) };
}

// ─── External MCP tools (session-scoped) ───────────────────────────────────

export interface ExternalToolDef {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

const externalTools = new Map<string, ExternalToolDef[]>();

export function setExternalTools(sessionId: string, tools: ExternalToolDef[]): void {
  externalTools.set(sessionId, tools);
}

export function clearExternalTools(sessionId: string): void {
  externalTools.delete(sessionId);
}

export function getExternalToolNames(sessionId: string): string[] {
  return (externalTools.get(sessionId) ?? []).map(t => t.name);
}

// ─── Session-scoped visible tools (OC decides what Claude sees) ─────────────

// OC tool name → clwnd MCP tool name
const OC_TO_CLWND: Record<string, string> = {
  read: "read", edit: "edit", write: "write", bash: "bash", glob: "glob", grep: "grep",
};
const CLWND_NATIVE = new Set(Object.values(OC_TO_CLWND));

const sessionVisibleTools = new Map<string, Set<string>>();

/** Set the visible tool set for a session — derived from OC's opts.tools */
export function setVisibleTools(sessionId: string, ocToolNames: string[]): void {
  const visible = new Set<string>();
  visible.add("permission_prompt"); // always available — internal to clwnd
  for (const name of ocToolNames) {
    const clwndName = OC_TO_CLWND[name];
    if (clwndName) visible.add(clwndName);
    // External tools are added by name as-is
    const ext = externalTools.get(sessionId) ?? [];
    if (ext.some(t => t.name === name)) visible.add(name);
  }
  sessionVisibleTools.set(sessionId, visible);
}

export function clearVisibleTools(sessionId: string): void {
  sessionVisibleTools.delete(sessionId);
}

function getVisibleToolSet(sessionId: string | undefined): Set<string> | null {
  if (!sessionId) return null;
  return sessionVisibleTools.get(sessionId) ?? null;
}

// ─── External MCP client — daemon executes tools directly ──────────────────

import { spawn as spawnProc, type Subprocess } from "bun";

interface McpServerConfig {
  name: string;
  type: "local";
  command: string[];
  environment?: Record<string, string>;
}

interface McpClient {
  config: McpServerConfig;
  proc: Subprocess;
  pending: Map<number, { resolve: (v: unknown) => void; timer: ReturnType<typeof setTimeout> }>;
  nextId: number;
  buffer: string;
}

const mcpClients = new Map<string, McpClient>(); // keyed by server name

async function getMcpClient(config: McpServerConfig): Promise<McpClient> {
  const existing = mcpClients.get(config.name);
  if (existing && !existing.proc.killed) return existing;

  trace("mcp.client.spawning", { server: config.name, cmd: config.command.join(" ") });
  const proc = spawnProc({
    cmd: config.command,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...config.environment },
  });

  const client: McpClient = { config, proc, pending: new Map(), nextId: 1, buffer: "" };
  mcpClients.set(config.name, client);

  // Read stdout line by line — MCP stdio uses JSONRPC over newline-delimited JSON
  (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        client.buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = client.buffer.indexOf("\n")) !== -1) {
          const line = client.buffer.slice(0, nl).trim();
          client.buffer = client.buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const msg = JSON.parse(line);
            if (msg.id !== undefined) {
              const p = client.pending.get(msg.id);
              if (p) {
                clearTimeout(p.timer);
                client.pending.delete(msg.id);
                p.resolve(msg);
              }
            }
          } catch {}
        }
      }
    } catch {}
  })();

  // Initialize
  await mcpRpc(client, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "clwnd", version: "0.11.0" },
  });
  mcpRpc(client, "notifications/initialized", undefined, true);
  trace("mcp.client.ready", { server: config.name });
  return client;
}

function mcpRpc(client: McpClient, method: string, params?: unknown, notification = false): Promise<unknown> {
  const id = notification ? undefined : client.nextId++;
  const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  client.proc.stdin.write(msg);
  if (notification) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      client.pending.delete(id!);
      resolve({ error: { message: "MCP call timed out" } });
    }, 120_000);
    client.pending.set(id!, { resolve, timer });
  });
}

export function shutdownMcpClients(): void {
  for (const [, client] of mcpClients) {
    try { client.proc.kill(); } catch {}
  }
  mcpClients.clear();
}

// Server configs per session — set by daemon from plugin hum
const mcpServerConfigs = new Map<string, McpServerConfig[]>();

export function setMcpServerConfigs(sessionId: string, configs: McpServerConfig[]): void {
  mcpServerConfigs.set(sessionId, configs);
}

export function clearMcpServerConfigs(sessionId: string): void {
  mcpServerConfigs.delete(sessionId);
}

/** Find which MCP server owns a tool, by prefix: context7_resolve-library-id → context7 */
function findServerForTool(sessionId: string, toolName: string): McpServerConfig | null {
  const configs = mcpServerConfigs.get(sessionId) ?? [];
  for (const cfg of configs) {
    if (toolName.startsWith(cfg.name + "_")) return cfg;
  }
  return null;
}

/** Strip server prefix: context7_resolve-library-id → resolve-library-id */
function stripServerPrefix(serverName: string, toolName: string): string {
  return toolName.startsWith(serverName + "_") ? toolName.slice(serverName.length + 1) : toolName;
}

async function executeExternalTool(sessionId: string, toolName: string, args: Record<string, unknown>): Promise<string> {
  const server = findServerForTool(sessionId, toolName);
  if (!server) return `Error: no MCP server found for tool ${toolName}`;
  try {
    const client = await getMcpClient(server);
    const rawName = stripServerPrefix(server.name, toolName);
    const response = await mcpRpc(client, "tools/call", { name: rawName, arguments: args }) as {
      result?: { content?: Array<{ type: string; text?: string }> };
      error?: { message: string };
    };
    if (response.error) return `Error: ${response.error.message}`;
    const content = response.result?.content ?? [];
    return content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") || "(empty result)";
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`;
  }
}


export async function executeTool(name: string, args: Record<string, unknown>, _callId?: string, sessionId?: string): Promise<ToolResult> {
  if (name !== "permission_prompt") trace("mcp.tool.executed", { tool: name });
  switch (name) {
    case "read": return execRead(args as any);
    case "edit": return execEdit(args as any);
    case "write": return execWrite(args as any);
    case "bash": return execBash(args as any);
    case "glob": return execGlob(args as any);
    case "grep": return execGrep(args as any);
    case "permission_prompt": return execPermissionPrompt(args as any, sessionId);
    default: return { output: `Unknown tool: ${name}` };
  }
}

// ─── MCP JSON-RPC handler ───────────────────────────────────────────────────

export async function handleMcpRequest(body: { jsonrpc: string; id?: number | string; method: string; params?: any }, sessionId?: string): Promise<unknown> {
  switch (body.method) {
    case "initialize":
      return {
        jsonrpc: "2.0", id: body.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "clwnd", version: "0.3.2" },
        },
      };

    case "notifications/initialized":
      return null; // no response for notifications

    case "tools/list": {
      const ext = sessionId ? (externalTools.get(sessionId) ?? []) : [];
      const visible = getVisibleToolSet(sessionId);
      // If visible set exists, filter — OC decides what Claude sees
      const allTools = visible
        ? [...TOOLS, ...ext].filter(t => visible.has(t.name))
        : [...TOOLS, ...ext];
      return { jsonrpc: "2.0", id: body.id, result: { tools: allTools } };
    }

    case "tools/call": {
      const name = body.params?.name as string;
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;

      // External tool — execute directly via MCP client connection
      const ext = sessionId ? (externalTools.get(sessionId) ?? []) : [];
      if (ext.some(t => t.name === name)) {
        trace("mcp.tool.external", { tool: name, sessionId });
        const result = await executeExternalTool(sessionId!, name, args);
        trace("mcp.tool.external.done", { tool: name, sessionId, len: result.length });
        return {
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: result || "(no output)" }] },
        };
      }

      const callId = `mcp-${body.id ?? Date.now()}`;
      try {
        const result = await executeTool(name, args, callId, sessionId);
        // Metadata goes out-of-band via hum — Claude CLI never sees it
        if (metaCallback && (result.metadata || result.title)) {
          metaCallback(name, callId, result.title, result.metadata);
        }
        return {
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: result.output || "(no output)" }] },
        };
      } catch (e: any) {
        return {
          jsonrpc: "2.0", id: body.id,
          result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true },
        };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id: body.id, result: {} };

    default:
      if (body.id !== undefined) {
        return { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: `Method not found: ${body.method}` } };
      }
      return null;
  }
}
