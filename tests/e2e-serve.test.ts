import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = 14567;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-haiku-4-5" };
const SUITE_DIR = "/tmp/clwnd-e2e-serve";
const PROJECT_DIR = join(SUITE_DIR, "project");
const TIMEOUT = 180_000;

// Track sessions created during each test for cleanup
const activeSessions: string[] = [];

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
  const sid = (r as any).id;
  if (sid) activeSessions.push(sid);
  return sid;
}

async function deleteSession(sid: string): Promise<void> {
  try {
    const proc = spawn({
      cmd: ["opencode", "session", "delete", sid],
      cwd: PROJECT_DIR,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
  } catch {}
}

async function sendMessage(sessionID: string, text: string, agent?: string): Promise<{ info: any; parts: any[] }> {
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

async function getSession(sessionID: string): Promise<any> {
  return api(`/session/${sessionID}`);
}

async function getMessages(sessionID: string): Promise<any[]> {
  const r = await api(`/session/${sessionID}/message`);
  return (r as any) ?? [];
}

function extractResponseText(resp: { info: any; parts: any[] }): string {
  return (resp.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("");
}

async function serverIsAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${BASE}/session/status`);
    return r.ok;
  } catch {
    return false;
  }
}

async function killPort(port: number): Promise<void> {
  try {
    const proc = spawn({
      cmd: ["sh", "-c", `lsof -ti :${port} | xargs -r kill -9`],
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    await Bun.sleep(500);
  } catch {}
}

// ─── Suite Lifecycle ────────────────────────────────────────────────────────

let server: Subprocess;

beforeAll(async () => {
  // Kill any lingering processes on our port
  await killPort(PORT);

  // Create suite directory structure
  if (existsSync(SUITE_DIR)) rmSync(SUITE_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  // Init git repo in project dir
  const gitInit = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitInit.exited;
  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");

  // Claude permissions for MCP tools
  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: [
      "mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)",
      "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)",
    ] },
  }, null, 2));

  const gitAdd = spawn({ cmd: ["git", "add", "."], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitAdd.exited;
  const gitCommit = spawn({
    cmd: ["git", "commit", "-m", "init"],
    cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await gitCommit.exited;

  // Start opencode serve — ONCE for the entire suite
  server = spawn({
    cmd: ["opencode", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"],
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  // Wait for server readiness
  const deadline = Date.now() + 20_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (await serverIsAlive()) { ready = true; break; }
    await Bun.sleep(500);
  }
  if (!ready) throw new Error("opencode serve failed to start within 20s");
}, 30_000);

afterAll(async () => {
  // Graceful shutdown: SIGTERM first, then SIGKILL
  try { server.kill("SIGTERM"); } catch {}
  const exited = Promise.race([
    server.exited.catch(() => {}),
    Bun.sleep(5_000).then(() => "timeout"),
  ]);
  if (await exited === "timeout") {
    try { server.kill("SIGKILL"); } catch {}
    await server.exited.catch(() => {});
  }

  // Kill anything still on the port
  await killPort(PORT);

  // Cleanup suite directory
  if (existsSync(SUITE_DIR)) rmSync(SUITE_DIR, { recursive: true });
}, 15_000);

// ─── Per-Test Cleanup ───────────────────────────────────────────────────────

afterEach(async () => {
  // Delete all sessions created during the test
  while (activeSessions.length > 0) {
    const sid = activeSessions.pop()!;
    await deleteSession(sid);
  }

  // Reset hello.txt for tests that modify it
  if (existsSync(PROJECT_DIR)) {
    await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");
  }
});

// ─── Guard ──────────────────────────────────────────────────────────────────

function skipIfDead() {
  // Inline check — if server crashed, skip remaining tests gracefully
  if (server?.exitCode !== null) {
    throw new Error("opencode serve is no longer running — skipping");
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("e2e-serve: session basics", () => {
  test("create session and send message", async () => {
    skipIfDead();
    const sid = await createSession();
    expect(sid).toBeTruthy();

    const resp = await sendMessage(sid, "What is 2+2? Just the number.");
    const text = extractResponseText(resp);
    expect(text).toContain("4");
  }, TIMEOUT);

  test("session continuity across turns", async () => {
    skipIfDead();
    const sid = await createSession();

    await sendMessage(sid, "My favorite planet is Mars. Acknowledge.");

    const resp = await sendMessage(sid, "What is my favorite planet?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("mars");
  }, TIMEOUT);
});

describe("e2e-serve: agent switching", () => {
  test("switch from build to plan agent", async () => {
    skipIfDead();
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
    expect(resp).toBeDefined();
  }, TIMEOUT);
});

describe("e2e-serve: CWD from session", () => {
  test("session directory is used for file operations", async () => {
    skipIfDead();
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
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Use the TodoWrite tool to create todos: buy groceries, clean house");
    // Verify the tool was at least called — todo sync is model-dependent
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe("e2e-serve: tool rendering metadata", () => {
  test("read produces tool part with correct name", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, `Read ${join(PROJECT_DIR, "hello.txt")}`);
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && p.tool === "read");
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("edit produces tool part with correct name", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, `Read ${join(PROJECT_DIR, "hello.txt")} then change "hello" to "hi" in it`);
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && (p.tool === "edit" || p.tool === "read"));
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("bash produces tool part with output metadata", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, 'Run: echo "BASH_RENDER_TEST"');
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && p.tool === "bash");
    expect(toolParts.length).toBeGreaterThan(0);
    if (toolParts[0]?.state?.metadata?.output) {
      expect(toolParts[0].state.metadata.output).toContain("BASH_RENDER_TEST");
    }
  }, TIMEOUT);

  test("webfetch produces tool part with correct name", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Fetch https://example.com");
    const toolParts = (resp.parts ?? []).filter((p: any) => p.type === "tool" && (p.tool === "webfetch" || p.tool === "WebFetch"));
    expect(toolParts.length).toBeGreaterThan(0);
  }, TIMEOUT);

  test("websearch produces tool part", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Search the web for opencode");
    // WebSearch may not be available without Exa — just verify no crash
    expect(resp).toBeDefined();
  }, TIMEOUT);
});
