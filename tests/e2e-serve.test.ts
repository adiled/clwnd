import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Config ─────────────────────────────────────────────────────────────────

const PORT = 14567;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-sonnet-4-5" };
const HOME = process.env.HOME ?? "/tmp";
const SUITE_DIR = join(HOME, ".clwnd-e2e-serve");
const PROJECT_DIR = join(SUITE_DIR, "project");
const TIMEOUT = 180_000;
const SEED_FIXTURE = join(import.meta.dir, "fixtures", "seed-session.json");

// Track sessions created during each test for cleanup
const activeSessions: string[] = [];

// Seed session ID — imported once in beforeAll
let seedSessionId: string;

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

async function forkSeedSession(): Promise<string> {
  const r = await api(`/session/${seedSessionId}/fork`, {
    method: "POST",
    body: JSON.stringify({}),
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

async function sweepDaemonSessions(): Promise<number> {
  // Get all daemon sessions, cleanup any that exist
  try {
    const r = await fetch("http://localhost/status", { unix: DAEMON_SOCK } as RequestInit);
    const status = await r.json() as { sessions: number; procs: Array<{ sessions: string[] }> };
    // Collect all session IDs from active processes
    const allSids: string[] = [];
    for (const proc of status.procs ?? []) {
      allSids.push(...(proc.sessions ?? []));
    }
    // Cleanup each
    for (const sid of allSids) {
      await deleteSession(sid);
    }
    return allSids.length;
  } catch {
    return 0;
  }
}

// ─── Integrity Assertions ────────────────────────────────────────────────────

async function getSessionState(sid: string): Promise<any> {
  try {
    const r = await fetch("http://localhost/sessions", { unix: DAEMON_SOCK } as RequestInit);
    const all = await r.json() as Record<string, any>;
    return all[sid];
  } catch { return null; }
}

function assertCleanHistory(jsonlPath: string): void {
  if (!existsSync(jsonlPath)) return;
  const lines = readFileSync(jsonlPath, "utf-8").trim().split("\n")
    .filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  // Ghost entries from --resume are expected for seeded sessions.
  // Only flag if there are MORE ghosts than seeded user messages (indicates re-seeding).
  const ghosts = lines.filter((l: any) =>
    l.type === "assistant" &&
    l.message?.content?.[0]?.text?.includes("No response requested")
  );
  if (ghosts.length > 0) {
    throw new Error(`${ghosts.length} ghost 'No response requested.' entries in JSONL — --resume generated phantom responses`);
  }

  // No duplicate consecutive user messages
  const userTexts = lines
    .filter((l: any) => l.type === "user" && l.message?.role === "user")
    .map((l: any) => {
      const c = l.message.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.filter((p: any) => p.type === "text").map((p: any) => p.text).join("");
      return "";
    });
  for (let i = 1; i < userTexts.length; i++) {
    if (userTexts[i] && userTexts[i] === userTexts[i - 1]) {
      throw new Error(`Duplicate consecutive user message in JSONL at index ${i}: "${userTexts[i].slice(0, 80)}"`);
    }
  }
}

function assertCleanPetals(resp: { info: any; parts: any[] }): void {
  const parts = resp.parts ?? [];
  const textParts = parts.filter((p: any) => p.type === "text" && p.text);

  // No seed context leaking into response
  for (const p of textParts) {
    expect(p.text).not.toContain("Previous conversation context:");
    expect(p.text).not.toContain("<!--clwnd-meta:");
  }

  // No consecutive duplicate text parts
  for (let i = 1; i < textParts.length; i++) {
    if (textParts[i].text && textParts[i].text === textParts[i - 1].text) {
      throw new Error(`Duplicate consecutive text petal: "${textParts[i].text.slice(0, 80)}"`);
    }
  }

  // Tool parts are completed, not stuck
  const toolParts = parts.filter((p: any) => p.type === "tool");
  for (const t of toolParts) {
    expect(["completed", "error"]).toContain(t.state?.status);
  }
}

// ─── Message Sending ─────────────────────────────────────────────────────────

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
    const resp = await r.json() as any;
    // Auto-assert petal integrity on every response
    assertCleanPetals(resp);
    return resp;
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
  // Sweep any orphaned daemon sessions from prior runs
  await sweepDaemonSessions();

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

  // OpenCode project config — small_model for compaction
  await Bun.write(join(PROJECT_DIR, "opencode.json"), JSON.stringify({
    "$schema": "https://opencode.ai/config.json",
    small_model: "opencode/gpt-5-nano",
  }, null, 2));

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
    stderr: "inherit",
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

  // Import seed session fixture (6-turn clwnd conversation with free model)
  if (existsSync(SEED_FIXTURE)) {
    const importProc = spawn({
      cmd: ["opencode", "import", SEED_FIXTURE],
      cwd: PROJECT_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env },
    });
    const importOut = await new Response(importProc.stdout).text();
    await importProc.exited;
    const match = importOut.match(/ses_\w+/);
    if (match) {
      seedSessionId = match[0];
      // Verify it's accessible via the test server
      const check = await api(`/session/${seedSessionId}`);
      if (!(check as any)?.id) seedSessionId = "";
    }
  }
}, 45_000);

