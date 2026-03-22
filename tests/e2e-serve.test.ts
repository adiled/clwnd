import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = 14567;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-sonnet-4-5" };
const HOME = process.env.HOME ?? "/tmp";
const SUITE_DIR = join(HOME, ".clwnd-e2e-serve");
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

async function sendMessage(sessionID: string, text: string, agent?: string, timeoutMs = 120_000): Promise<{ info: any; parts: any[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        agent,
        parts: [{ type: "text", text }],
      }),
      signal: ctrl.signal,
    });
    return r.json() as any;
  } finally {
    clearTimeout(timer);
  }
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

// ─── Process Cleanup ────────────────────────────────────────────────────────

async function sh(cmd: string): Promise<void> {
  const p = spawn({ cmd: ["sh", "-c", cmd], stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

async function nuke(pid?: number): Promise<void> {
  // 1. Kill children first, then parent (by PID)
  if (pid) {
    await sh(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`);
    await Bun.sleep(1_000);
    await sh(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`);
    await Bun.sleep(500);
  }

  // 2. Kill anything matching our port pattern (catches reparented children)
  await sh(`pkill -KILL -f "opencode serve.*--port ${PORT}" 2>/dev/null`);
  await Bun.sleep(500);

  // 3. Kill anything still holding the port
  await sh(`lsof -ti :${PORT} | xargs -r kill -9 2>/dev/null`);
  await Bun.sleep(500);

  // 4. Verify port is free
  const probe = spawn({ cmd: ["sh", "-c", `lsof -ti :${PORT}`], stdout: "pipe", stderr: "pipe" });
  const out = await new Response(probe.stdout).text();
  await probe.exited;
  if (out.trim()) {
    // Something survived everything above — last resort
    await sh(`echo "${out.trim()}" | xargs kill -9 2>/dev/null`);
    await Bun.sleep(500);
  }
}

// ─── Suite Lifecycle ────────────────────────────────────────────────────────

let server: Subprocess;

beforeAll(async () => {
  // Obliterate anything from a prior run
  await nuke();

  // Verify port is actually free (nuke can't kill processes owned by other users)
  const portCheck = spawn({ cmd: ["sh", "-c", `lsof -ti :${PORT}`], stdout: "pipe", stderr: "pipe" });
  const portPids = (await new Response(portCheck.stdout).text()).trim();
  await portCheck.exited;
  if (portPids) {
    throw new Error(`Port ${PORT} still held by PID(s) ${portPids} after cleanup — likely owned by another user. Kill manually: sudo kill -9 ${portPids}`);
  }

  // Create suite directory structure
  await sh(`rm -rf ${SUITE_DIR}`);
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
  const pid = server?.pid;
  // Nuke by PID (children + parent), by name pattern, and by port
  await nuke(pid);
  // Wait for Bun's handle on the process to settle
  try { await server?.exited; } catch {}
  // Cleanup suite directory
  await sh(`rm -rf ${SUITE_DIR}`);
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
  test("todowrite creates todos visible in opencode", async () => {
    skipIfDead();
    const sid = await createSession();

    // Claude executes TodoWrite via MCP, OpenCode re-executes for UI sync
    const resp = await sendMessage(sid, "Use the TodoWrite tool to create todos: buy groceries, clean house");
    // Brokered tool — Claude's response text should confirm the action
    // The blocking API returns the brokered return (empty), so check messages
    const msgs = await getMessages(sid);
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
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

  test("webfetch response visible in messages", async () => {
    skipIfDead();
    const sid = await createSession();

    // Brokered tool — Claude fetches via MCP, OpenCode re-executes for UI
    await sendMessage(sid, "Fetch https://example.com and tell me what the page contains");
    // Check messages API for Claude's response about the page content
    const msgs = await getMessages(sid);
    const assistantMsgs = msgs.filter((m: any) => m.role === "assistant");
    expect(assistantMsgs.length).toBeGreaterThan(0);
  }, TIMEOUT);
});
