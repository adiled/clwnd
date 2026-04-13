/**
 * MCP tool definitions and execution.
 * Shared between the stdio server and the daemon's HTTP MCP endpoint.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, readdirSync, type Stats } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, relative, extname, join as pathJoin } from "path";

import { trace } from "../log.ts";
import { penny } from "../lib/penny.ts";
import { fileSymbols, formatSymbols, readSymbol, isSupported as astSupported, astGrep, searchSymbols, validateSyntax, symbolByteRange, type Symbol } from "../lib/ast.ts";
import { resolveWord, resolvePhrase, resolveSentence, resolveParagraph, discoverAnchors, formatAnchors } from "../lib/linguistic.ts";

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
    description: `The ONE filesystem analysis tool. It discovers, studies, and searches — replacing any line-based read, any glob, any grep. No offset, no limit, no pagination. Code is analysed via tree-sitter so you reason about symbols, not text pages.

═══════════════════════════════════════════════════════════════════
QUICKSTART — five concrete tasks and the exact call:
═══════════════════════════════════════════════════════════════════
1. "What's in this file?"
     → read('/abs/path/daemon.ts')
     returns: file stats + first 20 lines + full symbol outline + hints

2. "Show me the foo() function"
     → read('/abs/path/daemon.ts', symbol: 'foo')
     returns: just foo's source, line-numbered

3. "Find every trace() call in daemon.ts"
     → read('/abs/path/daemon.ts', pattern: 'trace\\\\(')
     returns: every matching line with its enclosing symbol,
              e.g. "daemon.ts:82 [function ClaudeNest.awaken] trace(…"

4. "Find all handlers across src/"
     → read('/abs/path/src', query: 'handle')
     recursively fuzzy-matches symbol names across the whole tree

5. "What .py tests exist?"
     → read('/abs/path/**/test_*.py')
     glob expands, returns one-line inventory per file

═══════════════════════════════════════════════════════════════════
path semantics (auto-detected):
  /abs/path/file           → single file
  /abs/path/dir            → walks the tree (skips node_modules, .git, …)
  /abs/path/**/glob.pattern → glob expands (detected by * or ?)

modifiers (pick at most one, mutually exclusive):
  symbol: 'X'     exact symbol by name. Dot-nested: 'Class.method'.
  query:  'sub'   fuzzy substring match on symbol NAMES.
  pattern: 'regex' regex on file CONTENT. For code, each match carries
                   its enclosing function/class symbol.

═══════════════════════════════════════════════════════════════════
RULES:
- No offset, no limit, no line numbers in the request — that is not
  how an agent should interact with code. If you catch yourself
  wanting "lines 400-800 of X", you want read(X, symbol: 'SomeFunc')
  or read(X, pattern: 'thing-I-was-looking-for').
- Start with the modifier-free call read(path) ONLY when you don't
  know the file yet. If you already know what you want, go straight
  to symbol/pattern/query — the modifier-free call is slower.
- AST-backed code: ts/tsx/js/jsx/py/go/rs. Other files get plain
  line-based regex for pattern and full content for the default read.
- Always print the tool result to the user — they cannot see it
  directly.