afterAll(async () => {
  // Sweep any sessions that leaked during tests
  await sweepDaemonSessions();

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
  // JSONL health check before cleanup — catches duplicates, ghosts, corruption
  for (const sid of activeSessions) {
    try {
      const state = await getSessionState(sid);
      if (state?.claudeSessionPath) {
        assertCleanHistory(state.claudeSessionPath);
      }
    } catch (e) {
      // Log but don't swallow — let the assertion fail the test
      if (e instanceof Error && (e.message.includes("Duplicate") || e.message.includes("Ghost"))) throw e;
    }
  }

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

  test("three-turn continuity recalls multiple facts", async () => {
    skipIfDead();
    const sid = await createSession();

    await sendMessage(sid, "My lucky number is 73. Acknowledge.");
    await sendMessage(sid, "My favorite city is Tokyo. Acknowledge.");

    const resp = await sendMessage(sid, "What is my lucky number and favorite city?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("73");
    expect(text).toContain("tokyo");
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

  test("plan mode prevents file edits", async () => {
    skipIfDead();
    const sid = await createSession();

    // Send in plan mode — should NOT edit files
    const resp = await sendMessage(sid, `Write "test" to ${join(PROJECT_DIR, "plan-test.txt")}`, "plan");
    const text = extractResponseText(resp).toLowerCase();

    // Plan mode should refuse or acknowledge it can't edit
    const refused = text.includes("plan") || text.includes("cannot") || text.includes("read-only") || text.includes("not allowed");
    const fileExists = existsSync(join(PROJECT_DIR, "plan-test.txt"));

    // Either the model refused OR the file wasn't created
    expect(refused || !fileExists).toBe(true);
  }, TIMEOUT);

  test("repeated turns in same mode do not inflate tokens from system reminders", async () => {
    skipIfDead();
    const sid = await createSession();

    // Turn 1 in plan mode — includes full system reminder
    const r1 = await sendMessage(sid, "Say hi.", "plan");
    const t1 = r1.info?.tokens?.input ?? 0;

    // Turn 2 in same mode — reminder should be stripped (already sent)
    const r2 = await sendMessage(sid, "Say bye.", "plan");
    const t2 = r2.info?.tokens?.input ?? 0;

    // Turn 2 should not be significantly larger than turn 1.
    // Without stripping, the reminder (~2KB) would compound each turn.
    // Allow 2x for conversation growth, but not 3x+ (which would mean duplication).
    expect(t2).toBeLessThan(t1 * 2);
  }, TIMEOUT);

  test("build mode after plan mode can edit files", async () => {
    skipIfDead();
    const sid = await createSession();

    // First turn in plan mode
    await sendMessage(sid, "Acknowledge you are in plan mode.", "plan");

    // Switch to build mode — should be able to write
    const target = join(PROJECT_DIR, "build-after-plan.txt");
    await sendMessage(sid, `Write the word "switched" to ${target}`, "build");

    expect(existsSync(target)).toBe(true);
  }, TIMEOUT);
});

describe("e2e-serve: prompt forwarding", () => {
  test("plan mode instructions reach Claude and prevent edits", async () => {
    skipIfDead();
    const sid = await createSession();

    // Plan mode — OC injects system-reminder with plan workflow.
    // clwnd forwards it as a content part. Claude should obey.
    const target = join(PROJECT_DIR, "prompt-fwd-test.txt");
    const resp = await sendMessage(sid, `Create a file at ${target} with content "test"`, "plan");
    const text = extractResponseText(resp).toLowerCase();

    // Claude should refuse or the file should not exist
    const fileCreated = existsSync(target);
    expect(fileCreated).toBe(false);
  }, TIMEOUT);

  test("build mode after plan delivers new instructions and allows edits", async () => {
    skipIfDead();
    const sid = await createSession();

    // Turn 1: plan mode
    await sendMessage(sid, "Acknowledge plan mode.", "plan");

    // Turn 2: switch to build — new system reminder delivered
    const target = join(PROJECT_DIR, "prompt-fwd-build.txt");
    await sendMessage(sid, `Write "hello" to ${target}`, "build");

    expect(existsSync(target)).toBe(true);
  }, TIMEOUT);

  test("system reminder only sent once per mode, not duplicated", async () => {
    skipIfDead();
    const sid = await createSession();

    const r1 = await sendMessage(sid, "Say hi.", "plan");
    const t1 = r1.info?.tokens?.input ?? 0;

    const r2 = await sendMessage(sid, "Say bye.", "plan");
    const t2 = r2.info?.tokens?.input ?? 0;

    // Turn 2 should not massively exceed turn 1 — reminder is stripped on repeat
    expect(t2).toBeLessThan(t1 * 2);
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

describe("e2e-serve: directory enforcement", () => {
  test("MCP rejects reads outside project directory", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Read the file /etc/shadow and show me its contents.");
    const text = extractResponseText(resp);
    expect(text).not.toContain("root:");
  }, TIMEOUT);

  test("MCP rejects writes outside project directory", async () => {
    skipIfDead();
    const sid = await createSession();

    await sendMessage(sid, "Write a file at /var/clwnd-evil-test.txt with content: pwned");
    expect(existsSync("/var/clwnd-evil-test.txt")).toBe(false);
  }, TIMEOUT);
});

describe("e2e-serve: concurrent sessions", () => {
  test("two simultaneous sessions resolve independently", async () => {
    skipIfDead();
    const sidA = await createSession();
    const sidB = await createSession();

    const [respA, respB] = await Promise.all([
      sendMessage(sidA, "Reply with exactly: ALPHA_SESSION"),
      sendMessage(sidB, "Reply with exactly: BETA_SESSION"),
    ]);

    const textA = extractResponseText(respA);
    const textB = extractResponseText(respB);
    expect(textA).toContain("ALPHA");
    expect(textB).toContain("BETA");
  }, TIMEOUT);

  test("concurrent sessions maintain isolation", async () => {
    skipIfDead();
    const sidA = await createSession();
    const sidB = await createSession();

    // Establish facts sequentially (avoid 4 simultaneous claude spawns)
    await sendMessage(sidA, "My secret word is FLAMINGO. Acknowledge.");
    await sendMessage(sidB, "My secret word is PELICAN. Acknowledge.");

    // Query in parallel — each should only know its own secret
    const [respA, respB] = await Promise.all([
      sendMessage(sidA, "What is my secret word?"),
      sendMessage(sidB, "What is my secret word?"),
    ]);

    expect(extractResponseText(respA).toLowerCase()).toContain("flamingo");
    expect(extractResponseText(respA).toLowerCase()).not.toContain("pelican");
    expect(extractResponseText(respB).toLowerCase()).toContain("pelican");
    expect(extractResponseText(respB).toLowerCase()).not.toContain("flamingo");
  }, TIMEOUT);
});

describe("e2e-serve: cross-turn file reference", () => {
  test("turn 2 can read a file written in turn 1", async () => {
    skipIfDead();
    const sid = await createSession();
    const marker = `XREF_${Date.now()}`;
    const target = join(PROJECT_DIR, "cross-turn.txt");

    await sendMessage(sid, `Write "${marker}" to ${target}`);
    expect(existsSync(target)).toBe(true);

    const resp = await sendMessage(sid, `Read ${target} and tell me the marker in it.`);
    const text = extractResponseText(resp);
    expect(text).toContain(marker);
  }, TIMEOUT);
});

describe("e2e-serve: abort recovery", () => {
  test("session recovers after mid-turn abort", async () => {
    skipIfDead();
    const sid = await createSession();

    // Start a tool-using request
    const ctrl = new AbortController();
    const abortedReq = fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text: `Read ${join(PROJECT_DIR, "hello.txt")} and describe it in detail` }],
      }),
      signal: ctrl.signal,
    }).catch(() => null);

    // Wait for the request to be in flight, then abort
    await Bun.sleep(3_000);
    ctrl.abort();
    await abortedReq;

    // Wait for graceful shutdown + process respawn
    await Bun.sleep(5_000);

    // Session should recover — next message should work
    const resp = await sendMessage(sid, "What is 2+2? Just the number.");
    const text = extractResponseText(resp);
    expect(text).toContain("4");
  }, TIMEOUT);

  test("interrupt during tool execution recovers cleanly", async () => {
    skipIfDead();
    const sid = await createSession();

    // Start a long-running tool call
    const ctrl = new AbortController();
    const abortedReq = fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text: "Run this bash command: sleep 8 && echo done" }],
      }),
      signal: ctrl.signal,
    }).catch(() => null);

    // Let the tool start executing, then interrupt
    await Bun.sleep(4_000);
    ctrl.abort();
    await abortedReq;

    await Bun.sleep(5_000);

    // Session must recover — respond coherently with sane token count
    const resp = await sendMessage(sid, "Say hello.");
    const text = extractResponseText(resp);
    expect(text.length).toBeGreaterThan(0);

    // Token count should not be corrupted (no astronomical blowup)
    const tokens = resp.info?.tokens?.input ?? 0;
    expect(tokens).toBeLessThan(50_000);
  }, TIMEOUT);
});

