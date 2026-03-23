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
    headers: { "Content-Type": "application/json", ...opts?.headers }, ...opts,
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
  const p = spawn({ cmd: ["sh", "-c", cmd], stdout: "pipe", stderr: "pipe" }); await p.exited;
}

async function nuke(pid?: number): Promise<void> {
  if (pid) { await sh(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null`); await Bun.sleep(1_000); await sh(`pkill -KILL -P ${pid} 2>/dev/null; kill -KILL ${pid} 2>/dev/null`); await Bun.sleep(500); }
  await sh(`pkill -KILL -f "opencode serve.*--port ${PORT}" 2>/dev/null`); await Bun.sleep(500);
  await sh(`lsof -ti :${PORT} | xargs -r kill -9 2>/dev/null`); await Bun.sleep(500);
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

describe("e2e-serve-asks: permission dialog via phantom tool call", () => {
  test("edit with ask permission creates OC permission prompt and proceeds on approval", async () => {
    skipIfDead();
    const sid = await createSession();

    // Fire edit — triggers permission_prompt MCP → daemon holds →
    // phantom clwnd_permission tool call → OC ctx.ask() → pending permission
    const editPromise = fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text: `Edit ${join(PROJECT_DIR, "hello.txt")} — change "hello" to "hi"` }],
      }),
      signal: AbortSignal.timeout(180_000),
    }).then(r => r.json()).catch(() => null);

    // Keep approving ALL permission prompts until editPromise resolves.
    // Claude's turn may trigger multiple ask permissions (edit, read, etc.)
    let approvedCount = 0;
    const approver = (async () => {
      while (true) {
        await Bun.sleep(1_000);
        try {
          const pending = await fetch(`${BASE}/permission`).then(r => r.json()) as any[];
          if (pending && pending.length > 0) {
            for (const perm of pending) {
              await fetch(`${BASE}/permission/${perm.id}/reply`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ reply: "once" }),
              });
              approvedCount++;
            }
          }
        } catch { break; }
      }
    })();

    const resp = await editPromise;
    // Stop the approver
    approver.catch(() => {});

    // At least one permission dialog was created and approved
    expect(approvedCount).toBeGreaterThan(0);

    // Claude responded with a message (not hung, not empty)
    const text = (resp?.parts ?? [])
      .filter((p: any) => p.type === "text")
      .map((p: any) => p.text ?? "")
      .join("");
    expect(text.length).toBeGreaterThan(0);

    // OC session has tool activity in its message history
    const msgs = await api(`/session/${sid}/message`);
    const allParts = (msgs as any[]).flatMap((m: any) => m.parts ?? []);
    // Should have tool parts (clwnd_permission and/or edit)
    const toolParts = allParts.filter((p: any) => p.type === "tool");
    expect(toolParts.length).toBeGreaterThan(0);

    // No pending permissions left — session is clean
    const pendingAfter = await fetch(`${BASE}/permission`).then(r => r.json()) as any[];
    expect(pendingAfter.length).toBe(0);

    // Session exists and is accessible (not stuck)
    const session = await api(`/session/${sid}`) as any;
    expect(session.id).toBe(sid);

    // File should be edited
    const content = await Bun.file(join(PROJECT_DIR, "hello.txt")).text();
    expect(content).toContain("hi");
  }, TIMEOUT);
});