- This tool is self-sufficient. Do NOT reach for bash ls/find/grep/
  cat/head/tail — they are hard-banned and will be rejected with a
  redirect back to this tool.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute file path, absolute directory path, or glob pattern (detected by presence of * or ?). Examples: '/home/user/src/auth.ts', '/home/user/src', '/home/user/src/**/*.ts', '/home/user/**/test_*.py'." },
        symbol: { type: "string", description: "Extract a specific symbol by exact name. Dot-separated for nested members (e.g. 'Server.start', 'ClaudeNest.awaken'). Works across whatever the path resolves to — pass a directory or glob to search the symbol in every file." },
        query: { type: "string", description: "Fuzzy case-insensitive substring match on symbol NAMES (not content). Returns each matching symbol's source. Use this for 'find anything whose name looks like X'." },
        pattern: { type: "string", description: "Regex over file CONTENT. For code files, each match is returned with its enclosing function/class symbol so you know which structural unit to read next. For non-code files, plain regex over lines." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "do_code",
    description: `Author code. You are writing code — think like a developer in the target language.

COMMON SENSE — apply these every time, don't wait to be told:
  - IMPORTS: if your new code references a module, type, or function that isn't already imported, add the import. Don't write code that won't compile because an import is missing.
  - STYLE: read the file first. Match the existing conventions — semicolons or not, single quotes or double, tabs or spaces, trailing commas. Don't impose your own preference on someone else's codebase.
  - TYPES: if the file is TypeScript, write TypeScript. If it's Python with type hints, add type hints. Don't downgrade typed code to untyped because you're being lazy.
  - NAMING: camelCase in JS/TS, snake_case in Python/Rust/Ruby, PascalCase for classes everywhere. Follow the language's conventions, not a generic one.
  - COMPLETENESS: don't write placeholder comments like "// implement this" or "# TODO". Write the actual implementation. If you can't implement it, say so in your response, don't hide it in a comment.
  - ERROR HANDLING: if the existing code handles errors (try/catch, Result types, error returns), your new code should too. Don't add a function that ignores errors when every neighbor handles them.
  - SCOPE: change what was asked. Don't refactor neighboring code, don't "clean up" imports you didn't touch, don't add features that weren't requested.

LANGUAGE COVERAGE (AST-grounded — re-parsed, symbol-scoped edits work):
  .ts .tsx .js .jsx .mjs .cjs  .py .pyi  .go  .rs  .java  .c .h
  .cc .cpp .cxx .hpp .hxx  .rb  .php  .cs  .sh .bash  .vue
  Also accepted (text-only, no symbol ops): .kt .kts .swift .scala .lua .zsh .fish .svelte .sql
  Anything else → use do_noncode.

OPERATIONS:
  create           — new file. Syntax-validated before write.
  replace + symbol — splice one symbol. Pass the FULL new source of that symbol.
  replace (no sym) — whole-file rewrite. Use only when most lines are changing.
  insert_after/before — add code adjacent to a symbol anchor.
  delete           — remove a symbol.

WORKFLOW: read(file) first → see symbol outline → do_code(file, symbol, new_source). The read is required (staleness guard). After editing, verify with read(file, symbol: 'name').`,
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to the code file. Must have a code extension (ts, py, go, rs, java, cpp, etc.) — do_code refuses non-code." },
        operation: { type: "string", description: "One of: create, replace, insert_before, insert_after, delete. Default: replace." },
        symbol: { type: "string", description: "Target symbol name. Required for replace (unless rewriting the whole file), insert_before, insert_after, delete. Dot-separated for nested (e.g. 'Class.method')." },
        new_source: { type: "string", description: "The new source code. Required for create, replace, insert_before, insert_after. For symbol-scoped replace, pass the full new source of that symbol. For whole-file replace, pass the entire new file content." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "do_noncode",
    description: `Edit non-code files using linguistic scope. The ONLY way to author non-code in clwnd.

Text has four units: word, phrase, sentence, paragraph. Each parameter names a scope level. Pass exactly ONE scope parameter to tell clwnd what you're editing and how to find it.

WORD — find a token and swap it. Format-agnostic. Any single token bounded by spaces/punctuation.
  do_noncode(file, word: 'localhost', replace: '0.0.0.0')
  do_noncode(file, word: 'true', replace: 'false')
  do_noncode(file, word: 'docker', replace: 'podman')

PHRASE — address by structural name OR quote exact text. Format-aware.
  For structural names (keys, headings, env vars): the name stays, its governed scope is replaced.
  For exact text: the quoted span is replaced directly.
  do_noncode(file, phrase: 'DATABASE_URL', replace: 'postgres://new/db')
  do_noncode(file, phrase: 'provider.ollama', replace: '{ "npm": "new-pkg" }')
  do_noncode(file, phrase: 'server.port', replace: '9090')
  do_noncode(file, phrase: '## Setup', replace: 'New instructions.\\n')
  do_noncode(file, phrase: '[database]', replace: 'host = new\\nport = 5432\\n')
  do_noncode(file, phrase: '"tool_call": true', replace: '"tool_call": false')

SENTENCE — quote text within a sentence. Scope expands to the smallest independent unit.
  JSON: comma-delimited entry. YAML: sibling key + children. Env/TOML/Markdown: single line.
  do_noncode(file, sentence: 'port = 3000', replace: 'port = 9090')

PARAGRAPH — quote text within a paragraph. Scope expands to the full block.
  JSON: enclosing { } or [ ]. YAML: indentation block. TOML: [section]. Env/Markdown: blank lines.
  do_noncode(file, paragraph: 'enabled = true', replace: '[new-section]\\nkey = value\\n')

Omit 'replace' to DELETE the scope. No scope parameter = create/overwrite the whole file.

FORMAT SENSE: respect existing formatting. JSON must stay valid. YAML indentation IS structure. Change what was asked — don't reformat neighbors.

ACCEPTS: configs, docs, markup, stylesheets, data, plain text. REFUSES: code files → use do_code.
WORKFLOW: read(file) first → see structure → do_noncode with the right scope.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        file_path: { type: "string", description: "Absolute path to a non-code file." },
        word: { type: "string", description: "A single token to find and swap. Format-agnostic — works on any file. Bounded by spaces/punctuation." },
        phrase: { type: "string", description: "Structural name OR exact text. For keys/headings/env vars: the name stays, governed scope is replaced. For quoted text: the span is replaced. Use dot notation for nested keys (provider.ollama.models)." },
        sentence: { type: "string", description: "Text within a sentence. Scope expands to the smallest independent unit — comma entry (JSON), sibling key (YAML), single line (env/TOML/markdown)." },
        paragraph: { type: "string", description: "Text within a paragraph. Scope expands to the full block — enclosing {} (JSON), indentation block (YAML), [section] (TOML), blank lines (env/markdown)." },
        replace: { type: "string", description: "Replacement content. Omit to delete the scope. No scope parameter = create/overwrite the whole file." },
      },
      required: ["file_path"],
    },
  },
  {
    name: "bash",
    description: "Execute a shell command. This is the escape hatch for actions that aren't filesystem analysis or modification: running tests, git operations, build scripts, package managers, starting/stopping services, invoking language runtimes, calling CLI utilities.\n\nHARD BANNED COMMANDS — if the first token (or the first token after a pipe/&&/||/;) is one of these, the call is rejected with a redirect to the right `read` invocation, NO shell execution happens: `ls`, `find`, `grep`, `rg`, `ripgrep`, `cat`, `head`, `tail`, `sed`, `awk`, `cut`, `sort -u`, `uniq`, `wc`, `more`, `less`, `tree`, `du`, `file`, `od`, `xxd`, `strings`. Do not try to wrap these in `bash -c`, `sh -c`, `env`, or shell functions — the filter checks after unwrapping.\n\nThe correct tool for EVERY file-inspection task is `read`: `read(path)` for a directory listing or file study view; `read(path, pattern: 'regex')` for content search (AST-aware for code); `read(path, symbol: 'X')` for a specific symbol; `read(path, query: 'sub')` for fuzzy symbol name search; `read('/glob/**/*.ts')` for glob file discovery. There is NO case where bash beats read for file inspection — if you think there is, you're misreading the task.\n\nUse bash for: `git <anything>`, `npm/yarn/pnpm/bun <anything>`, `pip/uv/cargo/go <anything>`, `tsc`, `make`, `pytest`, `jest`, `docker`, `systemctl`, `journalctl`, `curl`, `wget`, `kill`, `ps`, `date`, `whoami`, `echo`, `printf`, and anything else that isn't file-content inspection. Output over 30 KB is truncated.",
    inputSchema: {
      type: "object" as const,
      properties: {
        command: { type: "string", description: "The shell command to execute. File-inspection commands (ls, find, grep, cat, head, tail, sed, awk, etc.) are rejected — use `read` instead." },
        description: { type: "string", description: "Short description of what the command does" },
        timeout: { type: "number", description: "Timeout in milliseconds (default 120000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "task",
    description: `Launch a subagent to handle a complex task autonomously in a separate context window. The subagent gets its own conversation, its own tools (read, do_code, do_noncode, bash), and returns a compact summary when done. Your main context stays clean — you only see the final result, not the intermediate work.

Use task when:
  - Research across multiple files/repos that would bloat your context
  - Multi-step work you can delegate (code review, refactoring a module, writing tests)
  - Parallel work — launch multiple tasks in one message for concurrent execution

Don't use task when:
  - Simple file reads (use read directly)
  - Single-file edits (use do_code directly)
  - Quick questions (just answer them)

The subagent starts fresh unless you provide task_id to resume a previous task session.`,
    inputSchema: {
      type: "object" as const,
      properties: {
        description: { type: "string", description: "Short (3-5 word) description of the task" },
        prompt: { type: "string", description: "Detailed instructions for the subagent" },
        subagent_type: { type: "string", description: "Agent type to use (e.g. 'build', 'plan', or a custom agent name)" },
        task_id: { type: "string", description: "Resume a previous task session by passing its task_id" },
      },
      required: ["description", "prompt", "subagent_type"],
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

// Per-session "already served" cache for read results. Keyed by sid → cacheKey
// → mtime, where cacheKey is path+"#"+argsSignature. Full-file reads share a
// signature (the empty string); partial reads (offset/limit/symbol/query) each
// get their own signature, so repeating the EXACT same partial read returns
// the placeholder while a different partial view on the same file still runs.
//
// The `pathIndex` side-map tracks which cacheKeys belong to each absPath so
// execEdit/execWrite can invalidate all views of a file at once when the file
// mutates. Without it, a Write would leave stale partial-view entries cached
// past their validity.
//
// Targets the single biggest penny burn from the JSONL dissection: daemon.ts
// was Read 558 times in one session, ~39MB of redundant content. Claude Code
// natively has `readFileState` dedup for full reads — clwnd's MCP routing
// disabled that, so this re-implements parity plus partial-read coverage that
// native doesn't have.
const readCache = new Map<string, Map<string, number>>();
const readCachePathIndex = new Map<string, Map<string, Set<string>>>(); // sid → path → Set<cacheKey>

// Separate "Claude has touched this file in this session" ground-truth map.
// Used ONLY by the staleness guard. Unlike readCache (which drops entries
// on Edit so the next Read sees fresh content), sessionTouched keeps
// tracking across edits — an edit _establishes_ a known baseline, and the
// next edit should see that baseline as current. Without this separation,
// back-to-back edits after an external mutation would go unnoticed.
//
// v0.17 switched from mtime-only to content hash. mtime has 1-second
// resolution on most filesystems — a read + write + read + write within
// one second would show the same mtime and the guard would miss the change.
// Content hash catches that because the bytes actually differ. The hash is
// cheap (djb2 over the first 64KB) and only computed on read/write, not
// on every access — it's a snapshot-at-touch, not a live check.
interface TouchBaseline {
  hash: string;
  mtime: number;
  size: number;
}

const sessionTouched = new Map<string, Map<string, TouchBaseline>>();

function contentHash(content: string): string {
  // djb2 over the first 64KB — fast, sufficient for same-content detection.
  // Not cryptographic, not meant to be. A full-file hash on a 5MB file
  // would add 2-3ms per touch; 64KB prefix hash adds <0.1ms.
  const end = Math.min(content.length, 65536);
  let h = 5381;
  for (let i = 0; i < end; i++) h = ((h << 5) + h + content.charCodeAt(i)) | 0;
  return h.toString(36) + ":" + content.length;
}

function touchSession(sessionId: string | undefined, absPath: string, content?: string): void {
  if (!sessionId) return;
  let m = sessionTouched.get(sessionId);
  if (!m) { m = new Map(); sessionTouched.set(sessionId, m); }
  try {
    const stat = statSync(absPath);
    const src = content ?? readFileSync(absPath, "utf-8");
    m.set(absPath, { hash: contentHash(src), mtime: stat.mtimeMs, size: stat.size });
  } catch {}
}

function touchedBaseline(sessionId: string | undefined, absPath: string): TouchBaseline | undefined {
  if (!sessionId) return undefined;
  return sessionTouched.get(sessionId)?.get(absPath);
}

function readCacheKey(absPath: string, args?: { symbol?: string; query?: string; pattern?: string }): string {
  if (!args || (!args.symbol && !args.query && !args.pattern)) return absPath + "#";
  return absPath + "#s=" + (args.symbol ?? "") + "&q=" + (args.query ?? "") + "&p=" + (args.pattern ?? "");
}
function readCacheCheck(sessionId: string, key: string, mtime: number): boolean {
  const sess = readCache.get(sessionId);
  return !!sess && sess.get(key) === mtime;
}
function readCacheMark(sessionId: string, absPath: string, key: string, mtime: number): void {
  let sess = readCache.get(sessionId);
  if (!sess) { sess = new Map(); readCache.set(sessionId, sess); }
  sess.set(key, mtime);
  let pathMap = readCachePathIndex.get(sessionId);
  if (!pathMap) { pathMap = new Map(); readCachePathIndex.set(sessionId, pathMap); }
  let keySet = pathMap.get(absPath);
  if (!keySet) { keySet = new Set(); pathMap.set(absPath, keySet); }
  keySet.add(key);
}
function readCacheInvalidate(sessionId: string | undefined, absPath: string): void {
  if (!sessionId) {
    // Cross-session: wipe every view of this path
    for (const [sid, sess] of readCache) {
      const keySet = readCachePathIndex.get(sid)?.get(absPath);
      if (keySet) {
        for (const k of keySet) sess.delete(k);
        readCachePathIndex.get(sid)?.delete(absPath);
      }
    }
    return;
  }
  const sess = readCache.get(sessionId);
  const keySet = readCachePathIndex.get(sessionId)?.get(absPath);
  if (sess && keySet) {
    for (const k of keySet) sess.delete(k);
    readCachePathIndex.get(sessionId)?.delete(absPath);
  }
}
export function clearReadCache(sessionId: string): void {
  readCache.delete(sessionId);
  readCachePathIndex.delete(sessionId);
  sessionTouched.delete(sessionId);
}

// Extensions handled via a special path inside execRead instead of the
// generic line-numbered flow. Images return a helpful error; .ipynb parses
// JSON cells; PDFs shell out to pdftotext if available.
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff", ".ico", ".svg"]);
const PDF_EXT = ".pdf";
const IPYNB_EXT = ".ipynb";

// Output budget — safely under Claude CLI's 2000-tokens-per-tool-result cap
// (eEH=2000 in the Claude binary, with UtH=4 chars/token → ~8000 char ceiling).
// 7500 leaves ~500-char headroom for framing while still giving pattern
// searches on busy regexes (86+ matches) enough space to deliver every hit
// in a single call. Earlier 6000-char value forced pattern searches into
// compact/minimal truncation, which Claude then interpreted as "narrow the
// search more" and issued dozens of prefix-scoped follow-ups.
const MAX_READ_OUTPUT = 7500;
// Hard cap on number of files a single read call will resolve when given a
// dir or glob — prevents a read of `/` from exploding into thousands of files.
const MAX_RESOLVED_TARGETS = 200;
// Directories we never recurse into when walking a tree. Keeping this list
// small and conservative — real source directories that happen to share
// these names (e.g. a directory called `test`) should still be walked.
const SKIP_DIR_NAMES = new Set([
  "node_modules", ".git", ".svn", ".hg", "dist", "build", ".next", ".nuxt",
  ".turbo", "target", "__pycache__", ".venv", "venv", ".mypy_cache",
  ".pytest_cache", ".cache", "coverage", ".idea", ".vscode",
]);

function isGlobPattern(path: string): boolean {
  return /[*?[\]]/.test(path);
}

// Expand a glob pattern to a list of absolute file paths. Uses the shell's
// globstar + nullglob so `**` walks the tree and no-match becomes empty
// instead of the literal pattern. Sorted newest-first by mtime.
function expandGlobPattern(pattern: string): string[] {
  // Decide the base dir: absolute patterns expand from the first component
  // that has no wildcard; relative patterns expand from CWD.
  let baseDir: string;
  let pat: string;
  if (pattern.startsWith("/")) {
    const parts = pattern.split("/");
    const firstWild = parts.findIndex(seg => isGlobPattern(seg));
    if (firstWild === -1) {
      // No wildcard despite the classifier — fall through as a literal.
      return existsSync(pattern) ? [pattern] : [];
    }
    baseDir = parts.slice(0, firstWild).join("/") || "/";
    pat = parts.slice(firstWild).join("/");
  } else {
    baseDir = CWD;
    pat = pattern;
  }
  try {
    const out = execSync(
      `shopt -s globstar nullglob; cd "${baseDir}" && printf '%s\\0' ${pat} 2>/dev/null | ` +
      `xargs -0 -r stat -c '%Y %n' 2>/dev/null | sort -rn | head -${MAX_RESOLVED_TARGETS} | cut -d' ' -f2-`,
      { encoding: "utf-8", timeout: 10000, shell: "/bin/bash" },
    );
    return out.trim().split("\n").filter(Boolean).map(f => resolve(baseDir, f));
  } catch {
    return [];
  }
}

// Walk a directory tree for regular files, up to `max`. Skips common junk
// directories (SKIP_DIR_NAMES) and anything starting with a dot. Used only
// internally — the agent-visible API is `read(path)` where path is the dir.
function walkDirectory(dir: string, max = MAX_RESOLVED_TARGETS): string[] {
  const results: string[] = [];
  const stack: string[] = [dir];
  while (stack.length > 0 && results.length < max) {
    const d = stack.pop()!;
    let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    try {
      // Force the utf-8 string variant of Dirent — without an explicit
      // encoding, Bun/Node's types widen to NonSharedBuffer.
      entries = readdirSync(d, { withFileTypes: true, encoding: "utf-8" }) as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
    } catch { continue; }
    for (const e of entries) {
      if (results.length >= max) break;
      const full = pathJoin(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name) || e.name.startsWith(".")) continue;
        stack.push(full);
      } else if (e.isFile()) {
        results.push(full);
      }
    }
  }
  return results;
}

// Resolve a user-supplied path into a concrete list of file paths. The path
// may be an absolute file, an absolute directory (recursively walked), or a
// glob pattern (detected by the presence of * or ?). Returns an empty list
// when the path cannot be resolved or when nothing matches.
function resolveReadTargets(rawPath: string): string[] {
  if (isGlobPattern(rawPath)) return expandGlobPattern(rawPath);
  let p: string;
  try { p = assertPath(rawPath); } catch { return []; }
  if (!existsSync(p)) return [];
  let stat: Stats;
  try { stat = statSync(p); } catch { return []; }
  if (stat.isFile()) return [p];
  if (stat.isDirectory()) return walkDirectory(p);
  return [];
}

// Best-effort line count for a file — used in inventory views and the
// code-file study header. Falls back to 0 on read failure.
function safeLineCount(p: string): number {
  try { return readFileSync(p, "utf-8").split("\n").length; } catch { return 0; }
}

// Build the STUDY VIEW for a single code file. This is what `read(file)`
// returns when no modifier is set: header with size info, first 20 lines of
// the file (imports + top-of-file context), the full AST symbol outline
// (with ranges), and a short "drill in" hint block. Capped at
// MAX_READ_OUTPUT; oversized outlines are truncated with a query hint.
function studyCodeFile(p: string, stat: Stats, sessionId?: string): ToolResult {
  const relPath = relative(CWD, p) || p;
  const ext = extname(p).toLowerCase();
  const content = readFileSync(p, "utf-8");
  const lines = content.split("\n");
  const preambleLines = Math.min(20, lines.length);
  const preamble = lines.slice(0, preambleLines).map((l, i) => `${i + 1}\t${l}`).join("\n");

  let outlineText = "(no symbols detected)";
  let symbolCount = 0;
  try {
    const symbols = fileSymbols(p);
    if (symbols && symbols.length > 0) {
      symbolCount = symbols.length;
      const formatted = formatSymbols(symbols);
      // Keep outline under ~3.5KB so the whole study view fits the cap.
      if (formatted.length > 3500) {
        outlineText = formatted.slice(0, 3500) +
          `\n[outline truncated — ${symbols.length} top-level symbols. Use read('${relPath}', query: 'name') to narrow.]`;
      } else {
        outlineText = formatted;
      }
    }
  } catch {}

  const header = `=== ${relPath} — ${lines.length} lines, ${(stat.size / 1024).toFixed(1)} KB, ${ext.slice(1) || "text"} ===`;
  const hints = [
    `read('${relPath}', symbol: 'NAME')       — exact source of a symbol (dot-nested: 'Class.method')`,
    `read('${relPath}', query: 'substring')   — fuzzy match symbol names`,
    `read('${relPath}', pattern: 'regex')     — AST-aware content search`,
  ].join("\n");

  let output = `${header}\n\n--- preamble (first ${preambleLines} lines) ---\n${preamble}\n\n--- symbols ---\n${outlineText}\n\n--- drill in ---\n${hints}`;
  if (output.length > MAX_READ_OUTPUT) {
    output = output.slice(0, MAX_READ_OUTPUT - 200) +
      `\n\n[study view truncated — drill in with symbol/query/pattern]`;
  }

  if (sessionId) {
    try {
      readCacheMark(sessionId, p, readCacheKey(p, {}), stat.mtimeMs);
      touchSession(sessionId, p);
    } catch {}
  }
  return {
    output,
    title: relPath,
    metadata: { studyView: true, symbols: symbolCount, lines: lines.length, loaded: [p] },
  };
}

// Return a non-code text file in full when it fits, or a head+tail view with
// guidance when it doesn't. No offset/limit — if the agent needs a specific
// region of a big text file, they should use read(path, pattern: 'regex').
function studyTextFile(p: string, stat: Stats, sessionId?: string): ToolResult {
  const relPath = relative(CWD, p) || p;
  let content: string;
  try { content = readFileSync(p, "utf-8"); } catch (e) {
    return { output: `Error reading ${p}: ${(e as Error).message}`, title: relPath };
  }

  const lines = content.split("\n");
  const preambleLines = Math.min(20, lines.length);
  const preamble = lines.slice(0, preambleLines).map((l, i) => `${i + 1}\t${l}`).join("\n");

  // Discover addressable anchors — the non-code equivalent of symbols.
  let anchorText = "(no addressable anchors detected)";
  let anchorCount = 0;
  try {
    const anchors = discoverAnchors(content, p);
    if (anchors.length > 0) {
      anchorCount = anchors.length;
      const formatted = formatAnchors(anchors);
      if (formatted.length > 3500) {
        anchorText = formatted.slice(0, 3500) +
          `\n[outline truncated — ${anchors.length} anchors. Use read('${relPath}', pattern: 'regex') to narrow.]`;
      } else {
        anchorText = formatted;
      }
    }
  } catch {}

  const ext = extname(p).toLowerCase();
  const header = `=== ${relPath} — ${lines.length} lines, ${(stat.size / 1024).toFixed(1)} KB, ${ext.slice(1) || "text"} ===`;
  const hints = [
    `read('${relPath}', pattern: 'regex')              — search content`,
    `do_noncode('${relPath}', target: 'ANCHOR', content: '...')  — edit a specific anchor`,
  ].join("\n");

  let output: string;
  if (content.length <= MAX_READ_OUTPUT && anchorCount === 0) {
    // Small file with no structure — show full content (legacy behavior for plain text)
    output = content;
  } else {
    // Structured study view — preamble + anchor outline + drill-in hints
    output = `${header}\n\n--- preamble (first ${preambleLines} lines) ---\n${preamble}\n\n--- anchors ---\n${anchorText}\n\n--- edit ---\n${hints}`;
    // If the file is small enough, append the full content below the outline
    if (content.length <= MAX_READ_OUTPUT - output.length - 200) {
      output += `\n\n--- full content ---\n${content}`;
    }
  }

  if (output.length > MAX_READ_OUTPUT) {
    output = output.slice(0, MAX_READ_OUTPUT - 200) +
      `\n\n[study view truncated — use pattern or target to drill in]`;
  }

  if (sessionId) {
    try {
      readCacheMark(sessionId, p, readCacheKey(p, {}), stat.mtimeMs);
      touchSession(sessionId, p);
    } catch {}
  }
  return {
    output,
    title: relPath,
    metadata: { studyView: true, anchors: anchorCount, lines: lines.length, loaded: [p] },
  };
}

// Rich-media dispatch that still exists independent of line counts. Images
// are never rendered; PDFs are text-extracted in full; notebooks are cell-
// dumped. All oversized variants truncate with guidance rather than
// paginate.
function studyRichMedia(p: string, stat: Stats): ToolResult | null {
  const relPath = relative(CWD, p) || p;
  const ext = extname(p).toLowerCase();
  if (IMAGE_EXTS.has(ext)) {
    return {
      output: `[clwnd: ${relPath} is an image (${(stat.size / 1024).toFixed(1)} KB, ${ext.slice(1).toUpperCase()}). Image rendering is not served by clwnd's Read tool. Use \`bash file "${p}"\` or \`bash identify "${p}"\` for metadata, or let the user attach the image directly.]`,
      title: relPath,
      metadata: { filetype: "image", size: stat.size },
    };
  }
  if (ext === PDF_EXT) {
    try {
      const text = execSync(`pdftotext -layout -q "${p}" - 2>/dev/null`, { encoding: "utf-8", timeout: 30000 });
      const prefix = `[clwnd: ${relPath} (${(stat.size / 1024).toFixed(1)} KB PDF, extracted via pdftotext)]\n`;
      if (prefix.length + text.length <= MAX_READ_OUTPUT) {
        return { output: prefix + text, title: relPath, metadata: { filetype: "pdf", size: stat.size } };
      }
      const slice = Math.floor((MAX_READ_OUTPUT - 500) / 2);
      return {
        output: prefix +
          `(${Math.round(text.length / 1024)} KB of extracted text — too large for one response. Showing head + tail. Use read('${relPath}', pattern: 'regex') for targeted search.)\n\n` +
          `--- head ---\n${text.slice(0, slice)}\n\n--- tail ---\n${text.slice(-slice)}`,
        title: relPath,
        metadata: { filetype: "pdf", size: stat.size, truncated: true },
      };
    } catch {
      return {
        output: `[clwnd: ${relPath} is a PDF but pdftotext is not available. Install with \`apt install poppler-utils\` / \`brew install poppler\`.]`,
        title: relPath,
        metadata: { filetype: "pdf", size: stat.size },
      };
    }
  }
  if (ext === IPYNB_EXT) {
    try {
      const raw = JSON.parse(readFileSync(p, "utf-8")) as { cells?: Array<{ cell_type?: string; source?: string[] | string }> };
      const cells = raw.cells ?? [];
      const sections: string[] = [`[clwnd: ${relPath} — ${cells.length} cells, outputs omitted]`];
      cells.forEach((c, i) => {
        const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
        const kind = (c.cell_type ?? "unknown").toUpperCase();
        sections.push(`--- cell ${i + 1} (${kind}) ---\n${src}`);
      });
      const body = sections.join("\n\n");
      if (body.length <= MAX_READ_OUTPUT) {
        return { output: body, title: relPath, metadata: { filetype: "notebook", cells: cells.length } };
      }
      // Oversized notebook — summarize cell structure, do not dump.
      const headers = [`[clwnd: ${relPath} — ${cells.length} cells, total ${(body.length / 1024).toFixed(1)} KB. Too large for one response. Summarizing cell structure.]`];
      cells.forEach((c, i) => {
        const src = Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
        const firstLine = src.split("\n")[0]?.slice(0, 80) ?? "";
        headers.push(`  cell ${i + 1} (${c.cell_type ?? "unknown"}) — ${src.length} bytes — ${firstLine}`);
      });
      headers.push(``, `Use read('${relPath}', pattern: 'regex') for targeted search within cells.`);
      return {
        output: headers.join("\n"),
        title: relPath,
        metadata: { filetype: "notebook", cells: cells.length, truncated: true },
      };
    } catch (e) {
      return { output: `Error parsing notebook ${p}: ${(e as Error).message}`, title: relPath };
    }
  }
  return null;
}