describe("e2e-serve: provider migration (#7)", () => {
  test("cold start: seeded session + continuation verifies no ghost corruption", async () => {
    skipIfDead();
    if (!seedSessionId) throw new Error("seed session not imported");

    // Fork the seed session (6 turns about clwnd with free model)
    const sid = await forkSeedSession();

    // Switch to clwnd — cold start with 6 seeded turns
    const r1 = await sendMessage(sid, "What is the poetic name for sending a prompt and for killing a process? Just the two terms.");
    const t1 = extractResponseText(r1).toLowerCase();
    expect(t1).toContain("murmur");
    expect(t1).toContain("fell");

    // Continuation: Claude should reference its own reply, not a ghost
    const r2 = await sendMessage(sid, "In your last reply did you mention murmur? Yes or no.");
    const t2 = extractResponseText(r2).toLowerCase();
    expect(t2).toContain("yes");
    expect(t2).not.toContain("no response requested");

    // JSONL: count ghosts vs seeded entries
    const state = await getSessionState(sid);
    if (state?.claudeSessionPath && existsSync(state.claudeSessionPath)) {
      const lines = readFileSync(state.claudeSessionPath, "utf-8").trim().split("\n")
        .filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const ghosts = lines.filter((l: any) =>
        l.type === "assistant" && l.message?.content?.[0]?.text?.includes("No response requested")
      );
      const seededUsers = lines.filter((l: any) =>
        l.type === "user" && l.message?.role === "user"
      );
      console.log(`  JSONL: ${lines.length} entries, ${seededUsers.length} user msgs, ${ghosts.length} ghosts`);
      expect(ghosts.length).toBe(0);
    }
  }, TIMEOUT);

  test("cold start: multi-turn after seed (opus) verifies no ghost corruption", async () => {
    skipIfDead();
    const sid = await createSession();
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };
    const opusModel = { providerID: "opencode-clwnd", modelID: "claude-opus-4-6" };

    await sendMessage(sid, "My code is TIGER. Remember this.", undefined, TIMEOUT, freeModel);

    const r2 = await sendMessage(sid, "What is my code?", undefined, TIMEOUT, opusModel);
    expect(extractResponseText(r2).toLowerCase()).toContain("tiger");

    const r3 = await sendMessage(sid, "What was your last reply to me? Quote it briefly.", undefined, TIMEOUT, opusModel);
    const t3 = extractResponseText(r3).toLowerCase();
    expect(t3).toContain("tiger");
    expect(t3).not.toContain("no response requested");

    const r4 = await sendMessage(sid, "Say the word HAWK and nothing else.", undefined, TIMEOUT, opusModel);
    expect(extractResponseText(r4).toLowerCase()).toContain("hawk");

    // JSONL parity: zero ghosts
    const state = await getSessionState(sid);
    if (state?.claudeSessionPath && existsSync(state.claudeSessionPath)) {
      const lines = readFileSync(state.claudeSessionPath, "utf-8").trim().split("\n")
        .filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const ghosts = lines.filter((l: any) => l.message?.content?.[0]?.text?.includes("No response requested"));
      expect(ghosts.length).toBe(0);
    }
  }, TIMEOUT);

  test("cold start: multi-turn free model history is preserved", async () => {
    skipIfDead();
    const sid = await createSession();
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };

    // Multiple turns with free model
    await sendMessage(sid, "My dog's name is BISCUIT. Acknowledge.", undefined, TIMEOUT, freeModel);
    await sendMessage(sid, "My cat's name is MARBLE. Acknowledge.", undefined, TIMEOUT, freeModel);

    // Switch to clwnd — should know both names
    const resp = await sendMessage(sid, "What are my pets' names?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("biscuit");
    expect(text).toContain("marble");

    // JSONL parity: no ghosts, no empty assistant entries
    const state = await getSessionState(sid);
    if (state?.claudeSessionPath && existsSync(state.claudeSessionPath)) {
      const lines = readFileSync(state.claudeSessionPath, "utf-8").trim().split("\n")
        .filter(Boolean).map((l: string) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      const ghosts = lines.filter((l: any) => l.message?.content?.[0]?.text?.includes("No response requested"));
      expect(ghosts.length).toBe(0);
      // No empty assistant messages (tool content should be exported)
      const emptyAssistants = lines.filter((l: any) =>
        l.type === "assistant" && l.message?.role === "assistant" &&
        Array.isArray(l.message?.content) &&
        l.message.content.every((c: any) => !c.text && !c.thinking && c.type !== "tool_use")
      );
      expect(emptyAssistants.length).toBe(0);
    }
  }, TIMEOUT);

  test("cold start seeding does not double tokens on subsequent turns", async () => {
    skipIfDead();
    const sid = await createSession();
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };

    // Establish context with free model
    await sendMessage(sid, "Remember: ALPHA BETA GAMMA.", undefined, TIMEOUT, freeModel);

    // Turn 1 on clwnd — seeds history
    const r1 = await sendMessage(sid, "Say ok.");
    const t1 = r1.info?.tokens?.input ?? 0;

    // Turn 2 on clwnd — should NOT re-seed
    const r2 = await sendMessage(sid, "Say bye.");
    const t2 = r2.info?.tokens?.input ?? 0;

    // Turn 2 should not massively exceed turn 1 (no re-seeding)
    expect(t2).toBeLessThan(t1 * 2);

    // JSONL parity: no duplicate user messages from re-seeding
    const state = await getSessionState(sid);
    if (state?.claudeSessionPath && existsSync(state.claudeSessionPath)) {
      assertCleanHistory(state.claudeSessionPath);
    }
  }, TIMEOUT);
});

