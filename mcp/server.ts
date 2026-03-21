#!/usr/bin/env bun
/**
 * clwnd MCP server — stdio transport.
 *
 * Exposes Read, Edit, Write, Bash, Glob, Grep tools over MCP so Claude CLI
 * uses these instead of its built-in tools. Returns structured metadata so
 * OpenCode can render native UI (diff views, syntax highlighting, etc.).
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, relative, extname } from "path";
import { createInterface } from "readline";
import { createPatch } from "diff";

const CWD = process.env.CLWND_CWD ?? process.cwd();

// ─── Permissions ────────────────────────────────────────────────────────────

// OpenCode permission rules: [{permission, pattern, action}]
// permission = tool name (e.g. "read", "bash", "edit")
// pattern = glob for the argument (e.g. "*.ts", "/etc/*")
// action = "allow" | "deny" | "ask"
interface PermRule { permission: string; pattern: string; action: string }

function loadPermissions(): PermRule[] {
  const permFile = process.env.CLWND_PERMISSIONS_FILE;
  if (!permFile) return [];
  try {
    return JSON.parse(readFileSync(permFile, "utf-8"));
  } catch {
    return [];
  }
}

const permissions = loadPermissions();

function checkPermission(tool: string, path?: string): void {
  if (permissions.length === 0) return; // no rules = allow all

  for (const rule of permissions) {
    // Match tool name
    if (rule.permission !== tool && rule.permission !== "*") continue;

    // Match pattern against path (if applicable)
    if (path) {
      const pat = rule.pattern;
      if (pat === "*" || path.startsWith(pat.replace("/*", "/")) || path === pat) {
        if (rule.action === "deny") throw new Error(`Permission denied: ${tool} on ${path}`);
        if (rule.action === "allow") return; // explicit allow, stop checking
      }
    } else {
      // No path (e.g. bash) — match on tool name only
      if (rule.action === "deny") throw new Error(`Permission denied: ${tool}`);
      if (rule.action === "allow") return;
    }
  }
}

// Additional allowed directories (e.g. /tmp for scratch files)
const ALLOWED_DIRS = [CWD, "/tmp"];

function assertPath(p: string): string {
  const resolved = resolve(p);
  if (ALLOWED_DIRS.some(dir => resolved.startsWith(dir + "/") || resolved === dir)) {
    return resolved;
  }
  throw new Error(`Path ${resolved} is outside allowed directories`);
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

const TOOLS = [
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
];

// ─── Tool Execution (returns structured result for OpenCode metadata) ────────

interface ToolResult {
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
      metadata: {
        preview: slice.slice(0, 20).join("\n"),
        truncated,
        loaded: [p],
      },
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

  // Generate unified diff for OpenCode's diff renderer
  const diff = createPatch(relative(CWD, p) || p, original, content, "", "");

  return {
    output: `Updated ${p}`,
    title: relative(CWD, p) || p,
    metadata: {
      diff,
      filediff: diff,
      diagnostics: [],
    },
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
    metadata: {
      filepath: p,
      exists: existed,
      diagnostics: [],
    },
  };
}

function execBash(args: { command: string; description?: string; timeout?: number }): ToolResult {
  checkPermission("bash", args.command);
  const timeout = args.timeout ?? 120_000;
  let output = "";
  let exitCode: number | null = 0;
  try {
    output = execSync(args.command, {
      encoding: "utf-8",
      timeout,
      cwd: CWD,
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
      `shopt -s globstar nullglob; cd "${dir}" && printf '%s\n' ${args.pattern} 2>/dev/null | head -200`,
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
    // Fallback to grep
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

function executeTool(name: string, args: Record<string, unknown>): ToolResult {
  switch (name) {
    case "read": return execRead(args as any);
    case "edit": return execEdit(args as any);
    case "write": return execWrite(args as any);
    case "bash": return execBash(args as any);
    case "glob": return execGlob(args as any);
    case "grep": return execGrep(args as any);
    default: return { output: `Unknown tool: ${name}` };
  }
}

// ─── JSON-RPC / MCP Protocol ────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function sendResponse(id: number | string | undefined, result: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function sendNotification(method: string, params?: unknown): void {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

function handleRequest(req: JsonRpcRequest): void {
  switch (req.method) {
    case "initialize": {
      sendResponse(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "clwnd", version: "0.2.0" },
      });
      sendNotification("notifications/initialized");
      break;
    }

    case "notifications/initialized":
      break;

    case "tools/list": {
      sendResponse(req.id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = executeTool(name, args);
        // Return structured content — text for Claude, metadata embedded as JSON
        // for the daemon/plugin to extract and forward to OpenCode
        const content: Array<{ type: string; text: string }> = [
          { type: "text", text: result.output },
        ];
        // Embed metadata as a second content block that the plugin can parse
        if (result.metadata || result.title) {
          content.push({
            type: "text",
            text: `\n<!--clwnd-meta:${JSON.stringify({ title: result.title, metadata: result.metadata })}-->`,
          });
        }
        sendResponse(req.id, { content });
      } catch (e: any) {
        sendResponse(req.id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }
      break;
    }

    case "ping":
      sendResponse(req.id, {});
      break;

    default:
      if (req.id !== undefined) {
        sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });
rl.on("line", (line: string) => {
  if (!line.trim()) return;
  try { handleRequest(JSON.parse(line)); }
  catch (e: any) { sendError(undefined, -32700, `Parse error: ${e.message}`); }
});
rl.on("close", () => process.exit(0));