// Compact inventory for directory/glob reads without a modifier. One line
// per file with size and (for code files) top-level symbol count. Capped to
// MAX_READ_OUTPUT; larger sets are truncated with a narrow-the-path hint.
function inventoryTargets(paths: string[]): ToolResult {
  const header = `=== ${paths.length} file(s) resolved ===`;
  const lines: string[] = [header, ``];
  let totalBytes = 0;
  let shown = 0;
  let bodyLen = header.length + 2;
  for (const p of paths) {
    let info: string;
    try {
      const stat = statSync(p);
      totalBytes += stat.size;
      const rel = relative(CWD, p) || p;
      const lineCount = safeLineCount(p);
      let extra = `${lineCount}L, ${(stat.size / 1024).toFixed(1)}KB`;
      if (astSupported(p)) {
        try {
          const syms = fileSymbols(p);
          extra += `, ${syms?.length ?? 0} top-level symbols`;
        } catch {}
      }
      info = `${rel} — ${extra}`;
    } catch {
      info = `${p} — (stat failed)`;
    }
    if (bodyLen + info.length + 1 > MAX_READ_OUTPUT - 300) {
      lines.push(`[+${paths.length - shown} more files — narrow the path for a shorter list]`);
      break;
    }
    lines.push(info);
    bodyLen += info.length + 1;
    shown++;
  }
  lines.push(``);
  lines.push(`total: ${(totalBytes / 1024).toFixed(1)} KB`);
  lines.push(``);
  lines.push(`drill in:`);
  lines.push(`  read('<path>')                    — study a specific file`);
  lines.push(`  read('<path>', symbol: 'NAME')    — exact symbol`);
  lines.push(`  read('<path>', query: 'substr')   — fuzzy symbol match`);
  lines.push(`  read('<path>', pattern: 'regex')  — content search`);
  return {
    output: lines.join("\n"),
    title: `${paths.length} files`,
    metadata: { count: paths.length, shown, totalBytes },
  };
}

