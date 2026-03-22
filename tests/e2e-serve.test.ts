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

const DAEMON_SOCK = (process.env.CLWND_SOCKET ?? `${process.env.XDG_RUNTIME_DIR ?? "/tmp"}/clwnd/clwnd.sock`) + ".http";

async function deleteSession(sid: string): Promise<void> {
  // 1. Tell daemon to kill the claude subprocess and drop session state
  try {
    await fetch("http://localhost/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cleanup", opencodeSessionId: sid }),
      unix: DAEMON_SOCK,
    } as RequestInit);
  } catch {}
  // 2. Delete from opencode's side
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

async function sendMessage(sessionID: string, text: string, agent?: string, timeoutMs = 120_000, model = MODEL): Promise<{ info: any; parts: any[] }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${BASE}/session/${sessionID}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
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

  test("bash commands run in the session directory", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, 'Run this exact command: pwd');
    const text = extractResponseText(resp);
    expect(text).toContain(PROJECT_DIR);
  }, TIMEOUT);
});

describe("e2e-serve: permission ask", () => {
  const PERM_DIR = join(SUITE_DIR, "perm-ask");

  test("edit with ask permission triggers prompt and proceeds on approval", async () => {
    skipIfDead();

    // Set up isolated directory with edit=ask permission
    mkdirSync(PERM_DIR, { recursive: true });
    mkdirSync(join(PERM_DIR, ".claude"), { recursive: true });
    await Bun.write(join(PERM_DIR, "opencode.json"), JSON.stringify({
      permission: { edit: "ask" },
    }, null, 2));
    await Bun.write(join(PERM_DIR, ".claude", "settings.json"), JSON.stringify({
      permissions: { allow: [
        "mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)",
        "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)",
      ] },
    }, null, 2));
    await Bun.write(join(PERM_DIR, "hello.txt"), "hello world\n");

    // Create session in the permission test directory
    const r = await api("/session", {
      method: "POST",
      body: JSON.stringify({ directory: PERM_DIR }),
    });
    const sid = (r as any).id;
    activeSessions.push(sid);

    // Start SSE listener to auto-approve permissions
    const ctrl = new AbortController();
    const approver = (async () => {
      try {
        const resp = await fetch(`${BASE}/event?directory=${encodeURIComponent(PERM_DIR)}`, {
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
                  body: JSON.stringify({ response: "once" }),
                });
              }
            } catch {}
          }
        }
      } catch {}
    })();

    // Send edit request
    const resp = await sendMessage(sid, `Read ${join(PERM_DIR, "hello.txt")} then change "hello" to "hi" in it`);

    ctrl.abort();
    await approver.catch(() => {});

    expect(resp.info?.error).toBeUndefined();
  }, TIMEOUT);
});

describe("e2e-serve: provider migration", () => {
  test("switching from non-clwnd to clwnd model retains session context", async () => {
    skipIfDead();
    const sid = await createSession();

    // Simulate pre-clwnd usage: send message with a free OC model (not clwnd)
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };
    await sendMessage(sid, "My project codename is MOONSHOT. Remember this.", undefined, TIMEOUT, freeModel);

    // User switches to clwnd model — this is the migration moment
    const resp = await sendMessage(sid, "What is my project codename?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("moonshot");
  }, TIMEOUT);
});

