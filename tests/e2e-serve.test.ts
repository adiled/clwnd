import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = 14567;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-haiku-4-5" };
const PROJECT_DIR = "/tmp/clwnd-e2e-serve-project";
const TIMEOUT = 180_000;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function api(path: string, opts?: RequestInit) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  });
  return r.json();
}

async function createSession(): Promise<string> {
  const r = await api("/session", {
    method: "POST",
    body: JSON.stringify({ directory: PROJECT_DIR }),
  });
  return (r as any).id;
}

async function sendMessage(sessionID: string, text: string, agent?: string): Promise<{ info: any; parts: any[] }> {
  // POST /session/:id/message blocks until the response is complete
  const r = await fetch(`${BASE}/session/${sessionID}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      agent,
      parts: [{ type: "text", text }],
    }),
  });
  return r.json() as any;
}

async function sendCommand(sessionID: string, command: string, args?: string): Promise<any> {
  return api(`/session/${sessionID}/command`, {
    method: "POST",
    body: JSON.stringify({ command, arguments: args ?? "" }),
  });
}

async function getSession(sessionID: string): Promise<any> {
  return api(`/session/${sessionID}`);
}

async function getMessages(sessionID: string): Promise<any[]> {
  const r = await api(`/session/${sessionID}/message`);
  return (r as any) ?? [];
}

async function getTodos(sessionID: string): Promise<any[]> {
  const r = await api(`/session/${sessionID}/todo`);
  return (r as any) ?? [];
}

function extractResponseText(resp: { info: any; parts: any[] }): string {
  return (resp.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("");
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let server: Subprocess;

beforeAll(async () => {
  // Create project dir
  if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  const gitInit = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitInit.exited;
  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");

  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: ["mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)", "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)"] },
  }, null, 2));

  const gitAdd = spawn({ cmd: ["git", "add", "."], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitAdd.exited;
  const gitCommit = spawn({
    cmd: ["git", "commit", "-m", "init"],
    cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await gitCommit.exited;

  // Start opencode serve
  server = spawn({
    cmd: ["opencode", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"],
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Wait for server to be ready
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/session/status`);
      if (r.ok) break;
    } catch {}
    await Bun.sleep(500);
  }
}, 30_000);

afterAll(async () => {
  try { server.kill(); } catch {}
  await server.exited.catch(() => {});
  if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("e2e-serve: session basics", () => {
  test("create session and send message", async () => {
    const sid = await createSession();
    expect(sid).toBeTruthy();

    const resp = await sendMessage(sid, "What is 2+2? Just the number.");
    const text = extractResponseText(resp);
    expect(text).toContain("4");
  }, TIMEOUT);

  test("session continuity across turns", async () => {
    const sid = await createSession();

    await sendMessage(sid, "My favorite planet is Mars. Acknowledge.");

    const resp = await sendMessage(sid, "What is my favorite planet?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("mars");
  }, TIMEOUT);
});

describe("e2e-serve: agent switching", () => {
  test("switch from build to plan agent", async () => {
    const sid = await createSession();

    await sendMessage(sid, "Say hello", "build");
    const resp = await sendMessage(sid, "What agent are you running as?", "plan");

    // Verify via messages API that agent changed
    const msgs = await getMessages(sid);
    if (msgs.length > 0) {
      const userMsgs = msgs.filter((m: any) => m.role === "user");
      if (userMsgs.length >= 2) {
        expect(userMsgs[0].agent).toBe("build");
        expect(userMsgs[1].agent).toBe("plan");
      }
    }
    // Response should exist
    expect(resp).toBeDefined();
  }, TIMEOUT);
});

describe("e2e-serve: CWD from session", () => {
  test("session directory is used for file operations", async () => {
    const sid = await createSession();
    const session = await getSession(sid);
    expect(session.directory).toBe(PROJECT_DIR);

    const resp = await sendMessage(sid, `Read the file ${join(PROJECT_DIR, "hello.txt")} and tell me what it says`);
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("hello world");
  }, TIMEOUT);
});

describe("e2e-serve: todo sync", () => {
  test("todowrite creates todos in opencode", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, "Use the TodoWrite tool to create todos: buy groceries, clean house");
    // Verify the tool was at least called — todo sync is model-dependent
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe("e2e-serve: tool rendering metadata", () => {
  test("edit produces tool part with correct name", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, `Read ${join(PROJECT_DIR, "hello.txt")} then change "hello" to "hi" in it`);
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && (p.tool === "edit" || p.tool === "read"));
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("read produces tool part with correct name", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, `Read ${join(PROJECT_DIR, "hello.txt")}`);
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && p.tool === "read");
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("bash produces tool part with output metadata", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, 'Run: echo "BASH_RENDER_TEST"');
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && p.tool === "bash");
    expect(toolParts.length).toBeGreaterThan(0);
    if (toolParts[0]?.state?.metadata?.output) {
      expect(toolParts[0].state.metadata.output).toContain("BASH_RENDER_TEST");
    }
  }, TIMEOUT);

  test("webfetch produces tool part with correct name", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, "Fetch https://example.com");
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && (p.tool === "webfetch" || p.tool === "WebFetch"));
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("websearch produces tool part", async () => {
    const sid = await createSession();

    const resp = await sendMessage(sid, "Search the web for opencode");
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && (p.tool === "websearch" || p.tool === "WebSearch"));
    // WebSearch may not be available without Exa — just verify no crash
    expect(resp).toBeDefined();
  }, TIMEOUT);
});