// Collect the source of a symbol across one or more target files. For a
// single file, returns just the source. For many, each result is prefixed
// with the file path so the caller knows where each hit lives. Output is
// capped; a single oversized symbol gets degraded to outline+header rather
// than silently returning nothing (earlier version returned a useless
// "narrow the path" hint when a single symbol was too big to fit).
function readBySymbol(targets: string[], symbol: string, sessionId?: string): ToolResult {
  const sections: string[] = [];
  let hits = 0;
  let bodyLen = 0;
  for (const p of targets) {
    if (!astSupported(p)) continue;
    let found: ReturnType<typeof readSymbol>;
    try { found = readSymbol(p, symbol); } catch { continue; }
    if (!found) continue;
    hits++;
    const relPath = relative(CWD, p) || p;
    let section = targets.length === 1 ? found.source : `=== ${relPath} ===\n${found.source}`;
    // Oversized-symbol degrade: if this single section is bigger than the
    // whole budget, replace it with a header + child-symbol outline so the
    // agent can drill in further rather than getting nothing.
    if (bodyLen === 0 && section.length > MAX_READ_OUTPUT - 200) {
      const childHint = (() => {
        try {
          const all = fileSymbols(p);
          if (!all) return "";
          const parts = symbol.split(".");
          let cur = all;
          let parent: Symbol | null = null;
          for (const part of parts) {
            parent = cur.find(s => s.name === part) ?? null;
            if (!parent) break;
            cur = parent.children ?? [];
          }
          if (!parent || !parent.children || parent.children.length === 0) return "";
          const outline = parent.children
            .map(c => `  ${c.kind} ${c.name} L${c.startLine}-${c.endLine}`)
            .join("\n");
          return `\n\nChildren of '${symbol}':\n${outline}\n\nDrill in with: read('${relPath}', symbol: '${symbol}.CHILD_NAME')`;
        } catch { return ""; }
      })();
      section = `=== ${relPath} :: ${symbol} — lines ${found.startLine}-${found.endLine} (${found.source.length} chars, too large for one response) ===${childHint}`;
    }
    if (bodyLen + section.length + 2 > MAX_READ_OUTPUT - 200) {
      sections.push(`\n[+${targets.length - hits} more file(s) to search — narrow the path]`);
      break;
    }
    sections.push(section);
    bodyLen += section.length + 2;
    if (sessionId) {
      try {
        const stat = statSync(p);
        readCacheMark(sessionId, p, readCacheKey(p, { symbol }), stat.mtimeMs);
        touchSession(sessionId, p);
      } catch {}
    }
  }
  if (hits === 0) {
    return {
      output: `Symbol '${symbol}' not found in ${targets.length} file(s). Try read('<path>', query: '${symbol.split(".").pop() ?? symbol}') for a fuzzy match.`,
      title: `symbol: ${symbol}`,
    };
  }
  return {
    output: sections.join("\n\n"),
    title: hits === 1 ? `symbol: ${symbol}` : `symbol: ${symbol} (${hits} hits)`,
    metadata: { hits, targets: targets.length },
  };
}