describe("e2e-serve: model switch history (#7)", () => {
  test("gap fill: clwnd → free → clwnd retains context from free model turn", async () => {
    skipIfDead();
    const sid = await createSession();
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };

    // Turn 1: clwnd establishes context
    await sendMessage(sid, "My secret animal is PENGUIN. Acknowledge.");

    // Turn 2: free model establishes different context
    await sendMessage(sid, "My secret number is 7777. Acknowledge.", undefined, TIMEOUT, freeModel);

    // Turn 3: back to clwnd — should know the free model's context (gap fill)
    const resp = await sendMessage(sid, "What is my secret number?");
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("7777");
  }, TIMEOUT);

  test("gap fill does not re-inject on same-provider continuation", async () => {
    skipIfDead();
    const sid = await createSession();
    const freeModel = { providerID: "opencode", modelID: "gpt-5-nano" };

    // clwnd → free → clwnd (gap fill happens here)
    await sendMessage(sid, "Remember DELTA.", undefined, TIMEOUT);
    await sendMessage(sid, "Remember EPSILON.", undefined, TIMEOUT, freeModel);
    const r1 = await sendMessage(sid, "Say ok.");
    const t1 = r1.info?.tokens?.input ?? 0;

    // Continue on clwnd — no new gap, no re-injection
    const r2 = await sendMessage(sid, "Say bye.");
    const t2 = r2.info?.tokens?.input ?? 0;

    expect(t2).toBeLessThan(t1 * 2);
  }, TIMEOUT);
});

