import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = 14568; // Different port from e2e-serve
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-sonnet-4-5" };
const HOME = process.env.HOME ?? "/tmp";
const SUITE_DIR = join(HOME, ".clwnd-e2e-serve-asks");
const PROJECT_DIR = join(SUITE_DIR, "project");
const TIMEOUT = 240_000;

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

const DAEMON_SOCK = (process.env.CLWND_SOCKET ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/clwnd/clwnd.sock`) + ".http";

async function deleteSession(sid: string): Promise<void> {
  try {
    await fetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup", opencodeSessionId: sid }),
      unix: DAEMON_SOCK,
    } as RequestInit);
  } catch {}
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

async function sendMessage(sessionID: string, text: string, timeoutMs = 180_000): Promise<{ info: any; parts: any[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text }],
      }),
      signal: ctrl.signal,
    });
    return r.json() as any;
  } finally {
    clearTimeout(timer);
  }
}

function extractResponseText(resp: { info: any; parts: any[] }): string {
  return (resp.parts ?? [])
    .filter((p: any) => p.type === "text")
    .map((p: any) => p.text ?? "")
    .join("");
}

async function sh(cmd: string): Promise<void> {
  const p = spawn({ cmd: ["sh", "-c", cmd], stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

async function nuke(pid?: number): Promise<void> {
  if (pid) {
    await sh(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`);
    await Bun.sleep(1_000);
    await sh(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`);
    await Bun.sleep(500);
  }
  await sh(`pkill -KILL -f "opencode serve.*--port ${PORT}" 2>/dev/null`);
  await Bun.sleep(500);
  await sh(`lsof -ti :${PORT} | xargs -r kill -9 2>/dev/null`);
  await Bun.sleep(500);
}

// ─── Suite Lifecycle ────────────────────────────────────────────────────────

let server: Subprocess;

beforeAll(async () => {
  await nuke();

  const portCheck = spawn({ cmd: ["sh", "-c", `lsof -ti :${PORT}`], stdout: "pipe", stderr: "pipe" });
  const portPids = (await new Response(portCheck.stdout).text()).trim();
  await portCheck.exited;
  if (portPids) throw new Error(`Port ${PORT} still held by PID(s) ${portPids}`);

  await sh(`rm -rf ${SUITE_DIR}`);
  mkdirSync(PROJECT_DIR, { recursive: true });

  const gitInit = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitInit.exited;
  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");

  // Claude CLI permissions — auto-approve MCP tools
  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: [
      "mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)",
      "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)",
    ] },
  }, null, 2));

  // OC project config — edit requires "ask" permission
  await Bun.write(join(PROJECT_DIR, "opencode.json"), JSON.stringify({
    permission: { edit: "ask" },
  }, null, 2));

  const gitAdd = spawn({ cmd: ["git", "add", "."], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitAdd.exited;
  const gitCommit = spawn({
    cmd: ["git", "commit", "-m", "init"],
    cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await gitCommit.exited;

  server = spawn({
    cmd: ["opencode", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"],
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`${BASE}/session/status`); if (r.ok) break; } catch {}
    await Bun.sleep(500);
  }
}, 30_000);

afterAll(async () => {
  await nuke(server?.pid);
  try { await server?.exited; } catch {}
  await sh(`rm -rf ${SUITE_DIR}`);
}, 15_000);

afterEach(async () => {
  while (activeSessions.length > 0) {
    await deleteSession(activeSessions.pop()!);
  }
  if (existsSync(PROJECT_DIR)) {
    await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");
  }
});

function skipIfDead() {
  if (server?.exitCode !== null) {
    throw new Error("opencode serve is no longer running — skipping");
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("e2e-serve-asks: permission ask flow", () => {
  test("edit with ask permission triggers prompt and proceeds on approval", async () => {
    skipIfDead();
    const sid = await createSession();

    // Start SSE listener to auto-approve permission prompts
    const ctrl = new AbortController();
    const approved: string[] = [];
    const approver = (async () => {
      try {
        const resp = await fetch(`${BASE}/event?directory=${encodeURIComponent(PROJECT_DIR)}`, {
          signal: ctrl.signal,
        });
        const reader = resp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "permission.updated") {
                const perm = event.properties;
                approved.push(perm.id);
                await api(`/session/${perm.sessionID}/permissions/${perm.id}`, {
                  method: "POST",
                  body: JSON.stringify({ response: "once" }),
                });
              }
            } catch {}
          }
        }
      } catch {}
    })();

    // Ask Claude to edit the file
    await sendMessage(sid,
      `Use the edit tool on ${join(PROJECT_DIR, "hello.txt")} to replace "hello" with "hi". Do not read first, just edit.`);

    ctrl.abort();
    await approver.catch(() => {});

    // Verify the edit happened
    const content = await Bun.file(join(PROJECT_DIR, "hello.txt")).text();
    expect(content).toContain("hi");
  }, TIMEOUT);

  test("edit with ask permission denied blocks the edit", async () => {
    skipIfDead();
    const sid = await createSession();

    // SSE listener that REJECTS permission prompts
    const ctrl = new AbortController();
    const approver = (async () => {
      try {
        const resp = await fetch(`${BASE}/event?directory=${encodeURIComponent(PROJECT_DIR)}`, {
          signal: ctrl.signal,
        });
        const reader = resp.body?.getReader();
        if (!reader) return;
        const decoder = new TextDecoder();
        let buffer = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "permission.updated") {
                const perm = event.properties;
                await api(`/session/${perm.sessionID}/permissions/${perm.id}`, {
                  method: "POST",
                  body: JSON.stringify({ response: "reject" }),
                });
              }
            } catch {}
          }
        }
      } catch {}
    })();

    await sendMessage(sid,
      `Use the edit tool on ${join(PROJECT_DIR, "hello.txt")} to replace "hello" with "BLOCKED". Do not read first, just edit.`);

    ctrl.abort();
    await approver.catch(() => {});

    // File should NOT be changed
    const content = await Bun.file(join(PROJECT_DIR, "hello.txt")).text();
    expect(content).toContain("hello world");
  }, TIMEOUT);
});
