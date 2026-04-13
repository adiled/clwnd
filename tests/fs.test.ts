/**
 * Filesystem MCP integration tests.
 *
 * Hits the daemon's MCP HTTP endpoint directly — same JSON-RPC transport
 * Claude CLI uses. No unit tests, no function imports. Tests the tools
 * as an external consumer would see them.
 *
 * Requires: daemon running on port 29147 (./dev deploys + restarts it).
 */

import { describe, test, expect, beforeAll, afterAll } from "vitest";
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
  test("no scope = create new file", async () => {
    const p = join(SUITE_DIR, "new.md");
    const out = await post("do_noncode", { file_path: p, replace: "# Test\n\nHello." });
    expect(out).toContain("Created");
    expect(disk(p)).toContain("# Test");
  });

  test("no scope = overwrite existing file", async () => {
    const p = seed("overwrite.md", "# Old\n");
    const out = await post("do_noncode", { file_path: p, replace: "# New\n" });
    expect(out).toContain("Overwrote");
    expect(disk(p)).toBe("# New\n");
  });

  test("rejects code files", async () => {
    const p = seed("nope.ts", "const x = 1;");
    const out = await post("do_noncode", { file_path: p, replace: "overwrite" });
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
    // Target is the heading (word). Content is the body it governs — NOT the heading itself.
    const out = await post("do_noncode", { file_path: p, phrase: "## Setup", replace: "\nNew setup: just run it.\n\n" });
    expect(out).toContain("Replaced");
    expect(out).toContain("paragraph");
    const after = disk(p);
    expect(after).toContain("## Setup");  // heading preserved
    expect(after).toContain("New setup: just run it");
    expect(after).not.toContain("Old setup instructions");
    expect(after).toContain("# Title");
    expect(after).toContain("## Usage");
    expect(after).toContain("Usage text");
  });

  test("env var replaces value", async () => {
    const p = seed("target.env", "HOST=localhost\nPORT=3000\nDATABASE_URL=postgres://old\nSECRET=abc\n");
    await post("read", { file_path: p });
    // Target is the var name (word). Content is the value (phrase) — not KEY=value.
    const out = await post("do_noncode", { file_path: p, phrase: "DATABASE_URL", replace: "postgres://new-host/db" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("DATABASE_URL=postgres://new-host/db");
    expect(after).not.toContain("postgres://old");
    expect(after).toContain("HOST=localhost");
    expect(after).toContain("PORT=3000");
    expect(after).toContain("SECRET=abc");
  });

  test("json key replaces value", async () => {
    const p = seed("target.json", '{\n  "name": "my-app",\n  "version": "1.0.0",\n  "description": "old desc"\n}\n');
    await post("read", { file_path: p });
    // Target is the key path, content is the new VALUE (not key+value)
    const out = await post("do_noncode", { file_path: p, phrase: "version", replace: '"2.0.0"' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"version": "2.0.0"');
    expect(after).not.toContain('"1.0.0"');
    expect(after).toContain('"name"');
    expect(after).toContain('"description"');
    // Must be valid JSON
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test("json nested key with colon in name", async () => {
    // Real-world: opencode.json provider config with model name containing colon
    const p = seed("oc.json", JSON.stringify({
      provider: {
        ollama: {
          npm: "@ai-sdk/openai-compatible",
          name: "Ollama",
          models: {
            "gemma3:4b": { name: "Gemma 3 4B", tool_call: true }
          }
        },
        other: { name: "Other" }
      }
    }, null, 2) + "\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", {
      file_path: p,
      phrase: "provider.ollama.models.gemma3:4b",
      replace: '{\n          "name": "Gemma 3 4B",\n          "tool_call": false\n        }',
    });
    expect(out).toContain("Replaced");
    const after = disk(p);
    // Key must survive
    expect(after).toContain('"gemma3:4b"');
    // Value replaced
    expect(after).toContain('"tool_call": false');
    expect(after).not.toContain('"tool_call": true');
    // Sibling key survives
    expect(after).toContain('"other"');
    // Must be valid JSON
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test("json object value replacement preserves structure", async () => {
    const p = seed("nested.json", JSON.stringify({
      provider: {
        ollama: { npm: "pkg", models: { a: 1 } },
        clwnd: { npm: "other" }
      }
    }, null, 2) + "\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", {
      file_path: p,
      phrase: "provider.ollama",
      replace: '{\n      "npm": "new-pkg",\n      "models": {}\n    }',
    });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"new-pkg"');
    expect(after).not.toContain('"pkg"');
    // Sibling preserved
    expect(after).toContain('"clwnd"');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test("yaml key replaces block", async () => {
    const p = seed("target.yaml", "server:\n  port: 3000\n  host: localhost\nredis:\n  url: redis://old\n");
    await post("read", { file_path: p });
    // Target is the key (word). Content is the indented body it governs.
    const out = await post("do_noncode", { file_path: p, phrase: "server", replace: "  port: 9090\n  host: 0.0.0.0\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("server:");  // key preserved
    expect(after).toContain("port: 9090");
    expect(after).not.toContain("port: 3000");
    expect(after).toContain("redis:");
  });

  test("toml section replaces block", async () => {
    const p = seed("target.toml", "[server]\nport = 3000\nhost = \"localhost\"\n\n[database]\nurl = \"old\"\n");
    await post("read", { file_path: p });
    // Target is the section header (word). Content is the body it governs.
    const out = await post("do_noncode", { file_path: p, phrase: "[server]", replace: "port = 9090\n\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("[server]");  // header preserved
    expect(after).toContain("port = 9090");
    expect(after).not.toContain("port = 3000");
    expect(after).toContain("[database]");
  });

  test("target not found returns error", async () => {
    const p = seed("target-miss.md", "# Title\n\nSome text.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "## Nonexistent", replace: "x" });
    expect(out).toContain("not found");
  });

  test("duplicate headings: warns about ambiguity", async () => {
    const p = seed("target-dup.md", "# Title\n\n## Setup\n\nFirst setup.\n\n## Usage\n\nUse it.\n\n## Setup\n\nSecond setup.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "## Setup", replace: "\nReplaced first.\n\n" });
    // Should succeed (first match) but warn about duplicates
    expect(out).toContain("Replaced");
    expect(out).toMatch(/2 matches|disambiguate/);
    const after = disk(p);
    expect(after).toContain("## Setup"); // heading preserved
    expect(after).toContain("Replaced first");
    expect(after).toContain("Second setup"); // second one untouched
  });

  test("duplicate headings: #N targets the Nth match", async () => {
    const p = seed("target-dup2.md", "## Setup\n\nFirst.\n\n## Usage\n\nUse it.\n\n## Setup\n\nSecond.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "## Setup#2", replace: "\nReplaced second.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("First."); // first one untouched
    expect(after).toContain("Replaced second");
  });

  test("env: exact key match, no partial", async () => {
    const p = seed("target-env-exact.env", "PORT=3000\nSUPPORT_PORT=4000\nPORT_DEBUG=5000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "PORT", replace: "9090" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("PORT=9090");
    expect(after).toContain("SUPPORT_PORT=4000"); // not touched
    expect(after).toContain("PORT_DEBUG=5000"); // not touched
  });

  // ── phrase: all formats ──────────────────────────────────────────

  test("phrase: markdown — two surgical replacements", async () => {
    const p = seed("phrase.md", "# Title\n\nThe tool is very restrictive and hard to use.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "very restrictive", replace: "linguistically aware" });
    await post("do_noncode", { file_path: p, phrase: "hard to use", replace: "intuitive to use" });
    const after = disk(p);
    expect(after).toContain("linguistically aware");
    expect(after).toContain("intuitive to use");
    expect(after).not.toContain("very restrictive");
    expect(after).not.toContain("hard to use");
  });

  test("phrase: json — replace key-value pair", async () => {
    const p = seed("phrase.json", '{\n  "name": "old",\n  "version": "1.0.0"\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: '"name": "old"', replace: '"name": "new"' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"name": "new"');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test("phrase: yaml — replace scalar value", async () => {
    const p = seed("phrase.yaml", "server:\n  port: 3000\n  host: localhost\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "port: 3000", replace: "port: 9090" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port: 9090");
    expect(after).not.toContain("port: 3000");
    expect(after).toContain("host: localhost");
  });

  test("phrase: env — replace full assignment", async () => {
    const p = seed("phrase.env", "HOST=localhost\nPORT=3000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "PORT=3000", replace: "PORT=9090" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("PORT=9090");
    expect(after).toContain("HOST=localhost");
  });

  test("phrase: toml — replace key-value", async () => {
    const p = seed("phrase.toml", "[server]\nport = 3000\nhost = \"localhost\"\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: 'port = 3000', replace: 'port = 9090' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port = 9090");
    expect(after).not.toContain("port = 3000");
  });

  // ── sentence: all formats ─────────────────────────────────────────

  test("sentence: markdown — replaces to blank-line boundary", async () => {
    const p = seed("sentence.md", "# Intro\n\nFirst sentence here.\nSecond sentence here.\n\nAnother paragraph.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: "First sentence", replace: "Replaced block.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("Replaced block.");
    expect(after).not.toContain("First sentence");
    expect(after).toContain("Another paragraph.");
  });

  test("sentence: yaml — replaces contiguous block", async () => {
    const p = seed("sentence.yaml", "server:\n  port: 3000\n  host: localhost\n\nredis:\n  url: redis://old\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: "port: 3000", replace: "server:\n  port: 9090\n  host: 0.0.0.0\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port: 9090");
    expect(after).not.toContain("port: 3000");
    expect(after).toContain("redis:");
  });

  test("sentence: json — replaces contiguous block", async () => {
    const p = seed("sentence.json", '{\n  "name": "app",\n  "version": "1.0.0",\n\n  "scripts": {\n    "build": "tsc"\n  }\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: '"name": "app"', replace: '  "name": "new-app",\n  "version": "2.0.0",' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"new-app"');
    expect(after).toContain('"scripts"');
  });

  test("sentence: env — replaces contiguous vars", async () => {
    const p = seed("sentence.env", "# Database\nDB_HOST=localhost\nDB_PORT=5432\n\n# Redis\nREDIS_URL=redis://old\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: "DB_HOST", replace: "# Database\nDB_HOST=newhost\nDB_PORT=5433\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("DB_HOST=newhost");
    expect(after).toContain("DB_PORT=5433");
    expect(after).toContain("REDIS_URL=redis://old");
  });

  // ── paragraph: all formats ────────────────────────────────────────

  test("paragraph: prose — replaces to blank-line boundary", async () => {
    const p = seed("para.md", "First paragraph line one.\nFirst paragraph line two.\n\nSecond paragraph.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "First paragraph", replace: "New single paragraph.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("New single paragraph.");
    expect(after).not.toContain("line one");
    expect(after).not.toContain("line two");
    expect(after).toContain("Second paragraph.");
  });

  test("paragraph: yaml — replaces block between blank lines", async () => {
    const p = seed("para.yaml", "server:\n  port: 3000\n  host: localhost\n\nredis:\n  url: redis://old\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "server:", replace: "server:\n  port: 9090\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port: 9090");
    expect(after).not.toContain("host: localhost");
    expect(after).toContain("redis:");
  });

  test("paragraph: env — replaces comment group + vars", async () => {
    const p = seed("para.env", "# App\nNODE_ENV=production\nPORT=3000\n\n# Database\nDB_URL=postgres://old\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "# App", replace: "# App\nNODE_ENV=staging\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("NODE_ENV=staging");
    expect(after).not.toContain("PORT=3000");
    expect(after).toContain("DB_URL=postgres://old");
  });

  // ── delete (omit replace) ─────────────────────────────────────────

  test("omit replace to delete paragraph", async () => {
    const p = seed("delete.md", "# Title\n\nKeep this.\n\nDelete this paragraph.\n\nKeep this too.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "Delete this" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).not.toContain("Delete this");
    expect(after).toContain("Keep this.");
    expect(after).toContain("Keep this too.");
  });

  test("omit replace to delete phrase", async () => {
    const p = seed("delete-phrase.md", "The quick brown fox jumps over the lazy dog.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "brown " });
    const after = disk(p);
    expect(after).toContain("The quick fox");
    expect(after).not.toContain("brown");
  });

  // ── phrase: additional format coverage ──────────────────────────────

  test("phrase: yaml scalar value", async () => {
    const p = seed("word-yaml-scalar.yaml", "server:\n  port: 3000\n  host: localhost\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "port", replace: " 9090" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port: 9090");
    expect(after).toContain("host: localhost");
  });

  test("phrase: toml key value", async () => {
    const p = seed("word-toml-key.toml", "[server]\nport = 3000\nhost = \"localhost\"\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "port", replace: '9090' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port = 9090");
    expect(after).not.toContain("3000");
  });

  test("phrase: env with export prefix", async () => {
    const p = seed("word-env-export.env", "export NODE_ENV=development\nexport PORT=3000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "NODE_ENV", replace: "production" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("NODE_ENV=production");
    expect(after).toContain("PORT=3000");
  });

  test("phrase: json array value", async () => {
    const p = seed("word-json-array.json", '{\n  "tags": ["alpha", "beta"],\n  "name": "test"\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "tags", replace: '["stable", "release"]' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"stable"');
    expect(after).not.toContain('"alpha"');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  test("phrase: json boolean value", async () => {
    const p = seed("word-json-bool.json", '{\n  "enabled": true,\n  "name": "test"\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "enabled", replace: "false" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"enabled": false');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  // ── word: token replacement (format-agnostic) ─────────────────────

  test("word: replace token in prose", async () => {
    const p = seed("word-prose.txt", "The server runs on localhost port 3000.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "localhost", replace: "127.0.0.1" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("127.0.0.1");
    expect(after).not.toContain("localhost");
  });

  test("word: replace token in yaml", async () => {
    const p = seed("word-yaml.yaml", "server:\n  host: localhost\n  port: 3000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "localhost", replace: "0.0.0.0" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("host: 0.0.0.0");
    expect(after).not.toContain("localhost");
  });

  test("word: replace token in json", async () => {
    const p = seed("word-json.json", '{\n  "host": "localhost",\n  "port": 3000\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "localhost", replace: "0.0.0.0" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("0.0.0.0");
    expect(after).not.toContain("localhost");
  });

  test("word: replace token in env", async () => {
    const p = seed("word-env.env", "HOST=localhost\nPORT=3000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "localhost", replace: "0.0.0.0" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("HOST=0.0.0.0");
  });

  test("word: replace token in toml", async () => {
    const p = seed("word-toml.toml", "[server]\nhost = \"localhost\"\nport = 3000\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "localhost", replace: "0.0.0.0" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("0.0.0.0");
    expect(after).not.toContain("localhost");
  });

  test("word: replace token in markdown", async () => {
    const p = seed("word-md.md", "# Deploy Guide\n\nDeploy to localhost using docker.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "docker", replace: "podman" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("podman");
    expect(after).not.toContain("docker");
    expect(after).toContain("localhost"); // other tokens untouched
  });

  test("word: does not match substring", async () => {
    const p = seed("word-boundary.txt", "The reporter reported on the port.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, word: "port", replace: "harbor" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("reporter reported"); // not touched
    expect(after).toContain("the harbor."); // only standalone "port" replaced
  });

  test("word: delete token", async () => {
    const p = seed("word-delete.txt", "Remove the old cruft here.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "old" });
    const after = disk(p);
    expect(after).not.toContain("old");
    expect(after).toContain("Remove the");
  });

  // ── fill the matrix: every format × every scope ───────────────────

  test("sentence: toml — replaces contiguous block", async () => {
    const p = seed("sentence.toml", "[server]\nport = 3000\nhost = \"localhost\"\n\n[database]\nurl = \"old\"\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: "port = 3000", replace: "[server]\nport = 9090\nhost = \"new\"\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("port = 9090");
    expect(after).not.toContain("port = 3000");
    expect(after).toContain("[database]");
  });

  test("paragraph: json — replaces enclosing object", async () => {
    const p = seed("para.json", '{\n  "server": {\n    "host": "old",\n    "port": 3000\n  },\n  "name": "app"\n}\n');
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: '"host"', replace: '{\n    "host": "new",\n    "port": 9090\n  }' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('"host": "new"');
    expect(after).toContain("9090");
    expect(after).not.toContain('"old"');
    expect(after).toContain('"name"');
  });

  test("paragraph: toml — replaces section block", async () => {
    const p = seed("para.toml", "[server]\nport = 3000\n\n[database]\nurl = \"old\"\n\n[redis]\nurl = \"redis://x\"\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "url = \"old\"", replace: "[database]\nurl = \"new\"\npool = 10\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain('url = "new"');
    expect(after).toContain("pool = 10");
    expect(after).toContain("[server]");
    expect(after).toContain("[redis]");
  });

  test("paragraph: markdown — replaces prose block", async () => {
    const p = seed("para-md.md", "# Title\n\nFirst paragraph about setup.\nIt spans two lines.\n\nSecond paragraph about usage.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: "First paragraph", replace: "New paragraph about installation.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("New paragraph about installation.");
    expect(after).not.toContain("spans two lines");
    expect(after).toContain("Second paragraph about usage.");
  });

  test("sentence: prose — replaces between blank lines", async () => {
    const p = seed("sentence-prose.txt", "Line one of block.\nLine two of block.\n\nSeparate block.\n");
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, sentence: "Line one", replace: "Replaced block.\n" });
    expect(out).toContain("Replaced");
    const after = disk(p);
    expect(after).toContain("Replaced block.");
    expect(after).not.toContain("Line two");
    expect(after).toContain("Separate block.");
  });

  test("delete: word — removes governed scope, word stays", async () => {
    const p = seed("delete-word.yaml", "server:\n  port: 3000\n  host: localhost\nredis:\n  url: old\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "redis", replace: "" });
    const after = disk(p);
    expect(after).toContain("server:");
    expect(after).toContain("port: 3000");
    expect(after).toContain("redis:");    // word stays
    expect(after).not.toContain("url: old"); // body gone
  });

  test("delete: sentence in env — single line", async () => {
    const p = seed("delete-sentence.env", "# Config\nHOST=localhost\nPORT=3000\n\n# Secrets\nSECRET=abc\n");
    await post("read", { file_path: p });
    // Sentence in env = single line
    await post("do_noncode", { file_path: p, sentence: "HOST=localhost" });
    const after = disk(p);
    expect(after).not.toContain("HOST=localhost");
    expect(after).toContain("PORT=3000"); // sibling line survives
    expect(after).toContain("SECRET=abc");
  });

  test("delete: phrase in json — key path deletion", async () => {
    const p = seed("delete-json.json", '{\n  "name": "app",\n  "debug": true,\n  "version": "1.0.0"\n}\n');
    await post("read", { file_path: p });
    // Use key name — comma cleanup handles the structural deletion
    await post("do_noncode", { file_path: p, phrase: "debug" });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    expect(after).not.toContain("debug");
    expect(after).toContain('"name"');
    expect(after).toContain('"version"');
  });

  test("delete: phrase in toml", async () => {
    const p = seed("delete-toml.toml", "[server]\nport = 3000\nhost = \"localhost\"\ndebug = true\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "debug = true\n" });
    const after = disk(p);
    expect(after).not.toContain("debug");
    expect(after).toContain("port = 3000");
    expect(after).toContain("[server]");
  });

  test("delete: sentence in prose", async () => {
    const p = seed("delete-prose.txt", "Keep this block.\nIt has two lines.\n\nDelete this block.\nIt also has two lines.\n\nKeep this too.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, sentence: "Delete this block" });
    const after = disk(p);
    expect(after).not.toContain("Delete this");
    expect(after).toContain("Keep this block.");
    expect(after).toContain("Keep this too.");
  });

  test("delete: paragraph in toml — section block", async () => {
    const p = seed("delete-para-toml.toml", "[server]\nport = 3000\n\n[debug]\nenabled = true\nverbose = true\n\n[database]\nurl = \"pg\"\n");
    await post("read", { file_path: p });
    // Paragraph in toml = section boundary. Quote text within the section.
    await post("do_noncode", { file_path: p, paragraph: "enabled = true" });
    const after = disk(p);
    expect(after).not.toContain("enabled");
    expect(after).not.toContain("verbose");
    expect(after).toContain("[server]");
    expect(after).toContain("[database]");
  });
  // ── corruption guards ──────────────────────────────────────────────

  test("json stays valid after phrase edit", async () => {
    const json = JSON.stringify({ a: 1, b: { c: "old", d: true }, e: [1,2,3] }, null, 2) + "\n";
    const p = seed("corrupt-json.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "b.c", replace: '"new"' });
    expect(() => JSON.parse(disk(p))).not.toThrow();
  });

  test("json auto-quotes unquoted string replacement", async () => {
    const json = '{\n  "motto": "old motto",\n  "version": "1.0.0"\n}\n';
    const p = seed("autoquote.json", json);
    await post("read", { file_path: p });
    // Agent provides unquoted text — tool should auto-quote it
    await post("do_noncode", { file_path: p, phrase: "motto", replace: "If it doesn't kill you, it makes you flinch forever." });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    const parsed = JSON.parse(after);
    expect(parsed.motto).toBe("If it doesn't kill you, it makes you flinch forever.");
    expect(parsed.version).toBe("1.0.0");
  });

  test("json auto-quote doesn't double-quote already-quoted values", async () => {
    const json = '{\n  "name": "old",\n  "count": 1\n}\n';
    const p = seed("autoquote2.json", json);
    await post("read", { file_path: p });
    // Already quoted — should not double-quote
    await post("do_noncode", { file_path: p, phrase: "name", replace: '"new"' });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    expect(JSON.parse(after).name).toBe("new");
  });

  test("json auto-quote doesn't quote objects/arrays/numbers/booleans", async () => {
    const json = '{\n  "enabled": true,\n  "tags": [],\n  "config": {},\n  "count": 0\n}\n';
    const p = seed("autoquote3.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "enabled", replace: "false" });
    await post("do_noncode", { file_path: p, phrase: "tags", replace: '["a", "b"]' });
    await post("do_noncode", { file_path: p, phrase: "config", replace: '{"key": "val"}' });
    await post("do_noncode", { file_path: p, phrase: "count", replace: "42" });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    const parsed = JSON.parse(after);
    expect(parsed.enabled).toBe(false);
    expect(parsed.tags).toEqual(["a", "b"]);
    expect(parsed.config).toEqual({ key: "val" });
    expect(parsed.count).toBe(42);
  });

  test("json stays valid after word edit", async () => {
    const json = '{\n  "host": "localhost",\n  "port": 3000,\n  "debug": false\n}\n';
    const p = seed("corrupt-json2.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "localhost", replace: "0.0.0.0" });
    expect(() => JSON.parse(disk(p))).not.toThrow();
  });

  test("json stays valid after nested key edit with special chars", async () => {
    const json = JSON.stringify({ "a.b": { "c:d": "old" } }, null, 2) + "\n";
    const p = seed("corrupt-json3.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: '"old"', replace: '"new"' });
    const after = disk(p);
    expect(after).toContain('"new"');
    expect(() => JSON.parse(after)).not.toThrow();
  });

  // ── validation: reject corrupting edits ────────────────────────────

  test("json: rejects edit that would produce invalid json", async () => {
    const json = '{\n  "name": "app",\n  "version": "1.0.0"\n}\n';
    const p = seed("reject-json.json", json);
    await post("read", { file_path: p });
    // Force a corrupting edit by using exact phrase with broken replacement
    const out = await post("do_noncode", { file_path: p, phrase: '"name": "app"', replace: '"name": app' });
    expect(out).toMatch(/corrupt|invalid JSON/i);
    // File must be unchanged
    expect(disk(p)).toBe(json);
  });

  test("yaml: rejects mixed tabs and spaces", async () => {
    const yaml = "server:\n  port: 3000\n  host: localhost\n";
    const p = seed("reject-yaml.yaml", yaml);
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "  port: 3000", replace: "\tport: 3000" });
    expect(out).toMatch(/corrupt|tabs.*spaces/i);
    expect(disk(p)).toBe(yaml);
  });

  test("toml: rejects broken section header", async () => {
    const toml = "[server]\nport = 3000\n";
    const p = seed("reject-toml.toml", toml);
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "[server]", replace: "[server" });
    expect(out).toMatch(/corrupt|malformed/i);
    expect(disk(p)).toBe(toml);
  });

  test("env: rejects line without =", async () => {
    const env = "HOST=localhost\nPORT=3000\n";
    const p = seed("reject-env.env", env);
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "PORT=3000", replace: "PORT 3000" });
    expect(out).toMatch(/corrupt|KEY=value/i);
    expect(disk(p)).toBe(env);
  });

  test("valid edit passes validation and writes", async () => {
    const json = '{\n  "name": "old"\n}\n';
    const p = seed("valid-edit.json", json);
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, phrase: "name", replace: "new name here" });
    expect(out).toContain("Replaced");
    expect(() => JSON.parse(disk(p))).not.toThrow();
  });

  // ── bug fixes: JSON structural editing ─────────────────────────────

  test("json deletion: removes entry with comma cleanup", async () => {
    const json = '{\n  "name": "app",\n  "debug": true,\n  "version": "1.0.0"\n}\n';
    const p = seed("delete-entry.json", json);
    await post("read", { file_path: p });
    // Delete middle entry — commas must be cleaned up
    await post("do_noncode", { file_path: p, phrase: "debug" });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    expect(after).not.toContain("debug");
    expect(JSON.parse(after).name).toBe("app");
    expect(JSON.parse(after).version).toBe("1.0.0");
  });

  test("json deletion: removes last entry without trailing comma", async () => {
    const json = '{\n  "name": "app",\n  "version": "1.0.0"\n}\n';
    const p = seed("delete-last.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "version" });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    expect(after).not.toContain("version");
    expect(JSON.parse(after).name).toBe("app");
  });

  test("sentence scope: doesn't merge lines", async () => {
    const yaml = "server:\n  port: 3000\n  host: localhost\n  debug: true\n";
    const p = seed("no-merge.yaml", yaml);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, sentence: "port: 3000", replace: "  port: 9090" });
    const after = disk(p);
    expect(after).toContain("port: 9090\n");
    expect(after).toContain("  host: localhost\n");
    // Lines must not be on the same line
    const lines = after.split("\n");
    const portLine = lines.find(l => l.includes("9090"));
    const hostLine = lines.find(l => l.includes("host"));
    expect(portLine).not.toBe(hostLine);
  });

  test("json dot-path: nested key doesn't match sibling", async () => {
    // meta.version should NOT match the top-level "version" key
    const json = JSON.stringify({
      version: "1.0.0",
      meta: { version: "2.0.0", author: "test" }
    }, null, 2) + "\n";
    const p = seed("dotpath.json", json);
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "meta.version", replace: '"3.0.0"' });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    const parsed = JSON.parse(after);
    expect(parsed.version).toBe("1.0.0"); // top-level untouched
    expect(parsed.meta.version).toBe("3.0.0"); // nested one changed
  });

  test("json paragraph: doesn't grab root object", async () => {
    const json = JSON.stringify({
      server: { host: "old", port: 3000 },
      database: { url: "pg://old" }
    }, null, 2) + "\n";
    const p = seed("para-nonroot.json", json);
    await post("read", { file_path: p });
    const out = await post("do_noncode", { file_path: p, paragraph: '"host"', replace: '{\n    "host": "new",\n    "port": 9090\n  }' });
    expect(out).toContain("Replaced");
    const after = disk(p);
    // database must survive — paragraph should scope to the server object, not root
    expect(after).toContain("database");
    expect(after).toContain('"host": "new"');
  });

  test("edit at file start preserves content", async () => {
    const p = seed("edge-start.md", "First line.\nSecond line.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "First", replace: "Opening" });
    const after = disk(p);
    expect(after).toContain("Opening line.");
    expect(after).toContain("Second line.");
  });

  test("edit at file end preserves content", async () => {
    const p = seed("edge-end.md", "Start.\nEnd.");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "End", replace: "Finish" });
    const after = disk(p);
    expect(after).toContain("Start.");
    expect(after).toContain("Finish.");
  });

  test("single-line file survives edit", async () => {
    const p = seed("single.txt", "only line here");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "only", replace: "the" });
    expect(disk(p)).toBe("the line here");
  });

  test("unicode content survives edit", async () => {
    const p = seed("unicode.md", "# Título\n\n日本語のテキスト。\n\nMore text.\n");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, phrase: "日本語のテキスト。", replace: "Replaced unicode." });
    const after = disk(p);
    expect(after).toContain("# Título");
    expect(after).toContain("Replaced unicode.");
    expect(after).toContain("More text.");
  });

  test("empty replace on phrase deletes json entry cleanly", async () => {
    const json = '{\n  "keep": true,\n  "remove": "this",\n  "also_keep": true\n}\n';
    const p = seed("corrupt-empty.json", json);
    await post("read", { file_path: p });
    // Use key name — comma cleanup handles structural deletion
    await post("do_noncode", { file_path: p, phrase: "remove" });
    const after = disk(p);
    expect(() => JSON.parse(after)).not.toThrow();
    expect(after).toContain('"keep": true');
    expect(after).toContain('"also_keep": true');
    expect(after).not.toContain("remove");
  });

  test("no trailing newline file survives edit", async () => {
    const p = seed("no-newline.txt", "no newline at end");
    await post("read", { file_path: p });
    await post("do_noncode", { file_path: p, word: "end", replace: "finish" });
    expect(disk(p)).toBe("no newline at finish");
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

  test("blocks file write commands", async () => {
    for (const cmd of [
      'echo "test" > /tmp/x.txt',
      "tee /tmp/x.txt",
      "cp a.txt b.txt",
      "mv a.txt b.txt",
      "rm a.txt",
      "touch newfile.txt",
      "mkdir newdir",
      'python3 -c "open(\'x\',\'w\').write(\'y\')"',
    ]) {
      const out = await post("bash", { command: cmd });
      expect(out).toMatch(/do_code|do_noncode/i);
    }
  });

  test("allows legitimate write operations", async () => {
    const out = await post("bash", { command: "git status" });
    expect(out).not.toMatch(/do_code|do_noncode/i);
  });
});