// Fuzzy symbol name search across one or more files. Returns each matching
// symbol's source, grouped by file. Property matches are deprioritized
// (filtered out when non-property matches exist).
function readByQuery(targets: string[], query: string, sessionId?: string): ToolResult {
  const sections: string[] = [];
  let totalMatches = 0;
  let bodyLen = 0;
  for (const p of targets) {
    if (!astSupported(p)) continue;
    let all: Symbol[] = [];
    try { all = searchSymbols(p, query); } catch { continue; }
    const nonProp = all.filter(s => s.kind !== "property");
    const results = nonProp.length > 0 ? nonProp : all;
    if (results.length === 0) continue;
    const relPath = relative(CWD, p) || p;
    let src: string[] = [];
    try { src = readFileSync(p, "utf-8").split("\n"); } catch { continue; }
    const perFile: string[] = [];
    for (const s of results.slice(0, 5)) {
      const range = s.startLine === s.endLine ? `L${s.startLine}` : `L${s.startLine}-${s.endLine}`;
      const body = src.slice(s.startLine - 1, s.endLine)
        .map((l, i) => `${s.startLine + i}\t${l}`).join("\n");
      perFile.push(`--- ${s.kind} ${s.name} ${range} ---\n${body}`);
    }
    const suffix = results.length > 5 ? `\n[+${results.length - 5} more in this file]` : "";
    const section = `=== ${relPath} — ${results.length} matches ===\n${perFile.join("\n\n")}${suffix}`;
    if (bodyLen + section.length + 2 > MAX_READ_OUTPUT - 200) {
      sections.push(`\n[output truncated — ${totalMatches}+ matches so far; narrow the query or path]`);
      break;
    }
    sections.push(section);
    bodyLen += section.length + 2;
    totalMatches += results.length;
    if (sessionId) {
      try {
        const stat = statSync(p);
        readCacheMark(sessionId, p, readCacheKey(p, { query }), stat.mtimeMs);
      } catch {}
    }
  }
  if (totalMatches === 0) {
    return {
      output: `No symbols matching '${query}' in ${targets.length} file(s). Not every file is code — AST search only applies to ts/tsx/js/jsx/py/go/rs files.`,
      title: `query: ${query}`,
    };
  }
  return {
    output: sections.join("\n\n"),
    title: `query: ${query}`,
    metadata: { totalMatches, filesWithMatches: sections.length },
  };
}

// Content regex search across targets. Collects ALL matches first, then
// picks the tightest display format that still fits the output cap. The
// earlier version truncated matches blindly and Claude interpreted the
// truncation as "I need to narrow", causing pattern-level pagination (36
// sequential calls with different prefix patterns). Fix: a 3-tier format
// ladder — full line / trimmed snippet / minimal location — so a busy
// pattern still delivers every hit in a single call.
type PatternMatch = {
  file: string;
  line: number;
  symbol: string;
  kind: string;
  text: string;
};

function readByPattern(targets: string[], pattern: string, sessionId?: string): ToolResult {
  let regex: RegExp;
  try { regex = new RegExp(pattern); } catch (e) {
    return { output: `Invalid regex '${pattern}': ${(e as Error).message}`, title: `pattern: ${pattern}` };
  }

  // Pass 1: collect every match across every target. No truncation here.
  const matches: PatternMatch[] = [];
  for (const p of targets) {
    const relPath = relative(CWD, p) || p;
    if (astSupported(p)) {
      try {
        const hits = astGrep(p, pattern);
        for (const m of hits) {
          matches.push({ file: relPath, line: m.line, symbol: m.symbol, kind: m.kind, text: m.text.trim() });
        }
      } catch {}
    } else {
      try {
        const lines = readFileSync(p, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (regex.test(lines[i])) {
            matches.push({ file: relPath, line: i + 1, symbol: "(top-level)", kind: "text", text: lines[i].trim() });
          }
        }
      } catch {}
    }
    if (sessionId) {
      try {
        const stat = statSync(p);
        readCacheMark(sessionId, p, readCacheKey(p, { pattern }), stat.mtimeMs);
      } catch {}
    }
  }

  if (matches.length === 0) {
    return { output: `No matches for pattern '${pattern}' in ${targets.length} file(s).`, title: `pattern: ${pattern}` };
  }

  // Pass 2: pick the format tier that fits. Single-file results elide the
  // file prefix since it's redundant (Claude knows which file it asked for).
  const files = new Set(matches.map(m => m.file));
  const singleFile = files.size === 1;
  const firstFile = matches[0].file;

  const fmtFull = (m: PatternMatch): string => {
    const loc = singleFile ? `${m.line}` : `${m.file}:${m.line}`;
    return `${loc} [${m.symbol}] ${m.text}`;
  };
  const fmtCompact = (m: PatternMatch): string => {
    const loc = singleFile ? `${m.line}` : `${m.file}:${m.line}`;
    const snippet = m.text.length > 60 ? m.text.slice(0, 57) + "..." : m.text;
    return `${loc} [${m.symbol}] ${snippet}`;
  };
  const fmtMinimal = (m: PatternMatch): string => {
    const loc = singleFile ? `${m.line}` : `${m.file}:${m.line}`;
    return `${loc} ${m.symbol}`;
  };

  const header = singleFile
    ? `${firstFile} — ${matches.length} match(es) for /${pattern}/`
    : `${matches.length} match(es) across ${files.size} file(s) for /${pattern}/`;
  const headerLen = header.length + 1;

  // Try each tier until one fits. The budget reserves ~200 chars for the
  // header + truncation-notice just in case we fall through.
  const budget = MAX_READ_OUTPUT - 200;
  for (const fmt of [fmtFull, fmtCompact, fmtMinimal]) {
    const rendered = matches.map(fmt);
    let total = headerLen;
    let lastFit = -1;
    for (let i = 0; i < rendered.length; i++) {
      total += rendered[i].length + 1;
      if (total > budget) break;
      lastFit = i;
    }
    if (lastFit === rendered.length - 1) {
      // Everything fit in this tier.
      return {
        output: `${header}\n${rendered.join("\n")}`,
        title: `pattern: ${pattern}`,
        metadata: { matches: matches.length, files: files.size, tier: fmt === fmtFull ? "full" : fmt === fmtCompact ? "compact" : "minimal" },
      };
    }
  }

  // Even minimal format overflows — this means many THOUSANDS of matches.
  // Keep the head and advise a narrower pattern.
  const rendered = matches.map(fmtMinimal);
  const kept: string[] = [];
  let total = headerLen;
  for (const r of rendered) {
    if (total + r.length + 1 > budget - 120) break;
    kept.push(r);
    total += r.length + 1;
  }
  return {
    output: `${header}\n${kept.join("\n")}\n[truncated — ${matches.length - kept.length} more match(es) not shown. Narrow the pattern or the path.]`,
    title: `pattern: ${pattern}`,
    metadata: { matches: matches.length, files: files.size, truncated: true, shown: kept.length },
  };
}

// Entry point dispatched from the MCP runner. The accepted arg shape:
//   { file_path, symbol?, query?, pattern? }
// Legacy callers may still pass offset/limit — we accept them on the type
// to avoid a TS error but ignore them at runtime (the tool schema no longer
// advertises them, so the model has no reason to send them).
function execRead(
  args: { file_path: string; symbol?: string; query?: string; pattern?: string; offset?: number; limit?: number },
  sessionId?: string,
): ToolResult {
  const rawPath = args.file_path;
  if (!rawPath) return { output: "Error: file_path is required", title: "read" };

  const targets = resolveReadTargets(rawPath);
  if (targets.length === 0) {
    return {
      output: `No files resolved from '${rawPath}'. Check the path — it can be an absolute file, an absolute directory, or a glob pattern (e.g. '/src/**/*.ts').`,
      title: rawPath,
    };
  }

  // Per-target permission check — each resolved path goes through the
  // same policy a single-file read would.
  for (const t of targets) {
    try { checkPermission("read", t); } catch (e) {
      return { output: `Permission denied on ${t}: ${(e as Error).message}`, title: rawPath };
    }
  }

  if (args.symbol) return readBySymbol(targets, args.symbol, sessionId);
  if (args.query) return readByQuery(targets, args.query, sessionId);
  if (args.pattern) return readByPattern(targets, args.pattern, sessionId);

  // No modifier — single-target → study view; multi-target → inventory.
  if (targets.length === 1) {
    const p = targets[0];
    let stat: Stats;
    try { stat = statSync(p); } catch (e) {
      return { output: `Error stat'ing ${p}: ${(e as Error).message}`, title: p };
    }
    // Rich media takes precedence over code/text detection.
    const rich = studyRichMedia(p, stat);
    if (rich) return rich;
    if (astSupported(p)) return studyCodeFile(p, stat, sessionId);
    return studyTextFile(p, stat, sessionId);
  }
  return inventoryTargets(targets);
}

// Extensions considered "code" for the purposes of tool routing. Files
// with these extensions MUST go through do_code; files without them MUST
// go through do_noncode. The split is intentionally strict so the agent
// cannot reach for do_noncode to sidestep symbol-scoped edits.
const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".pyi",
  ".go",
  ".rs",
  ".java",
  ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".hxx",
  ".rb",
  ".php",
  ".cs",
  ".kt", ".kts",
  ".swift",
  ".scala",
  ".lua",
  ".sh", ".bash", ".zsh", ".fish",
  ".vue", ".svelte",
  ".sql",
]);

function isCodeFile(filePath: string): boolean {
  return CODE_EXTENSIONS.has(extname(filePath).toLowerCase());
}

// Session touch helper — invalidates the read cache for the path and
// refreshes the session-touched baseline so subsequent edits see the
// new content as their basis. Used by every successful code/non-code write.
function recordWrite(p: string, sessionId?: string, writtenContent?: string): void {
  readCacheInvalidate(sessionId, p);
  touchSession(sessionId, p, writtenContent);
}

