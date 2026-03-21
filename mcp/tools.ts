/**
 * MCP tool definitions and execution.
 * Shared between the stdio server and the daemon's HTTP MCP endpoint.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, relative } from "path";

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
    description: "Read a file or directory listing. Returns file contents with line numbers, or directory listing.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the file or directory to read" },
        offset: { type: "number", description: "Line number to start reading from (1-indexed)" },
        limit: { type: "number", description: "Maximum number of lines to read (default 2000)" },
      },
      required: ["file_path"],
    },
  },
  {
    name: "edit",
    description: "Make exact string replacements in a file. old_string must be unique in the file.",
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
    description: "Execute a bash command and return its output.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The bash command to execute" },
        description: { type: "string", description: "Short description of what the command does" },
        timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "glob",
    description: "Find files matching a glob pattern. Returns matching file paths.",
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
    description: "Search file contents using regex. Returns matching lines or file paths.",
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
    name: "webfetch",
    description: "Fetch content from a URL. Returns the page content as markdown, text, or HTML.",
    inputSchema: {
      type: "object" as const,
      properties: {
        url: { type: "string", description: "The URL to fetch content from" },
        format: { type: "string", description: "Output format: markdown (default), text, or html", enum: ["markdown", "text", "html"] },
        timeout: { type: "number", description: "Timeout in seconds (default 30, max 120)" },
      },
      required: ["url"],
    },
  },
];

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  output: string;
  title?: string;
  metadata?: Record<string, unknown>;
}

function execRead(args: { file_path: string; offset?: number; limit?: number }): ToolResult {
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

  try {
    const content = readFileSync(p, "utf-8");
    const lines = content.split("\n");
    const offset = (args.offset ?? 1) - 1;
    const limit = args.limit ?? 2000;
    const slice = lines.slice(offset, offset + limit);
    const truncated = lines.length > offset + limit;
    const numbered = slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
    return {
      output: numbered,
      title: relative(CWD, p) || p,
      metadata: { preview: slice.slice(0, 20).join("\n"), truncated, loaded: [p] },
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
    metadata: { diff, filediff: diff, diagnostics: [] },
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

function execBash(args: { command: string; description?: string; timeout?: number }): ToolResult {
  checkPermission("bash", args.command);
  const timeout = args.timeout ?? 120_000;
  let output = "";
  let exitCode: number | null = 0;
  try {
    output = execSync(args.command, {
      encoding: "utf-8", timeout, cwd: CWD,
      env: { ...process.env, TERM: "xterm-256color" },
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (e: any) {
    output = (e.stdout ?? "") + (e.stderr ? "\n" + e.stderr : "");
    exitCode = e.status ?? 1;
  }
  return {
    output,
    title: args.description ?? args.command.slice(0, 80),
    metadata: {
      output: output.length > 50000 ? output.slice(0, 50000) + "\n\n..." : output,
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
      `shopt -s globstar nullglob; cd "${dir}" && printf '%s\\n' ${args.pattern} 2>/dev/null | head -200`,
      { encoding: "utf-8", timeout: 10000, shell: "/bin/bash" },
    );
    const files = out.trim().split("\n").filter(Boolean);
    return {
      output: files.join("\n") || "No matches found",
      title: relative(CWD, dir) || args.pattern,
      metadata: { count: files.length, truncated: files.length >= 200 },
    };
  } catch {
    return { output: "No matches found", title: args.pattern, metadata: { count: 0, truncated: false } };
  }
}

function execGrep(args: { pattern: string; path?: string; include?: string }): ToolResult {
  const dir = assertPath(args.path ?? CWD);
  checkPermission("grep", dir);
  let cmd = `rg --no-heading --line-number`;
  if (args.include) cmd += ` --glob "${args.include}"`;
  cmd += ` "${args.pattern}" "${dir}" 2>/dev/null | head -500`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    const lines = out.trim().split("\n").filter(Boolean);
    return {
      output: out.trim() || "No matches found",
      title: args.pattern,
      metadata: { matches: lines.length, truncated: lines.length >= 500 },
    };
  } catch {
    try {
      let gcmd = `grep -rn "${args.pattern}" "${dir}"`;
      if (args.include) gcmd += ` --include="${args.include}"`;
      gcmd += " 2>/dev/null | head -500";
      const out = execSync(gcmd, { encoding: "utf-8", timeout: 15000 });
      const lines = out.trim().split("\n").filter(Boolean);
      return {
        output: out.trim() || "No matches found",
        title: args.pattern,
        metadata: { matches: lines.length, truncated: lines.length >= 500 },
      };
    } catch {
      return { output: "No matches found", title: args.pattern, metadata: { matches: 0, truncated: false } };
    }
  }
}

async function execWebfetch(args: { url: string; format?: string; timeout?: number }): Promise<ToolResult> {
  checkPermission("webfetch", args.url);

  if (!args.url.startsWith("http://") && !args.url.startsWith("https://")) {
    return { output: "Error: URL must start with http:// or https://", title: args.url };
  }

  const timeout = Math.min((args.timeout ?? 30) * 1000, 120_000);
  const format = args.format ?? "markdown";

  const headers: Record<string, string> = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
    "Accept": format === "html"
      ? "text/html,application/xhtml+xml,*/*;q=0.8"
      : "text/markdown;q=1.0, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
    "Accept-Language": "en-US,en;q=0.9",
  };

  try {
    let response = await fetch(args.url, { signal: AbortSignal.timeout(timeout), headers });

    // Retry with honest UA if Cloudflare blocks
    if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
      response = await fetch(args.url, { signal: AbortSignal.timeout(timeout), headers: { ...headers, "User-Agent": "clwnd" } });
    }

    if (!response.ok) {
      return { output: `Error: HTTP ${response.status}`, title: args.url };
    }

    const contentType = response.headers.get("content-type") || "";
    const text = await response.text();

    // HTML → markdown conversion via simple stripping if markdown requested
    let output = text;
    if (format === "markdown" && contentType.includes("text/html")) {
      // Strip tags, keep text — basic conversion
      output = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    } else if (format === "text" && contentType.includes("text/html")) {
      output = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }

    // Truncate if too large
    if (output.length > 500_000) {
      output = output.slice(0, 500_000) + "\n\n[truncated]";
    }

    return {
      output,
      title: `${args.url} (${contentType.split(";")[0]})`,
      metadata: {},
    };
  } catch (e: any) {
    return { output: `Error fetching ${args.url}: ${e.message}`, title: args.url };
  }
}

export async function executeTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "read": return execRead(args as any);
    case "edit": return execEdit(args as any);
    case "write": return execWrite(args as any);
    case "bash": return execBash(args as any);
    case "glob": return execGlob(args as any);
    case "grep": return execGrep(args as any);
    case "webfetch": return execWebfetch(args as any);
    default: return { output: `Unknown tool: ${name}` };
  }
}

// ─── MCP JSON-RPC handler ───────────────────────────────────────────────────

export async function handleMcpRequest(body: { jsonrpc: string; id?: number | string; method: string; params?: any }): Promise<unknown> {
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

    case "tools/list":
      return { jsonrpc: "2.0", id: body.id, result: { tools: TOOLS } };

    case "tools/call": {
      const name = body.params?.name as string;
      const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        const result = await executeTool(name, args);
        const content: Array<{ type: string; text: string }> = [
          { type: "text", text: result.output },
        ];
        if (result.metadata || result.title) {
          content.push({
            type: "text",
            text: `\n<!--clwnd-meta:${JSON.stringify({ title: result.title, metadata: result.metadata })}-->`,
          });
        }
        return { jsonrpc: "2.0", id: body.id, result: { content } };
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