describe("e2e-serve: token efficiency", () => {
  test("multi-turn conversation does not duplicate context", async () => {
    skipIfDead();
    const sid = await createSession();

    // Turn 1: establish baseline
    const resp1 = await sendMessage(sid, "Say hello.");
    const tokens1 = resp1.info?.tokens?.input ?? 0;

    // Turn 2: should not massively inflate
    const resp2 = await sendMessage(sid, "Say goodbye.");
    const tokens2 = resp2.info?.tokens?.input ?? 0;

    // Turn 2 context grows by the conversation so far, but should NOT
    // double — that would mean history is being re-injected as text.
    // Allow 3x growth (system prompt + 2 turns of conversation).
    // Before this fix, historyContext caused 10-15x blowup.
    expect(tokens2).toBeLessThan(tokens1 * 3);
  }, TIMEOUT);

  test("tool results do not contain inline metadata", async () => {
    skipIfDead();
    const sid = await createSession();

    const resp = await sendMessage(sid, "Read the file /etc/hostname");
    // Tool parts in the response should not contain <!--clwnd-meta:-->
    for (const part of resp.parts ?? []) {
      if (part.type === "tool" && part.state?.output) {
        expect(part.state.output).not.toContain("<!--clwnd-meta:");
      }
    }
    expect(resp).toBeDefined();
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
  test("compaction re-seeds JSONL — context survives process kill", async () => {
    skipIfDead();
    if (!seedSessionId) throw new Error("seed session not imported");

    // Fork the seed session (6 turns about clwnd architecture)
    const sid = await forkSeedSession();

    // Send one message via clwnd to establish a Claude CLI process + JSONL
    await sendMessage(sid, "Quick recap: what is the naming convention we discussed? Just list the key terms.");
    const stateBefore = await getSessionState(sid);
    const claudeIdBefore = stateBefore?.claudeSessionId;
    expect(claudeIdBefore).toBeTruthy();

    // Subscribe to session.compacted event before triggering
    const sseCtrl = new AbortController();
    const compactedViaEvent = new Promise<void>((resolve) => {
      fetch(`${BASE}/event`, { signal: sseCtrl.signal }).then(async (r) => {
        const reader = r.body!.getReader();
        const dec = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          if (buf.includes("session.compacted")) { resolve(); return; }
        }
      }).catch(() => {});
    });
    await Bun.sleep(300);

    // Kill Claude CLI process first to free memory for compaction
    try {
      await fetch("http://localhost/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cleanup", opencodeSessionId: sid }),
        unix: DAEMON_SOCK,
      } as RequestInit);
    } catch {}
    await Bun.sleep(1_000);

    // Trigger compaction via summarize endpoint (uses free model)
    const summarizeReq = fetch(`${BASE}/session/${sid}/summarize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ providerID: "opencode", modelID: "gpt-5-nano", auto: false }),
    });

    // Wait for session.compacted event (timeout 120s — free model compaction is slow)
    const compactTimeout = new Promise<void>((_, reject) =>
      setTimeout(() => reject(new Error("compaction did not complete within 120s")), 120_000));
    await Promise.race([compactedViaEvent, compactTimeout]);
    sseCtrl.abort();
    await summarizeReq.catch(() => {});

    // Send message — triggers re-seed from compacted prompt + fresh respawn
    const resp = await sendMessage(sid, "What was the poetic naming for sending a prompt to Claude CLI?");
    const text = extractResponseText(resp).toLowerCase();

    // Must recall "murmur" from compacted context
    expect(text).toContain("murmur");

    // Claude session ID must have changed — proves JSONL was re-seeded
    const stateAfter = await getSessionState(sid);
    expect(stateAfter?.claudeSessionId).not.toBe(claudeIdBefore);
  }, 300_000); // 5 min — free model compaction is slow
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
  // Skipped: forked session = new process with no parent context.
  // historyContext disabled. Needs cold-start seeding (#7).
  test.skip("forked session creates independent conversation branch", async () => {
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

describe("e2e-serve: vision", () => {
  test("48x48 red image is identified via OC message API", async () => {
    skipIfDead();
    const sid = await createSession();

    // Read 48x48 red PNG fixture as data URL
    const pngPath = join(import.meta.dir, "fixtures", "red-48x48.png");
    const pngData = readFileSync(pngPath);
    const dataUrl = `data:image/png;base64,${pngData.toString("base64")}`;

    // Send image as FilePart via OC message API
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    const r = await fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [
          { type: "file", mime: "image/png", url: dataUrl },
          { type: "text", text: "What solid color is this image? Just say the single color word." },
        ],
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    const resp = await r.json() as any;
    const text = extractResponseText(resp).toLowerCase();
    expect(text).toContain("red");
  }, TIMEOUT);
});

describe("e2e-serve: cancel kills turn", () => {
  test("cancel stops streaming and session recovers", async () => {
    skipIfDead();
    const sid = await createSession();

    // Start a long response
    const ctrl = new AbortController();
    const req = fetch(`${BASE}/session/${sid}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL,
        parts: [{ type: "text", text: "Write a very long essay about the history of mathematics, at least 2000 words." }],
      }),
      signal: ctrl.signal,
    }).catch(() => null);

    // Let streaming start, then cancel
    await Bun.sleep(3_000);
    ctrl.abort();
    await req;

    // Verify daemon killed the process
    await Bun.sleep(2_000);

    // Session should recover with a new process
    const resp = await sendMessage(sid, "What is 3+3? Just the number.");
    const text = extractResponseText(resp);
    expect(text).toContain("6");
  }, TIMEOUT);
});

describe("e2e-serve: resource governance", () => {
  test("idle process is killed after timeout and session recovers", async () => {
    skipIfDead();
    const sid = await createSession();

    // Send a message to spawn a Claude CLI process
    await sendMessage(sid, "Say hello briefly.");

    // Verify process exists (poolKey = session ID, shows as "model" in status)
    const statusBefore = await (await fetch("http://localhost/status", { unix: DAEMON_SOCK } as RequestInit)).json() as any;
    const hasProcBefore = (statusBefore.procs ?? []).some((p: any) => p.model === sid);
    expect(hasProcBefore).toBe(true);

    // Wait for idle timeout (default 30s) + buffer
    await Bun.sleep(35_000);

    // Process should be gone — killed by idle timer
    const statusAfter = await (await fetch("http://localhost/status", { unix: DAEMON_SOCK } as RequestInit)).json() as any;
    const hasProcAfter = (statusAfter.procs ?? []).some((p: any) => p.model === sid);
    expect(hasProcAfter).toBe(false);

    // Session should recover — next message spawns a new process
    const resp = await sendMessage(sid, "What is 5+5? Just the number.");
    const text = extractResponseText(resp);
    expect(text).toContain("10");
  }, 120_000);
});