describe("e2e-serve: brokered tools", () => {
  test("todowrite completes without error", async () => {
    skipIfDead();
    const sid = await createSession();

    // Brokered: Claude executes TodoWrite via MCP, OpenCode re-executes for UI sync
    const resp = await sendMessage(sid, "Use the TodoWrite tool to create todos: buy groceries, clean house");
    expect(resp.info?.error).toBeUndefined();
  }, TIMEOUT);

  test("webfetch completes without error", async () => {
    skipIfDead();
    const sid = await createSession();

    // Brokered: Claude fetches via MCP, OpenCode re-executes for UI sync
    const resp = await sendMessage(sid, "Fetch https://example.com and tell me what the page contains");
    expect(resp.info?.error).toBeUndefined();
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

});

// ─── Optimistic Feature Tests ───────────────────────────────────────────────
// These test OC features we haven't explicitly implemented support for.
// By the compatibility model (see AGENTS.md), OC features work by default
// unless they cross the provider boundary. If these pass — great, no work
// needed. If they fail — that's how we know we need to handle something.

describe("e2e-serve: compaction", () => {
  test("session compaction preserves conversation context", async () => {
    skipIfDead();
    const sid = await createSession();

    // Establish context
    await sendMessage(sid, "My secret word is FLAMINGO. Acknowledge.");

    // Trigger compaction via command endpoint
    const compactResp = await api(`/session/${sid}/command`, {
      method: "POST",
      body: JSON.stringify({ command: "session.compact", arguments: "" }),
    });
    // Compaction should not error
    expect(compactResp).toBeDefined();

    // Context should survive compaction
    const resp = await sendMessage(sid, "What is my secret word?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("flamingo");
  }, TIMEOUT);
});

describe("e2e-serve: snapshots and revert", () => {
  test("file written via clwnd MCP exists on disk", async () => {
    skipIfDead();
    const sid = await createSession();
    const filePath = join(PROJECT_DIR, "snapshot-test.txt");

    // Claude writes a file through clwnd MCP → fs.writeFileSync
    await sendMessage(sid, `Write exactly the text "SNAPSHOT_CONTENT" to ${filePath}`);

    // File should exist on disk
    expect(existsSync(filePath)).toBe(true);
    const content = await Bun.file(filePath).text();
    expect(content).toContain("SNAPSHOT_CONTENT");
  }, TIMEOUT);

  test("revert restores file to pre-edit state", async () => {
    skipIfDead();
    const sid = await createSession();
    const filePath = join(PROJECT_DIR, "hello.txt");

    // Verify original content
    const before = await Bun.file(filePath).text();
    expect(before).toContain("hello world");

    // Claude edits the file through clwnd MCP
    const editResp = await sendMessage(sid, `Change the contents of ${filePath} to exactly "EDITED BY CLAUDE"`);

    // File should be changed on disk
    const afterEdit = await Bun.file(filePath).text();
    expect(afterEdit).toContain("EDITED BY CLAUDE");

    // Find the assistant message that did the edit
    const msgs = await getMessages(sid);
    const assistantMsg = (Array.isArray(msgs) ? msgs : []).find((m: any) => m.role === "assistant");

    if (!assistantMsg) {
      // If messages API doesn't return messages, use the response info
      const msgId = editResp.info?.id;
      expect(msgId).toBeTruthy();

      // Revert using the message ID from the response
      await api(`/session/${sid}/revert`, {
        method: "POST",
        body: JSON.stringify({ messageID: msgId }),
      });
    } else {
      await api(`/session/${sid}/revert`, {
        method: "POST",
        body: JSON.stringify({ messageID: assistantMsg.id }),
      });
    }

    // Wait for revert to take effect (OC restores from snapshot)
    await Bun.sleep(2_000);

    // File should be restored to original content
    const afterRevert = await Bun.file(filePath).text();
    expect(afterRevert).toContain("hello world");
  }, TIMEOUT);
});

describe("e2e-serve: session forking", () => {
  test("forked session creates independent conversation branch", async () => {
    skipIfDead();
    const sid = await createSession();

    // Establish context in parent
    await sendMessage(sid, "My favorite animal is a penguin. Acknowledge.");

    // Fork the session
    const forkResp = await api(`/session/${sid}/fork`, { method: "POST", body: JSON.stringify({}) }) as any;
    const forkedSid = forkResp.id;

    if (forkedSid) {
      activeSessions.push(forkedSid);
      // Forked session should be independent
      expect(forkedSid).not.toBe(sid);
      // Send a message in forked session — should retain parent context
      const resp = await sendMessage(forkedSid, "What is my favorite animal?");
      const text = extractResponseText(resp).toLowerCase();
      expect(text).toContain("penguin");
    } else {
      // Fork not supported or errored — that's a finding
      expect(forkResp).toHaveProperty("id");
    }
  }, TIMEOUT);
});

describe("e2e-serve: cost tracking", () => {
  test("message response includes token counts", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Say hello");
    // Tokens should be reported even if cost is $0
    expect(resp.info?.tokens).toBeDefined();
    expect(resp.info.tokens.input + resp.info.tokens.output).toBeGreaterThan(0);
  }, TIMEOUT);
});

describe("e2e-serve: title generation", () => {
  test("session title is generated after first message", async () => {
    skipIfDead();
    const sid = await createSession();

    const before = await getSession(sid);
    expect(before.title).toContain("New session");

    await sendMessage(sid, "Tell me about the Eiffel Tower");

    // Title gen is async — wait for it
    let title = before.title;
    for (let i = 0; i < 10; i++) {
      await Bun.sleep(2_000);
      const after = await getSession(sid);
      if (after.title !== before.title) { title = after.title; break; }
    }
    expect(title).not.toContain("New session");
  }, TIMEOUT);
});