// Staleness guard: if this session has previously touched the file,
// reject any edit whose content hash differs from the baseline. The hash
// catches sub-second rewrites that mtime (1s resolution) would miss. The
// mtime + size check is a fast pre-filter so we avoid re-reading the file
// when stat alone proves nothing changed (the common case).
function checkStaleness(p: string, sessionId?: string): ToolResult | null {
  if (!sessionId) return null;
  const baseline = touchedBaseline(sessionId, p);
  if (!baseline) return null;
  try {
    const stat = statSync(p);
    // Fast path: stat didn't change → file is definitely the same.
    if (stat.mtimeMs === baseline.mtime && stat.size === baseline.size) return null;
    // Stat changed — could be a formatter re-saving with same content, or
    // a real external mutation. Read + hash to tell them apart.
    const current = readFileSync(p, "utf-8");
    if (contentHash(current) === baseline.hash) return null;
    return {
      output: `Error: ${p} has been modified since your last read in this session (content hash mismatch). Re-read the file before editing — its current state is not what your inputs assume.`,
      title: relative(CWD, p) || p,
    };
  } catch {}
  return null;
}

// do_code — the ONLY way to write code in clwnd. AST-grounded where a
// grammar exists; every edit is re-parsed and the write is rejected if
// the result has syntax errors. Rejects any file whose extension is NOT
// in CODE_EXTENSIONS so the agent cannot accidentally reach for
// do_noncode to bypass symbol scoping.
function execDoCode(
  args: {
    file_path: string;
    operation?: "create" | "replace" | "insert_before" | "insert_after" | "delete";
    symbol?: string;
    new_source?: string;
  },
  sessionId?: string,
): ToolResult {
  const p = assertPath(args.file_path);
  checkPermission("do_code", p);
  if (!isCodeFile(p)) {
    return {
      output: `Error: do_code is only for code files (extensions: ${[...CODE_EXTENSIONS].join(", ")}). '${p}' is not a code file — use do_noncode instead.`,
      title: relative(CWD, p) || p,
    };
  }
  const op = args.operation ?? "replace";
  const relPath = relative(CWD, p) || p;

  // ── create: new file only, no symbol. Validates syntax post-write. ──
  if (op === "create") {
    if (existsSync(p)) {
      return {
        output: `Error: ${p} already exists. Use operation 'replace' (with or without symbol) to modify it, or 'insert_after'/'insert_before' to add next to an existing symbol.`,
        title: relPath,
      };
    }
    if (args.new_source == null) {
      return { output: `Error: operation 'create' requires new_source`, title: relPath };
    }
    const validation = validateSyntax(p, args.new_source);
    if (!validation.ok) {
      return { output: `Error: ${validation.error}. File NOT written.`, title: relPath };
    }
    const dir = dirname(p);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(p, args.new_source);
    recordWrite(p, sessionId, args.new_source);
    return {
      output: `Created ${p} (${args.new_source.split("\n").length} lines).`,
      title: relPath,
      metadata: { operation: "create", lines: args.new_source.split("\n").length },
    };
  }

  // Every other operation requires the file to already exist.
  if (!existsSync(p)) {
    return {
      output: `Error: ${p} does not exist. Use operation 'create' to write a new file.`,
      title: relPath,
    };
  }
  const stale = checkStaleness(p, sessionId);
  if (stale) return stale;

  const original = readFileSync(p, "utf-8");

  // ── replace without symbol: whole-file rewrite. Syntax-validated. ──
  if (op === "replace" && !args.symbol) {
    if (args.new_source == null) {
      return { output: `Error: operation 'replace' without symbol requires new_source (the full new file content).`, title: relPath };
    }
    const validation = validateSyntax(p, args.new_source);
    if (!validation.ok) {
      return { output: `Error: ${validation.error}. File NOT written.`, title: relPath };
    }
    writeFileSync(p, args.new_source);
    recordWrite(p, sessionId, args.new_source);
    return {
      output: `Rewrote ${p} (${args.new_source.split("\n").length} lines).`,
      title: relPath,
      metadata: { operation: "replace", whole_file: true },
    };
  }

  // All remaining operations target a specific symbol.
  if (!args.symbol) {
    return { output: `Error: operation '${op}' requires a symbol.`, title: relPath };
  }
  const range = symbolByteRange(p, args.symbol);
  if (!range) {
    return {
      output: `Error: symbol '${args.symbol}' not found in ${p}. Run read(${p}) to see the symbol outline first, then call do_code with an exact symbol name.`,
      title: relPath,
    };
  }

  // Byte-range splice. The symbol's [startIndex, endIndex] covers its
  // full extent INCLUDING leading comments / decorators / `export`
  // wrappers (the ast.ts query expansion did the heavy lifting). Single-
  // line constructs (`def f(): pass; def g(): pass`) work because we no
  // longer round to whole lines.
  const before = original.slice(0, range.startIndex);
  const after = original.slice(range.endIndex);
  let newContent: string;

  if (op === "replace") {
    if (args.new_source == null) {
      return { output: `Error: operation 'replace' with symbol requires new_source (the new source for that symbol).`, title: relPath };
    }
    newContent = before + args.new_source + after;
  } else if (op === "insert_before") {
    if (args.new_source == null) {
      return { output: `Error: operation 'insert_before' requires new_source.`, title: relPath };
    }
    // Insert at the symbol's start. Include a separator newline so the
    // new code doesn't fuse with the symbol's leading text.
    newContent = before + args.new_source + "\n\n" + original.slice(range.startIndex);
  } else if (op === "insert_after") {
    if (args.new_source == null) {
      return { output: `Error: operation 'insert_after' requires new_source.`, title: relPath };
    }
    // Insert immediately after the symbol's end. Same separator concern.
    newContent = original.slice(0, range.endIndex) + "\n\n" + args.new_source + after;
  } else if (op === "delete") {
    // Trim a single trailing newline so deleting a symbol doesn't leave
    // a gratuitous blank line. We don't try to be cleverer than that —
    // formatters can sort the rest out.
    let cleanAfter = after;
    if (before.endsWith("\n") && cleanAfter.startsWith("\n")) cleanAfter = cleanAfter.slice(1);
    newContent = before + cleanAfter;
  } else {
    return { output: `Error: unknown operation '${op}'. Valid: create, replace, insert_before, insert_after, delete.`, title: relPath };
  }

  const validation = validateSyntax(p, newContent);
  if (!validation.ok) {
    return {
      output: `Error: ${validation.error}. The edit would leave '${p}' with invalid syntax; write rejected. Re-check your new_source.`,
      title: relPath,
    };
  }
  writeFileSync(p, newContent);
  recordWrite(p, sessionId, newContent);

  return {
    output: `${op === "delete" ? "Deleted" : op === "replace" ? "Replaced" : "Inserted"} symbol '${args.symbol}' in ${p} (was lines ${range.startLine}-${range.endLine}).`,
    title: relPath,
    metadata: { operation: op, symbol: args.symbol, was: range, length: newContent.length },
  };
}

