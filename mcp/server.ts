#!/usr/bin/env bun
/**
 * clwnd MCP server — stdio transport.
 *
 * Exposes Read, Edit, Write, Bash, Glob, Grep tools over MCP so Claude CLI
 * uses these instead of its built-in tools. This gives clwnd (and OpenCode)
 * full control over tool execution, permissions, and UI rendering.
 *
 * Protocol: JSON-RPC 2.0 over stdin/stdout (MCP stdio transport).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { execSync, spawn as cpSpawn } from "child_process";
import { resolve, dirname } from "path";
import { createInterface } from "readline";

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

// ─── Tool Execution ─────────────────────────────────────────────────────────

function execRead(args: { file_path: string; offset?: number; limit?: number }): string {
  const p = resolve(args.file_path);
  if (!existsSync(p)) return `Error: ${p} does not exist`;

  // Check if directory
  try {
    const stat = Bun.file(p);
    // Bun.file on a directory will fail on .text(), handle below
  } catch {}

  try {
    const content = readFileSync(p, "utf-8");
    const lines = content.split("\n");
    const offset = (args.offset ?? 1) - 1;
    const limit = args.limit ?? 2000;
    const slice = lines.slice(offset, offset + limit);
    return slice.map((line, i) => `${offset + i + 1}\t${line}`).join("\n");
  } catch {
    // Might be a directory
    try {
      const out = execSync(`ls -la "${p}"`, { encoding: "utf-8", timeout: 5000 });
      return out;
    } catch (e: any) {
      return `Error reading ${p}: ${e.message}`;
    }
  }
}

function execEdit(args: { file_path: string; old_string: string; new_string: string; replace_all?: boolean }): string {
  const p = resolve(args.file_path);
  if (!existsSync(p)) return `Error: ${p} does not exist`;

  let content = readFileSync(p, "utf-8");

  if (args.replace_all) {
    if (!content.includes(args.old_string)) return `Error: old_string not found in ${p}`;
    content = content.replaceAll(args.old_string, args.new_string);
  } else {
    const idx = content.indexOf(args.old_string);
    if (idx === -1) return `Error: old_string not found in ${p}`;
    const secondIdx = content.indexOf(args.old_string, idx + 1);
    if (secondIdx !== -1) return `Error: old_string is not unique in ${p}. Provide more context or use replace_all.`;
    content = content.replace(args.old_string, args.new_string);
  }

  writeFileSync(p, content);
  return `Updated ${p}`;
}

function execWrite(args: { file_path: string; content: string }): string {
  const p = resolve(args.file_path);
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(p, args.content);
  return `Wrote ${p}`;
}

function execBash(args: { command: string; timeout?: number }): string {
  const timeout = args.timeout ?? 120_000;
  try {
    const out = execSync(args.command, {
      encoding: "utf-8",
      timeout,
      cwd: process.env.CLWND_CWD ?? process.cwd(),
      env: { ...process.env, TERM: "xterm-256color" },
      maxBuffer: 10 * 1024 * 1024,
    });
    return out;
  } catch (e: any) {
    const stderr = e.stderr ?? "";
    const stdout = e.stdout ?? "";
    return `${stdout}${stderr ? "\nSTDERR:\n" + stderr : ""}\nExit code: ${e.status ?? "unknown"}`;
  }
}

function execGlob(args: { pattern: string; path?: string }): string {
  const dir = args.path ?? process.env.CLWND_CWD ?? process.cwd();
  try {
    // Use find or glob via bash
    const out = execSync(
      `find "${dir}" -path "*/${args.pattern}" -o -name "${args.pattern}" 2>/dev/null | head -200`,
      { encoding: "utf-8", timeout: 10000 },
    );
    if (!out.trim()) {
      // Try with bash globstar
      const out2 = execSync(
        `shopt -s globstar nullglob; cd "${dir}" && printf '%s\n' ${args.pattern} 2>/dev/null | head -200`,
        { encoding: "utf-8", timeout: 10000, shell: "/bin/bash" },
      );
      return out2.trim() || "No matches found";
    }
    return out.trim();
  } catch {
    return "No matches found";
  }
}

function execGrep(args: { pattern: string; path?: string; include?: string }): string {
  const dir = args.path ?? process.env.CLWND_CWD ?? process.cwd();
  let cmd = `rg --no-heading --line-number`;
  if (args.include) cmd += ` --glob "${args.include}"`;
  cmd += ` "${args.pattern}" "${dir}" 2>/dev/null | head -500`;
  try {
    const out = execSync(cmd, { encoding: "utf-8", timeout: 15000 });
    return out.trim() || "No matches found";
  } catch {
    // Fallback to grep
    try {
      let gcmd = `grep -rn "${args.pattern}" "${dir}"`;
      if (args.include) gcmd += ` --include="${args.include}"`;
      gcmd += " 2>/dev/null | head -500";
      const out = execSync(gcmd, { encoding: "utf-8", timeout: 15000 });
      return out.trim() || "No matches found";
    } catch {
      return "No matches found";
    }
  }
}

function executeTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read": return execRead(args as any);
    case "edit": return execEdit(args as any);
    case "write": return execWrite(args as any);
    case "bash": return execBash(args as any);
    case "glob": return execGlob(args as any);
    case "grep": return execGrep(args as any);
    default: return `Unknown tool: ${name}`;
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
  const msg = JSON.stringify({ jsonrpc: "2.0", id, result });
  process.stdout.write(msg + "\n");
}

function sendError(id: number | string | undefined, code: number, message: string): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  process.stdout.write(msg + "\n");
}

function sendNotification(method: string, params?: unknown): void {
  const msg = JSON.stringify({ jsonrpc: "2.0", method, params });
  process.stdout.write(msg + "\n");
}

function handleRequest(req: JsonRpcRequest): void {
  switch (req.method) {
    case "initialize": {
      sendResponse(req.id, {
        protocolVersion: "2024-11-05",
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: "clwnd",
          version: "0.2.0",
        },
      });
      // Send initialized notification
      sendNotification("notifications/initialized");
      break;
    }

    case "notifications/initialized": {
      // Client acknowledged initialization — nothing to do
      break;
    }

    case "tools/list": {
      sendResponse(req.id, { tools: TOOLS });
      break;
    }

    case "tools/call": {
      const name = req.params?.name as string;
      const args = (req.params?.arguments ?? {}) as Record<string, unknown>;

      try {
        const result = executeTool(name, args);
        sendResponse(req.id, {
          content: [{ type: "text", text: result }],
        });
      } catch (e: any) {
        sendResponse(req.id, {
          content: [{ type: "text", text: `Error: ${e.message}` }],
          isError: true,
        });
      }
      break;
    }

    case "ping": {
      sendResponse(req.id, {});
      break;
    }

    default: {
      if (req.id !== undefined) {
        sendError(req.id, -32601, `Method not found: ${req.method}`);
      }
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

const rl = createInterface({ input: process.stdin });

rl.on("line", (line: string) => {
  if (!line.trim()) return;
  try {
    const req = JSON.parse(line) as JsonRpcRequest;
    handleRequest(req);
  } catch (e: any) {
    sendError(undefined, -32700, `Parse error: ${e.message}`);
  }
});

rl.on("close", () => process.exit(0));
