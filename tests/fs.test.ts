/**
 * Filesystem MCP integration tests.
 *
 * Hits the daemon's MCP HTTP endpoint directly — same JSON-RPC transport
 * Claude CLI uses. No unit tests, no function imports. Tests the tools
 * as an external consumer would see them.
 *
 * Requires: daemon running on port 29147 (./dev deploys + restarts it).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const SUITE_DIR = "/tmp/clwnd-fs-mcp-test";
const MCP_PORT = parseInt(process.env.CLWND_MCP_PORT ?? "29147");
const MCP = `http://127.0.0.1:${MCP_PORT}/s/fs-mcp-${process.pid}`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function post(tool: string, args: Record<string, unknown>): Promise<string> {
  const r = await fetch(MCP, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  const data = await r.json() as any;
  const content = data.result?.content ?? [];
  return content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "").join("\n");
}

function seed(name: string, content: string): string {
  const p = join(SUITE_DIR, name);
  const dir = join(SUITE_DIR, ...name.split("/").slice(0, -1));
  mkdirSync(dir, { recursive: true });
  writeFileSync(p, content);
  return p;
}

function disk(path: string): string {
  return readFileSync(path, "utf-8");
}

// ─── Setup / Teardown ───────────────────────────────────────────────────────

beforeAll(() => {
  rmSync(SUITE_DIR, { recursive: true, force: true });
  mkdirSync(SUITE_DIR, { recursive: true });
});

afterAll(() => {
  rmSync(SUITE_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════════════════════════
//  read
// ═══════════════════════════════════════════════════════════════════════════

describe("read", () => {
  test("file with symbol outline", async () => {
    const p = seed("read-outline.ts", `export function foo() { return 1; }\nexport class Bar { baz() {} }\n`);
    const out = await post("read", { file_path: p });
    expect(out).toContain("foo");
    expect(out).toContain("Bar");
    expect(out).toContain("baz");
  });

  test("by symbol extracts source", async () => {
    const p = seed("read-sym.ts", `function foo() { return 1; }\nfunction bar() { return 2; }\n`);
    const out = await post("read", { file_path: p, symbol: "bar" });
    expect(out).toContain("return 2");
    expect(out).not.toContain("return 1");
  });

  test("by query searches symbol names", async () => {
    const p = seed("read-query.ts", `function handleRequest() {}\nfunction handleResponse() {}\nfunction other() {}\n`);
    const out = await post("read", { file_path: p, query: "handle" });
    expect(out).toContain("handleRequest");
    expect(out).toContain("handleResponse");
    expect(out).not.toContain("other");
  });

  test("by pattern searches content", async () => {
    const p = seed("read-pat.ts", `function foo() {\n  console.log("hello");\n}\nfunction bar() {\n  console.log("world");\n}\n`);
    const out = await post("read", { file_path: p, pattern: "console\\.log" });
    expect(out).toContain("hello");
    expect(out).toContain("world");
  });

  test("directory listing", async () => {
    seed("subdir/a.ts", "const a = 1;");
    seed("subdir/b.py", "b = 2");
    const out = await post("read", { file_path: join(SUITE_DIR, "subdir") });
    expect(out).toContain("a.ts");
    expect(out).toContain("b.py");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  read: non-code anchor outlines
// ═══════════════════════════════════════════════════════════════════════════

describe("read: non-code anchors", () => {
  test("markdown shows heading anchors", async () => {
    const p = seed("read-md.md", "# Title\n\nIntro.\n\n## Setup\n\nSteps here.\n\n## Usage\n\nUse it.\n\n### Advanced\n\nMore.\n");
    const out = await post("read", { file_path: p });
    expect(out).toContain("# Title");
    expect(out).toContain("## Setup");
    expect(out).toContain("## Usage");
    expect(out).toContain("### Advanced");
    expect(out).toContain("anchors");
  });

  test("env shows variable anchors", async () => {
    const p = seed("read-env.env", "HOST=localhost\nPORT=3000\nDATABASE_URL=postgres://db\n");
    const out = await post("read", { file_path: p });
    expect(out).toContain("HOST");
    expect(out).toContain("PORT");
    expect(out).toContain("DATABASE_URL");
  });

  test("json shows key anchors", async () => {
    const p = seed("read-json.json", '{\n  "name": "app",\n  "version": "1.0.0",\n  "dependencies": {\n    "lodash": "^4.0.0"\n  }\n}\n');
    const out = await post("read", { file_path: p });
    expect(out).toContain("name");
    expect(out).toContain("version");
    expect(out).toContain("dependencies");
    expect(out).toContain("dependencies.lodash");
  });

  test("yaml shows key anchors", async () => {
    const p = seed("read-yaml.yaml", "server:\n  port: 3000\n  host: localhost\nredis:\n  url: redis://r\n");
    const out = await post("read", { file_path: p });
    expect(out).toContain("server");
    expect(out).toContain("redis");
  });

  test("toml shows section anchors", async () => {
    const p = seed("read-toml.toml", "[server]\nport = 3000\n\n[database]\nurl = \"pg://db\"\n");
    const out = await post("read", { file_path: p });
    expect(out).toContain("[server]");
    expect(out).toContain("[database]");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_code — create
// ═══════════════════════════════════════════════════════════════════════════

describe("do_code: create", () => {
  test("writes a new file", async () => {
    const p = join(SUITE_DIR, "create.ts");
    const out = await post("do_code", { file_path: p, operation: "create", new_source: `export function hello(): string {\n  return "hi";\n}\n` });
    expect(out).toContain("Created");
    expect(disk(p)).toContain("function hello");
  });

  test("rejects if file exists", async () => {
    const p = seed("exists.ts", "const x = 1;");
    const out = await post("do_code", { file_path: p, operation: "create", new_source: "// overwrite" });
    expect(out).toContain("already exists");
  });

  test("rejects invalid syntax", async () => {
    const p = join(SUITE_DIR, "bad-create.ts");
    const out = await post("do_code", { file_path: p, operation: "create", new_source: "function x( { return ;;" });
    expect(out).toMatch(/parse error|NOT written/);
    expect(existsSync(p)).toBe(false);
  });

  test("rejects non-code extension", async () => {
    const out = await post("do_code", { file_path: join(SUITE_DIR, "readme.md"), operation: "create", new_source: "# hi" });
    expect(out).toMatch(/not a code file|do_noncode/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_code — replace
// ═══════════════════════════════════════════════════════════════════════════

describe("do_code: replace", () => {
  test("by symbol replaces only the target", async () => {
    const p = seed("replace-sym.ts", `export function hello(): string {\n  return "hi";\n}\n\nexport function bye(): string {\n  return "later";\n}\n`);
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "replace", symbol: "hello", new_source: `export function hello(): string {\n  return "howdy";\n}` });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("howdy");
    expect(after).not.toContain('"hi"');
    expect(after).toContain("function bye");
  });

  test("whole-file rewrite", async () => {
    const p = seed("replace-whole.ts", "const x = 1;\nconst y = 2;\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "replace", new_source: "export const Z = 42;\n" });
    expect(out).toContain("Rewrote");
    expect(disk(p)).toContain("const Z = 42");
    expect(disk(p)).not.toContain("const x");
  });

  test("rejects bad new_source", async () => {
    const p = seed("replace-bad.ts", "function foo() { return 1; }\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "replace", symbol: "foo", new_source: "function foo( { ;;;" });
    expect(out).toMatch(/parse error|syntax/i);
    expect(disk(p)).toContain("return 1");
  });

  test("rejects unknown symbol", async () => {
    const p = seed("replace-nosym.ts", "function foo() {}\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "replace", symbol: "nonexistent", new_source: "const x = 1;" });
    expect(out).toContain("not found");
  });

  test("rejects on missing file", async () => {
    const out = await post("do_code", { file_path: join(SUITE_DIR, "ghost.ts"), operation: "replace", new_source: "const x = 1;" });
    expect(out).toMatch(/does not exist|create/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_code — insert
// ═══════════════════════════════════════════════════════════════════════════

describe("do_code: insert", () => {
  test("insert_after adds code after symbol", async () => {
    const p = seed("insert-after.ts", "function foo() { return 1; }\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "insert_after", symbol: "foo", new_source: "function bar() { return 2; }" });
    expect(out).toContain("Inserted");
    const after = disk(p);
    expect(after).toContain("function foo");
    expect(after).toContain("function bar");
  });

  test("insert_before adds code before symbol", async () => {
    const p = seed("insert-before.ts", "function foo() { return 1; }\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "insert_before", symbol: "foo", new_source: `const PREFIX = "x";` });
    expect(out).toContain("Inserted");
    const after = disk(p);
    expect(after).toContain("PREFIX");
    expect(after).toContain("function foo");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_code — delete
// ═══════════════════════════════════════════════════════════════════════════

describe("do_code: delete", () => {
  test("removes a symbol, preserves others", async () => {
    const p = seed("delete.ts", "function foo() { return 1; }\n\nfunction bar() { return 2; }\n\nfunction baz() { return 3; }\n");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "delete", symbol: "bar" });
    expect(out).toContain("Deleted");
    const after = disk(p);
    expect(after).toContain("function foo");
    expect(after).toContain("function baz");
    expect(after).not.toContain("function bar");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_code — multi-language
// ═══════════════════════════════════════════════════════════════════════════

describe("do_code: languages", () => {
  test("python create + symbol replace", async () => {
    const p = join(SUITE_DIR, "lang.py");
    await post("do_code", { file_path: p, operation: "create", new_source: "def foo():\n    return 1\n\ndef bar():\n    return 2\n" });
    expect(disk(p)).toContain("def foo");
    await post("read", { file_path: p });
    const out = await post("do_code", { file_path: p, operation: "replace", symbol: "foo", new_source: "def foo():\n    return 999" });
    expect(out).toContain("Replaced");
    expect(disk(p)).toContain("return 999");
    expect(disk(p)).toContain("def bar");
  });

  test("java create + read symbols", async () => {
    const p = join(SUITE_DIR, "Test.java");
    await post("do_code", { file_path: p, operation: "create", new_source: "public class Test {\n    void run() {}\n    void stop() {}\n}\n" });
    const out = await post("read", { file_path: p });
    expect(out).toContain("Test");
    expect(out).toContain("run");
    expect(out).toContain("stop");
  });

  test("ruby create + delete symbol", async () => {
    const p = join(SUITE_DIR, "test.rb");
    await post("do_code", { file_path: p, operation: "create", new_source: "def foo\n  1\nend\n\ndef bar\n  2\nend\n" });
    await post("read", { file_path: p });
    await post("do_code", { file_path: p, operation: "delete", symbol: "foo" });
    const after = disk(p);
    expect(after).not.toContain("def foo");
    expect(after).toContain("def bar");
  });

  test("c create + read symbols", async () => {
    const p = join(SUITE_DIR, "test.c");
    await post("do_code", { file_path: p, operation: "create", new_source: "int foo(int x) { return x; }\nstruct Bar { int a; };\n" });
    const out = await post("read", { file_path: p });
    expect(out).toContain("foo");
    expect(out).toContain("Bar");
  });

  test("bash create + read symbols", async () => {
    const p = join(SUITE_DIR, "test.sh");
    await post("do_code", { file_path: p, operation: "create", new_source: "#!/bin/bash\nfoo() {\n  echo hi\n}\nfunction bar {\n  echo bye\n}\n" });
    const out = await post("read", { file_path: p });
    expect(out).toContain("foo");
    expect(out).toContain("bar");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_noncode
// ═══════════════════════════════════════════════════════════════════════════

describe("do_noncode", () => {
  test("write creates new file", async () => {
    const p = join(SUITE_DIR, "new.md");
    const out = await post("do_noncode", { file_path: p, content: "# Test\n\nHello." });
    expect(out).toContain("Created");
    expect(disk(p)).toContain("# Test");
  });

  test("append adds to end", async () => {
    const p = seed("append.md", "# Start\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, content: "\nAppended.", mode: "append" });
    expect(out).toContain("Appended");
    expect(disk(p)).toContain("# Start");
    expect(disk(p)).toContain("Appended");
  });

  test("prepend adds to beginning", async () => {
    const p = seed("prepend.md", "# Body\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, content: "# Top\n", mode: "prepend" });
    expect(out).toContain("Prepended");
    expect(disk(p).startsWith("# Top")).toBe(true);
  });

  test("rejects code files", async () => {
    const p = seed("nope.ts", "const x = 1;");
    const out = await post("do_noncode", { file_path: p, content: "overwrite" });
    expect(out).toMatch(/refuses code|do_code/i);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  do_noncode: target mode (linguistic scope)
// ═══════════════════════════════════════════════════════════════════════════

describe("do_noncode: target", () => {
  test("markdown heading replaces section", async () => {
    const p = seed("target-md.md", "# Title\n\nIntro text.\n\n## Setup\n\nOld setup instructions.\n\n## Usage\n\nUsage text.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "## Setup", content: "## Setup\n\nNew setup: just run it.\n\n" });
    expect(out).toContain("Replaced");
    expect(out).toContain("paragraph");
    const after = disk(p);
    expect(after).toContain("New setup: just run it");
    expect(after).not.toContain("Old setup instructions");
    // Title and Usage must survive
    expect(after).toContain("# Title");
    expect(after).toContain("## Usage");
    expect(after).toContain("Usage text");
  });

  test("env var replaces a single line", async () => {
    const p = seed("target.env", "HOST=localhost\nPORT=3000\nDATABASE_URL=postgres://old\nSECRET=abc\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "DATABASE_URL", content: "DATABASE_URL=postgres://new-host/db\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("DATABASE_URL=postgres://new-host/db");
    expect(after).not.toContain("postgres://old");
    // Others survive
    expect(after).toContain("HOST=localhost");
    expect(after).toContain("PORT=3000");
    expect(after).toContain("SECRET=abc");
  });

  test("json key replaces value", async () => {
    const p = seed("target.json", '{\n  "name": "my-app",\n  "version": "1.0.0",\n  "description": "old desc"\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "version", content: '  "version": "2.0.0",\n' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"2.0.0"');
    expect(after).not.toContain('"1.0.0"');
    expect(after).toContain('"name"');
    expect(after).toContain('"description"');
  });

  test("yaml key replaces block", async () => {
    const p = seed("target.yaml", "server:\n  port: 3000\n  host: localhost\nredis:\n  url: redis://old\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "server", content: "server:\n  port: 9090\n  host: 0.0.0.0\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port: 9090");
    expect(after).not.toContain("port: 3000");
    // Redis survives
    expect(after).toContain("redis:");
  });

  test("toml section replaces block", async () => {
    const p = seed("target.toml", "[server]\nport = 3000\nhost = \"localhost\"\n\n[database]\nurl = \"old\"\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "server", content: "[server]\nport = 9090\n\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port = 9090");
    expect(after).not.toContain("port = 3000");
    expect(after).toContain("[database]");
  });

  test("target not found returns error", async () => {
    const p = seed("target-miss.md", "# Title\n\nSome text.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "## Nonexistent", content: "x" });
    expect(out).toContain("not found");
  });

  test("duplicate headings: warns about ambiguity", async () => {
    const p = seed("target-dup.md", "# Title\n\n## Setup\n\nFirst setup.\n\n## Usage\n\nUse it.\n\n## Setup\n\nSecond setup.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "## Setup", content: "## Setup\n\nReplaced first.\n\n" });
    // Should succeed (first match) but warn about duplicates
    expect(out).toContain("Replaced");
    expect(out).toMatch(/2 matches|disambiguate/);
    const after = disk(p);
    expect(after).toContain("Replaced first");
    expect(after).toContain("Second setup"); // second one untouched
  });

  test("duplicate headings: #N targets the Nth match", async () => {
    const p = seed("target-dup2.md", "## Setup\n\nFirst.\n\n## Usage\n\nUse it.\n\n## Setup\n\nSecond.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "## Setup#2", content: "## Setup\n\nReplaced second.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("First."); // first one untouched
    expect(after).toContain("Replaced second");
  });

  test("env: exact key match, no partial", async () => {
    const p = seed("target-env-exact.env", "PORT=3000\nSUPPORT_PORT=4000\nPORT_DEBUG=5000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, target: "PORT", content: "PORT=9090\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("PORT=9090");
    expect(after).toContain("SUPPORT_PORT=4000"); // not touched
    expect(after).toContain("PORT_DEBUG=5000"); // not touched
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  bash
// ═══════════════════════════════════════════════════════════════════════════

describe("bash", () => {
  test("runs a command", async () => {
    const out = await post("bash", { command: "echo hello-from-bash" });
    expect(out).toContain("hello-from-bash");
  });

  test("rejects blacklisted commands", async () => {
    for (const cmd of ["cat /etc/passwd", "grep foo bar", "find . -name x", "ls /tmp"]) {
      const out = await post("bash", { command: cmd });
      expect(out).toMatch(/banned|read\b/i);
    }
  });

  test("captures exit code", async () => {
    const out = await post("bash", { command: "exit 42" });
    expect(out).toContain("42");
  });
});