// do_noncode — the ONLY way to write non-code files. Rejects any file
// whose extension is in CODE_EXTENSIONS so it cannot be used as an
// end-run around do_code's AST validation.
function execDoNoncode(
  args: { file_path: string; word?: string; phrase?: string; sentence?: string; paragraph?: string; replace?: string },
  sessionId?: string,
): ToolResult {
  const p = assertPath(args.file_path);
  checkPermission("do_noncode", p);
  if (isCodeFile(p)) {
    return {
      output: `Error: do_noncode refuses code files. '${p}' has a code extension — use do_code instead.`,
      title: relative(CWD, p) || p,
    };
  }
  const relPath = relative(CWD, p) || p;
  const dir = dirname(p);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const existed = existsSync(p);
  let replaceText = args.replace ?? "";

  // ── scope: word / phrase / sentence / paragraph ───────────────────
  const scopeParam = args.word ? "word" : args.phrase ? "phrase" : args.sentence ? "sentence" : args.paragraph ? "paragraph" : null;
  const scopeValue = args.word ?? args.phrase ?? args.sentence ?? args.paragraph;

  if (scopeParam && scopeValue) {
    if (!existed) {
      return { output: `Error: ${scopeParam} '${scopeValue}' requires the file to exist.`, title: relPath };
    }
    const stale = checkStaleness(p, sessionId);
    if (stale) return stale;
    const original = readFileSync(p, "utf-8");

    let result;
    switch (scopeParam) {
      case "word":      result = resolveWord(original, scopeValue); break;
      case "phrase":    result = resolvePhrase(original, scopeValue, p); break;
      case "sentence":  result = resolveSentence(original, scopeValue, p); break;
      case "paragraph": result = resolveParagraph(original, scopeValue, p); break;
    }

    if (!result.match) {
      const hint = result.error
        ? result.error
        : `${scopeParam} '${scopeValue}' not found in ${p}. Read the file first to see its content.`;
      return { output: `Error: ${hint}`, title: relPath };
    }
    const match = result.match;
    // Auto-quote: if replacing a JSON value and the replacement isn't
    // already a valid JSON value, wrap it in quotes. The agent shouldn't
    // have to think about JSON escaping.
    const ext = extname(p).toLowerCase();
    if ((ext === ".json" || ext === ".jsonc") && scopeParam === "phrase" && replaceText.length > 0) {
      const trimmed = replaceText.trim();
      const isJsonValue = /^[{\["0-9\-]/.test(trimmed) || trimmed === "true" || trimmed === "false" || trimmed === "null";
      if (!isJsonValue) {
        replaceText = `"${replaceText.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;
      }
    }
    const before = original.slice(match.startIndex, match.endIndex);
    const next = original.slice(0, match.startIndex) + replaceText + original.slice(match.endIndex);
    writeFileSync(p, next);
    recordWrite(p, sessionId, next);

    // Context window around the edit site — enough to confirm it landed
    const CTX = 3; // lines of context before/after
    const editStart = match.startIndex;
    const editEnd = match.startIndex + replaceText.length;
    let ctxStart = editStart;
    for (let i = 0; i < CTX && ctxStart > 0; i++) {
      ctxStart = next.lastIndexOf("\n", ctxStart - 1);
      if (ctxStart === -1) { ctxStart = 0; break; }
    }
    if (ctxStart > 0) ctxStart++; // past the newline
    let ctxEnd = editEnd;
    for (let i = 0; i < CTX && ctxEnd < next.length; i++) {
      const nl = next.indexOf("\n", ctxEnd);
      if (nl === -1) { ctxEnd = next.length; break; }
      ctxEnd = nl + 1;
    }
    const context = next.slice(ctxStart, ctxEnd);

    const disambigNote = result.totalMatches > 1
      ? `\n(${result.totalMatches} matches — use ${scopeValue}#N to target a specific one)`
      : "";
    const lines: string[] = [
      `Replaced ${match.scope} '${match.anchor}' in ${p}.`,
    ];
    if (before.trim().length > 0 && before.length <= 200) {
      lines.push(`  − ${before.split("\n").join("\n  − ")}`);
    }
    if (replaceText.trim().length > 0 && replaceText.length <= 200) {
      lines.push(`  + ${replaceText.split("\n").join("\n  + ")}`);
    }
    lines.push("", context, disambigNote);
    return {
      output: lines.join("\n").trimEnd(),
      title: relPath,
      metadata: { scope: match.scope, totalMatches: result.totalMatches, size: next.length },
    };
  }

  // No scope parameter = create/overwrite whole file
  writeFileSync(p, replaceText);
  recordWrite(p, sessionId, replaceText);
  return {
    output: `${existed ? "Overwrote" : "Created"} ${p} (${replaceText.length} bytes).`,
    title: relPath,
    metadata: { existed, size: replaceText.length },
  };
}

// Cap bash output at 30KB — native Claude Code's BASH_MAX_OUTPUT_LENGTH has a
// 30_000-char floor (default 150_000). Sitting at the floor matches what
// Claude trained on (30K is the conservative-bound the model expects to get
// when a command is noisy) while still saving 5× vs the native default — a
// decent middle-ground between penny-pinching and information preservation.
const BASH_MAX_OUTPUT = 30 * 1024;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function capBashStream(s: string): { kept: string; trimmed: number } {
  if (s.length <= BASH_MAX_OUTPUT) return { kept: s, trimmed: 0 };
  return { kept: s.slice(0, BASH_MAX_OUTPUT) + `\n[... truncated at ${Math.round(BASH_MAX_OUTPUT / 1024)}KB]`, trimmed: s.length - BASH_MAX_OUTPUT };
}

// Ring buffer for streamed bash output. Keeps the most recent RING_CAP bytes
// per stream — for a long-running build or test suite that emits 50MB, we
// keep the last 1MB window and cap() pulls the user-visible slice from it.
// Matches native Claude Code's 8MB ring-buffered output shape (just smaller).
const BASH_RING_CAP = 1024 * 1024; // 1MB per stream

function appendRing(prev: string, chunk: string): string {
  const next = prev + chunk;
  if (next.length <= BASH_RING_CAP) return next;
  return "[... earlier output evicted ...]\n" + next.slice(next.length - BASH_RING_CAP);
}

// File-inspection commands banned from bash. The agent gets these capabilities
// from `read` (study view, symbol, query, pattern, glob) and MUST NOT wrap
// them via bash. The filter parses every shell segment separated by
// pipes / boolean chains / semicolons and rejects the whole call if ANY of
// them starts with a banned command. Redirects to `read` with a concrete
// alternative so the agent can recover without guessing.
const BASH_BANNED_COMMANDS = new Set([
  "ls", "find", "grep", "rg", "ripgrep", "cat", "head", "tail", "sed", "awk",
  "cut", "uniq", "wc", "more", "less", "tree", "du", "file", "od", "xxd",
  "strings", "zcat", "bzcat", "xzcat", "zgrep", "xargs",
]);

// Normalize a single segment of a compound command to its first executable
// token. Handles env-var-prefixed commands (`FOO=bar cat x`), leading flags
// and spaces, and path-qualified commands (`/usr/bin/cat`).
function firstCommandToken(segment: string): string | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  // Strip leading environment assignments like FOO=bar baz.
  const tokens = trimmed.split(/\s+/);
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;
  if (i >= tokens.length) return null;
  const tok = tokens[i];
  // Strip backticks and leading `!` negation.
  const clean = tok.replace(/^[!`'"]+/, "").replace(/[`'"]+$/, "");
  // Return the basename so `/usr/bin/cat` matches `cat`.
  return clean.split("/").pop() ?? clean;
}

// Return a rejection ToolResult if the command contains a banned segment,
// else null. The filter is deliberately a conservative parser — if the
// shell syntax is too gnarly to split cleanly, we assume clean (no false
// rejections) and rely on the description to guide the agent.
function checkBashBan(command: string): ToolResult | null {
  // Split on common shell operators: pipes, boolean chains, statement sep.
  // Does not understand nested quoting perfectly — good enough for the
  // obvious-bypass cases we're trying to block.
  const segments = command.split(/\||\&\&|\|\||;|\n/);
  for (const seg of segments) {
    const tok = firstCommandToken(seg);
    if (tok && BASH_BANNED_COMMANDS.has(tok)) {
      return {
        output:
          `[clwnd: bash command '${tok}' is banned — file inspection must go through \`read\`.\n` +
          `  ls / tree / du / file          → read(<directory>)\n` +
          `  find                           → read('<dir>') for a tree, or read('<dir>/**/*.ext') as a glob\n` +
          `  cat / head / tail / more / less → read(<file>)\n` +
          `  grep / rg / sed -n / awk       → read(<file_or_dir>, pattern: 'regex')\n` +
          `Rewrite the call to use read(...) and try again. If you genuinely need a shell-only capability that bash actually provides (runtime, package managers, git, etc.), call that directly.]`,
        title: `banned: ${tok}`,
        metadata: { banned: tok, command },
      };
    }
  }
  return null;
}

// File-write commands banned from bash. The agent writes files through
// do_code (code) and do_noncode (non-code), not through bash. This
// catches shell redirects, tee, cp-to-create, and scripting-language
// one-liners that write files. Legitimate write operations (git, npm,
// builds) don't match these patterns — they write to .git/, node_modules/,
// dist/ as side effects of their primary operation, not via explicit
// file-creation syntax.
const BASH_WRITE_PATTERNS = [
  /[^|&;]\s*>\s*[^&|]/, // shell redirect: > file (but not >&2, ||, &&)
  /[^|&;]\s*>>\s*/,     // append redirect: >> file
  /\btee\s/,            // tee command
  /\bdd\s/,             // dd command
  /\binstall\s+-/,      // install -m (GNU coreutils install)
  /\bmkdir\s/,          // mkdir (creating directories — use do_noncode)
  /\btouch\s/,          // touch (creating empty files)
  /\bcp\s/,             // cp (copying files)
  /\bmv\s/,             // mv (moving/renaming files)
  /\bchmod\s/,          // chmod
  /\bchown\s/,          // chown
  /\bln\s/,             // ln (symlinks)
  /\brm\s/,             // rm (deleting files)
  /\brmdir\s/,          // rmdir
  /\bpython[23]?\s+-c\b.*(?:open|write|Path)/i,   // python -c with file write
  /\bnode\s+-e\b.*(?:writeFile|fs\.)/i,            // node -e with fs write
  /\bruby\s+-e\b.*(?:File\.|IO\.)/i,              // ruby -e with file write
  /\bperl\s+-[ep]\b.*(?:open|print)/i,            // perl one-liner with write
];

// Commands that ARE allowed to write (they modify the project as a side
// effect of their primary operation — builds, version control, packages).
const BASH_WRITE_ALLOWED = [
  /^\s*git\s/,
  /^\s*npm\s/, /^\s*yarn\s/, /^\s*pnpm\s/, /^\s*bun\s/,
  /^\s*pip\s/, /^\s*uv\s/, /^\s*cargo\s/, /^\s*go\s/,
  /^\s*make\s/, /^\s*cmake\s/,
  /^\s*docker\s/, /^\s*docker-compose\s/,
  /^\s*tsc\b/, /^\s*tsup\b/, /^\s*esbuild\b/, /^\s*vite\b/, /^\s*webpack\b/,
  /^\s*pytest\b/, /^\s*jest\b/, /^\s*vitest\b/,
  /^\s*rustc\b/, /^\s*gcc\b/, /^\s*g\+\+\b/, /^\s*clang\b/,
];

function checkBashWrite(command: string): ToolResult | null {
  // Allow-listed commands can write (builds, git, packages)
  if (BASH_WRITE_ALLOWED.some(p => p.test(command))) return null;

  for (const pattern of BASH_WRITE_PATTERNS) {
    if (pattern.test(command)) {
      return {
        output:
          `[clwnd: file writes go through do_code (code files) or do_noncode (non-code files), not bash.\n` +
          `Bash is for: git, builds (npm/make/tsc), tests (pytest/jest), package managers, and runtime commands.\n` +
          `Rewrite using do_code or do_noncode.]`,
        title: "bash write blocked",
        metadata: { command: command.slice(0, 100) },
      };
    }
  }
  return null;
}

async function execBash(args: { command: string; description?: string; timeout?: number }): Promise<ToolResult> {
  // Banned-command check runs BEFORE permission so the agent learns the
  // redirect even in environments where bash permission would have been
  // denied anyway.
  const banned = checkBashBan(args.command);
  if (banned) {
    trace("bash.banned", { cmd: (banned.metadata as any)?.banned });
    return banned;
  }
  const writeBlock = checkBashWrite(args.command);
  if (writeBlock) {
    trace("bash.write.blocked", { cmd: args.command.slice(0, 100) });
    return writeBlock;
  }
  checkPermission("bash", args.command);
  const timeout = args.timeout ?? 120_000;
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  let exitCode: number | null = 0;

  try {
    // Bun spawn for streamed stdout/stderr. Two ReadableStream drains pump
    // into per-stream ring buffers concurrently, so a command that emits
    // 100MB over 5 minutes keeps only the last 1MB per stream in memory —
    // no 10MB maxBuffer cliff, no middle-of-output loss, no OOM.
    const proc = spawnProc({
      cmd: ["/bin/bash", "-lc", args.command],
      cwd: CWD,
      env: { ...process.env, TERM: "dumb" },
      stdout: "pipe",
      stderr: "pipe",
    });

    const drain = async (stream: ReadableStream<Uint8Array> | undefined, onChunk: (s: string) => void) => {
      if (!stream) return;
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) onChunk(decoder.decode(value, { stream: true }));
      }
    };

    const timer = setTimeout(() => {
      interrupted = true;
      try { proc.kill("SIGTERM"); } catch {}
      // Backstop hard-kill if SIGTERM isn't honored within 2s
      setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
    }, timeout);

    try {
      await Promise.all([
        drain(proc.stdout as ReadableStream<Uint8Array>, c => { stdout = appendRing(stdout, c); }),
        drain(proc.stderr as ReadableStream<Uint8Array>, c => { stderr = appendRing(stderr, c); }),
        proc.exited,
      ]);
    } finally {
      clearTimeout(timer);
    }

    exitCode = proc.exitCode ?? (interrupted ? 124 : 1);
  } catch (e: any) {
    stderr = (stderr || "") + stripAnsi(String(e.message ?? ""));
    exitCode = 1;
  }

  stdout = stripAnsi(stdout);
  stderr = stripAnsi(stderr);

  const outCap = capBashStream(stdout);
  const errCap = capBashStream(stderr);
  if (outCap.trimmed > 0 || errCap.trimmed > 0) {
    penny.bashTruncated++;
    penny.bashBytesTrimmed += outCap.trimmed + errCap.trimmed;
  }

  // Assemble visible body. When stderr is present, emit a labelled section so
  // Claude can tell streams apart without guessing. When interrupted by
  // timeout, prepend a marker so Claude knows the command didn't finish.
  let body: string;
  if (errCap.kept) {
    body = (outCap.kept ? outCap.kept + "\n" : "") + "<stderr>\n" + errCap.kept + "\n</stderr>";
  } else {
    body = outCap.kept;
  }
  if (interrupted) {
    body = `[clwnd: command interrupted after ${timeout}ms timeout — partial output follows]\n` + body;
  }

  return {
    output: body || `(exit ${exitCode ?? 0})`,
    title: args.description ?? args.command.slice(0, 80),
    metadata: {
      exit: exitCode,
      description: args.description ?? args.command.slice(0, 80),
      interrupted,
      stdout: outCap.kept,
      stderr: errCap.kept,
      stdoutTrimmed: outCap.trimmed,
      stderrTrimmed: errCap.trimmed,
    },
  };
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

// ─── Session-scoped visible tools ─────────────────────────────────────────
//
// Clwnd's native tools (read, do_code, do_noncode, bash, permission_prompt)
// are ALWAYS advertised to Claude — they're clwnd's authoritative surface
// and do not get filtered by what OC happens to know about. OC's tool
// vocabulary (edit, write, glob, grep, etc.) is the legacy set clwnd has
// replaced; the mapping layer that used to translate them is gone.
//
// This map tracks EXTERNAL MCP tool names only — the context7s and the
// like. tools/list passes clwnd's natives through unconditionally and
// filters externals by this set (set by the plugin from opts.tools).
const sessionVisibleExternals = new Map<string, Set<string>>();

/** Record the external MCP tool names for a session. Called by the daemon
 *  when the plugin hums a prompt — the list is the subset of opts.tools
 *  that don't match any of clwnd's native tool names. */
export function setVisibleTools(sessionId: string, externalToolNames: string[]): void {
  sessionVisibleExternals.set(sessionId, new Set(externalToolNames));
}

export function clearVisibleTools(sessionId: string): void {
  sessionVisibleExternals.delete(sessionId);
}

function getVisibleExternalSet(sessionId: string | undefined): Set<string> | null {
  if (!sessionId) return null;
  return sessionVisibleExternals.get(sessionId) ?? null;
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
  // We always spawn with stdin: "pipe" so the sink is a FileSink. Bun's
  // generic type widens to `number | FileSink | undefined` when the generics
  // aren't inferred at the call site; narrow defensively so any future spawn
  // config change that drops the pipe fails loudly instead of silently.
  const sink = client.proc.stdin;
  if (!sink || typeof sink === "number") {
    throw new Error(`mcp client stdin is not a writable sink (server=${client.config.name})`);
  }
  sink.write(msg);
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


// Proxy tool execution — holds the MCP call, hums to the plugin, waits
// for the result. The plugin registers a matching tool via OC's tool:
// hook. OC executes it (with full promptOps for task, etc.) and the
// plugin hums the result back. Same pattern as permission_prompt.
type TendrilHold = { resolve: (result: string) => void; tool: string };
const TENDRIL_HOLDS = new Map<string, TendrilHold>();
let tendrilCallback: ((tool: string, args: Record<string, unknown>, callId: string, sessionId?: string) => void) | null = null;

export function setTendrilCallback(cb: typeof tendrilCallback): void { tendrilCallback = cb; }

export function resolveTendril(callId: string, result: string): boolean {
  const hold = TENDRIL_HOLDS.get(callId);
  if (!hold) return false;
  TENDRIL_HOLDS.delete(callId);
  hold.resolve(result);
  return true;
}

async function execTendril(name: string, args: Record<string, unknown>, sessionId?: string): Promise<ToolResult> {
  const callId = `proxy-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  trace("tendril.reach.hold", { tool: name, callId, sid: sessionId });

  if (tendrilCallback) tendrilCallback(name, args, callId, sessionId);

  const result = await new Promise<string>((resolve) => {
    TENDRIL_HOLDS.set(callId, { resolve, tool: name });
    setTimeout(() => {
      if (TENDRIL_HOLDS.has(callId)) {
        TENDRIL_HOLDS.delete(callId);
        trace("tendril.reach.timeout", { tool: name, callId });
        resolve(`Error: ${name} timed out after 5 minutes`);
      }
    }, 5 * 60_000);
  });

  return { output: result, title: name, metadata: { proxy: true, callId } };
}

export async function executeTool(name: string, args: Record<string, unknown>, _callId?: string, sessionId?: string): Promise<ToolResult> {
  if (name !== "permission_prompt") trace("mcp.tool.executed", { tool: name });
  switch (name) {
    case "read": return execRead(args as any, sessionId);
    case "do_code": return execDoCode(args as any, sessionId);
    case "do_noncode": return execDoNoncode(args as any, sessionId);
    case "bash": return execBash(args as any);
    case "permission_prompt": return execPermissionPrompt(args as any, sessionId);
    case "task": return execTendril("task", args, sessionId);
    // Replaced-and-banned tools. Return a redirect instead of "Unknown tool"
    // so an agent that somehow still sees one of these learns the right
    // substitute without wasting another round-trip.
    case "edit":
    case "write":
      return {
        output: `[clwnd: tool '${name}' no longer exists. Use do_code for code files (AST-grounded symbol replacement, insertion, deletion) or do_noncode for config/docs/text (linguistic scope editing).]`,
        title: `replaced: ${name}`,
        metadata: { replaced: name },
      };
    case "glob":
    case "grep":
      return {
        output: `[clwnd: tool '${name}' no longer exists. Use read — it absorbs glob and grep via its file_path/pattern modifiers. read('/path/**/*.ts') for glob; read('/path', pattern: 'regex') for AST-aware grep with enclosing-symbol context.]`,
        title: `replaced: ${name}`,
        metadata: { replaced: name },
      };
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
      // Clwnd's native TOOLS are always advertised — they're the
      // authoritative filesystem surface. The permission layer
      // (allowedToolSet / checkPermission) handles per-session gating.
      // External MCP tools (context7 etc.) get filtered by whatever OC
      // advertised via setVisibleTools.
      //
      // permission_prompt is ALWAYS advertised regardless of allowedTools
      // — Claude CLI is spawned with --permission-prompt-tool pointing at
      // mcp__clwnd__permission_prompt, and the process exits immediately
      // if the tool isn't in the MCP tools/list response.
      const nativeAllowed = allowedToolSet
        ? TOOLS.filter(t => t.name === "permission_prompt" || allowedToolSet!.has(t.name))
        : TOOLS;
      const ext = sessionId ? (externalTools.get(sessionId) ?? []) : [];
      const visibleExt = getVisibleExternalSet(sessionId);
      const externalAllowed = visibleExt ? ext.filter(t => visibleExt.has(t.name)) : ext;
      return { jsonrpc: "2.0", id: body.id, result: { tools: [...nativeAllowed, ...externalAllowed] } };
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
