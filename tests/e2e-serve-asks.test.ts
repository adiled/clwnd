import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync } from "fs";
import { join } from "path";

const PORT = 14568;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-sonnet-4-5" };
const HOME = process.env.HOME ?? "/tmp";
const SUITE_DIR = join(HOME, ".clwnd-e2e-serve-asks");
const PROJECT_DIR = join(SUITE_DIR, "project");
const TIMEOUT = 240_000;
const activeSessions: string[] = [];

const DAEMON_SOCK = (process.env.CLWND_SOCKET ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/clwnd/clwnd.sock`) + ".http";

async function api(path: string, opts?: RequestInit) {
  return (await fetch(`${BASE}${path}`, {
    headers: { "Content-Type": "application/json", ...opts?.headers },
    ...opts,
  })).json();
}

async function createSession(): Promise<string> {
  const r = await api("/session", { method: "POST", body: JSON.stringify({ directory: PROJECT_DIR }) });
  const sid = (r as any).id;
  if (sid) activeSessions.push(sid);
  return sid;
}

async function deleteSession(sid: string): Promise<void> {
  try { await fetch("http://localhost/", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "cleanup", opencodeSessionId: sid }), unix: DAEMON_SOCK } as RequestInit); } catch {}
  try { const p = spawn({ cmd: ["opencode", "session", "delete", sid], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" }); await p.exited; } catch {}
}

async function sh(cmd: string): Promise<void> {
  const p = spawn({ cmd: ["sh", "-c", cmd], stdout: "pipe", stderr: "pipe" });
  await p.exited;
}

async function nuke(pid?: number): Promise<void> {
  if (pid) { await sh(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`); await Bun.sleep(1_000); await sh(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`); await Bun.sleep(500); }
  await sh(`pkill -KILL -f "opencode serve.*--port ${PORT}" 2>/dev/null`); await Bun.sleep(500);
  await sh(`lsof -ti :${PORT} | xargs -r kill -9 2>/dev/null`); await Bun.sleep(500);
}

async function getMcpPort(): Promise<number> {
  const out = await new Response(
    spawn({ cmd: ["journalctl", "--user", "-u", "clwnd", "-n", "10", "--no-pager", "-o", "cat"], stdout: "pipe", stderr: "pipe" }).stdout
  ).text();
  const match = out.match(/mcp=http:\/\/127\.0\.0\.1:(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

let server: Subprocess;

beforeAll(async () => {
  await nuke();
  await sh(`rm -rf ${SUITE_DIR}`);
  mkdirSync(PROJECT_DIR, { recursive: true });

  const gitInit = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitInit.exited;
  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");

  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: { allow: [
      "mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)",
      "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)",
    ] },
  }, null, 2));

  // OC project config — edit requires ask
  await Bun.write(join(PROJECT_DIR, "opencode.json"), JSON.stringify({
    permission: { edit: "ask" },
  }, null, 2));

  const gitAdd = spawn({ cmd: ["git", "add", "."], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitAdd.exited;
  const gitCommit = spawn({
    cmd: ["git", "commit", "-m", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await gitCommit.exited;

  server = spawn({
    cmd: ["opencode", "serve", "--port", String(PORT), "--hostname", "127.0.0.1"],
    cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe", env: { ...process.env },
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
  while (activeSessions.length > 0) await deleteSession(activeSessions.pop()!);
  if (existsSync(PROJECT_DIR)) await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");
});

function skipIfDead() {
  if (server?.exitCode !== null) throw new Error("opencode serve is no longer running");
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("e2e-serve-asks: permission ask via MCP permission_prompt tool", () => {
  test("edit with ask permission: approve via daemon endpoint", async () => {
    skipIfDead();
    const sid = await createSession();
    const mcpPort = await getMcpPort();
    expect(mcpPort).toBeGreaterThan(0);
    const DAEMON_MCP = `http://127.0.0.1:${mcpPort}`;

    // Fire edit request — the permission_prompt MCP tool will hold
    // because OC's agent has edit=ask, so the daemon waits for /permission-respond
    const editPromise = fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text: `Edit ${join(PROJECT_DIR, "hello.txt")} — change "hello" to "hi"` }],
      }),
      signal: AbortSignal.timeout(180_000),
    }).then(r => r.json()).catch(() => null);

    // Poll daemon for pending permission, then approve
    const approver = (async () => {
      for (let i = 0; i < 60; i++) {
        await Bun.sleep(2_000);
        try {
          const pending = await fetch(`${DAEMON_MCP}/permission-pending`).then(r => r.json()) as any[];
          if (pending && pending.length > 0) {
            await fetch(`${DAEMON_MCP}/permission-respond`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: pending[0].id, decision: "allow" }),
            });
            return;
          }
        } catch {}
      }
    })();

    await editPromise;
    await approver;

    // Verify the edit happened
    const content = await Bun.file(join(PROJECT_DIR, "hello.txt")).text();
    expect(content).toContain("hi");
  }, TIMEOUT);
});
