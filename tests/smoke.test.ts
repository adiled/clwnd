import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, unlinkSync, readdirSync, rmSync, mkdirSync, readFileSync } from "fs";
import { join } from "path";

// ─── Test config ────────────────────────────────────────────────────────────

const TEST_SOCK = "/tmp/clwnd-smoke-test.sock";
const HTTP_SOCK = TEST_SOCK + ".http";
const DAEMON_ENTRY = `${import.meta.dir}/../dist/daemon/index.js`;
const MODEL = "claude-haiku-4-5";
const PROJECT_DIR = "/tmp/clwnd-smoke-project";
const CLAUDE_HOME = `${process.env.HOME}/.claude`;
const TIMEOUT = 120_000;
const IS_ROOT = process.getuid?.() === 0;

// ─── Helpers ────────────────────────────────────────────────────────────────

interface NdjsonMsg {
  action: string;
  [key: string]: unknown;
}

async function streamRequest(body: Record<string, unknown>): Promise<NdjsonMsg[]> {
  const resp = await fetch("http://localhost/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    unix: HTTP_SOCK,
  } as RequestInit);

  if (!resp.ok) throw new Error(`/stream ${resp.status}: ${await resp.text()}`);
  if (!resp.body) throw new Error("/stream no body");

  const messages: NdjsonMsg[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value!, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { messages.push(JSON.parse(line)); } catch {}
    }
  }

  return messages;
}

function collectText(messages: NdjsonMsg[]): string {
  let text = "";
  for (const m of messages) {
    if (m.action === "chunk" && m.chunkType === "text_delta" && typeof m.delta === "string") {
      text += m.delta;
    }
  }
  return text;
}

function hasToolChunks(messages: NdjsonMsg[]): boolean {
  return messages.some(
    m => m.action === "chunk" && typeof m.chunkType === "string" && m.chunkType.startsWith("tool_"),
  );
}

function findFinish(messages: NdjsonMsg[]): NdjsonMsg | undefined {
  return messages.find(m => m.action === "finish");
}

function findSessionReady(messages: NdjsonMsg[]): NdjsonMsg | undefined {
  return messages.find(m => m.action === "session_ready");
}

function trackSession(messages: NdjsonMsg[]) {
  const ready = findSessionReady(messages);
  if (ready?.claudeSessionId) createdClaudeSessionIds.push(ready.claudeSessionId as string);
  return ready;
}

const createdClaudeSessionIds: string[] = [];

// ─── Lifecycle ──────────────────────────────────────────────────────────────

let daemon: Subprocess;

beforeAll(async () => {
  // Create a git-inited project directory
  if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true });
  mkdirSync(PROJECT_DIR, { recursive: true });

  const gitInit = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitInit.exited;

  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");
  await Bun.write(join(PROJECT_DIR, "config.json"), JSON.stringify({ version: 1, name: "smoke-test" }, null, 2) + "\n");

  // Grant Claude CLI permissions for MCP tools
  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: {
      allow: [
        "mcp__clwnd__read(*)", "mcp__clwnd__edit(*)", "mcp__clwnd__write(*)",
        "mcp__clwnd__bash(*)", "mcp__clwnd__glob(*)", "mcp__clwnd__grep(*)",
      ],
    },
  }, null, 2) + "\n");

  const gitAdd = spawn({ cmd: ["git", "add", "."], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await gitAdd.exited;
  const gitCommit = spawn({
    cmd: ["git", "commit", "-m", "initial"],
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
  });
  await gitCommit.exited;

  // Clean stale sockets
  for (const p of [TEST_SOCK, HTTP_SOCK]) {
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }

  // Start daemon pointed at the project dir
  daemon = spawn({
    cmd: ["bun", DAEMON_ENTRY],
    env: {
      ...process.env,
      CLWND_SOCKET: TEST_SOCK,
      CLWND_CWD: PROJECT_DIR,
      CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH ?? "claude",
      // Non-root can use bypassPermissions; root falls back to acceptEdits
      CLWND_PERMISSION_MODE: IS_ROOT ? "acceptEdits" : "bypassPermissions",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = daemon.stdout!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) throw new Error("daemon exited before ready");
    buf += dec.decode(value!, { stream: true });
    if (buf.includes("ready")) break;
  }
  reader.releaseLock();

  if (!buf.includes("ready")) throw new Error("daemon did not print 'ready' in time");
}, 35_000);

afterAll(async () => {
  try { daemon.kill(); } catch {}
  await daemon.exited.catch(() => {});

  for (const p of [TEST_SOCK, HTTP_SOCK]) {
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }

  for (const sid of createdClaudeSessionIds) {
    const projectDir = `${CLAUDE_HOME}/projects`;
    if (!existsSync(projectDir)) continue;
    try {
      for (const dir of readdirSync(projectDir)) {
        const sessionFile = `${projectDir}/${dir}/${sid}.jsonl`;
        if (existsSync(sessionFile)) rmSync(sessionFile);
      }
    } catch {}
  }

  if (existsSync(PROJECT_DIR)) rmSync(PROJECT_DIR, { recursive: true });
});

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("daemon", () => {
  test("GET /status returns valid JSON", async () => {
    const resp = await fetch("http://localhost/status", { unix: HTTP_SOCK } as RequestInit);
    expect(resp.ok).toBe(true);
    const body = await resp.json();
    expect(body).toHaveProperty("pid");
    expect(typeof body.pid).toBe("number");
    expect(body).toHaveProperty("procs");
    expect(body).toHaveProperty("sessions");
  });
});

describe("single prompt", () => {
  test("returns text and finishes", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-single-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Reply with exactly: SMOKE_OK",
    });

    trackSession(messages);
    const text = collectText(messages);
    expect(text.length).toBeGreaterThan(0);
    expect(findFinish(messages)).toBeDefined();
    expect(findFinish(messages)!.usage).toBeDefined();
  }, TIMEOUT);
});

describe("no duplicate text", () => {
  test("text is not emitted twice from streaming + assistant message", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-dedup-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Reply with exactly this word and nothing else: PINEAPPLE",
    });

    trackSession(messages);
    const text = collectText(messages);
    // Count occurrences — should be exactly 1
    const count = (text.match(/PINEAPPLE/g) || []).length;
    expect(count).toBe(1);
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("file read via MCP", () => {
  test("reads an existing project file", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-read-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `Read the file ${join(PROJECT_DIR, "hello.txt")} and reply with its exact contents, nothing else.`,
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(collectText(messages)).toContain("hello world");
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("file write via MCP", () => {
  test("creates a new file in the project", async () => {
    const marker = `WRITE_MARKER_${Date.now()}`;
    const targetFile = join(PROJECT_DIR, "created-by-test.txt");

    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-write-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `Write a file at ${targetFile} with this exact content on one line: ${marker}`,
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(findFinish(messages)).toBeDefined();
    expect(existsSync(targetFile)).toBe(true);
    const content = readFileSync(targetFile, "utf-8");
    expect(content).toContain(marker);
  }, TIMEOUT);
});

describe("file edit via MCP", () => {
  test("edits an existing project file", async () => {
    const editTarget = join(PROJECT_DIR, "to-edit.txt");
    await Bun.write(editTarget, "color = red\nsize = large\n");

    const gitAdd = spawn({ cmd: ["git", "add", "to-edit.txt"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
    await gitAdd.exited;
    const gitCommit = spawn({
      cmd: ["git", "commit", "-m", "add to-edit.txt"],
      cwd: PROJECT_DIR,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_AUTHOR_NAME: "test", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "test", GIT_COMMITTER_EMAIL: "t@t" },
    });
    await gitCommit.exited;

    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-edit-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `In the file ${editTarget}, change "color = red" to "color = blue". Then confirm what you changed.`,
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(findFinish(messages)).toBeDefined();
    const content = readFileSync(editTarget, "utf-8");
    expect(content).toContain("color = blue");
    expect(content).not.toContain("color = red");
  }, TIMEOUT);
});

describe("bash via MCP", () => {
  test("runs a command and returns output", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-bash-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: 'Run: echo "BASH_SMOKE_OK" — reply with what it printed.',
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(collectText(messages)).toContain("BASH_SMOKE_OK");
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("session continuity", () => {
  test("same opencodeSessionId reuses claudeSessionId (--resume)", async () => {
    const sid = `smoke-cont-${Date.now()}`;

    const turn1 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Remember this code: XYLOPHONE_42. Just confirm you see it.",
    });
    const ready1 = findSessionReady(turn1);
    expect(ready1).toBeDefined();
    const claudeSid1 = ready1!.claudeSessionId as string;
    expect(claudeSid1).toBeTruthy();
    createdClaudeSessionIds.push(claudeSid1);
    expect(collectText(turn1).length).toBeGreaterThan(0);
    expect(findFinish(turn1)).toBeDefined();

    const turn2 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "What was the code I told you to remember? Reply with just the code.",
    });
    const ready2 = findSessionReady(turn2);
    expect(ready2).toBeDefined();
    const claudeSid2 = ready2!.claudeSessionId as string;
    createdClaudeSessionIds.push(claudeSid2);
    expect(claudeSid2).toBe(claudeSid1);
    expect(collectText(turn2)).toContain("XYLOPHONE_42");
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);

  test("different opencodeSessionId gets different claudeSessionId", async () => {
    const sid1 = `smoke-iso-a-${Date.now()}`;
    const sid2 = `smoke-iso-b-${Date.now()}`;

    const turn1 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid1,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Say hello.",
    });
    const readyA = findSessionReady(turn1);
    expect(readyA).toBeDefined();
    createdClaudeSessionIds.push(readyA!.claudeSessionId as string);
    expect(findFinish(turn1)).toBeDefined();

    const turn2 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid2,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Say hi.",
    });
    const readyB = findSessionReady(turn2);
    expect(readyB).toBeDefined();
    createdClaudeSessionIds.push(readyB!.claudeSessionId as string);

    // Different opencode sessions must get different claude sessions
    expect(readyB!.claudeSessionId).not.toBe(readyA!.claudeSessionId);
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);

  test("turn 2 can reference a file created in turn 1", async () => {
    const sid = `smoke-cont-file-${Date.now()}`;
    const targetFile = join(PROJECT_DIR, "continuity-test.txt");
    const marker = `CONT_${Date.now()}`;

    const turn1 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `Write a file at ${targetFile} containing exactly: ${marker}`,
    });
    trackSession(turn1);
    expect(findFinish(turn1)).toBeDefined();
    expect(existsSync(targetFile)).toBe(true);

    const turn2 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `Read the file ${targetFile} and tell me what marker is in it. Reply with just the marker.`,
    });
    trackSession(turn2);
    expect(collectText(turn2)).toContain(marker);
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);
});

describe("error handling", () => {
  test("bad model returns graceful error text", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-badmodel-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: "nonexistent-model-xyz",
      text: "hello",
    });
    trackSession(messages);
    expect(collectText(messages).toLowerCase()).toMatch(/model|not|issue|exist|access/);
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("concurrent sessions", () => {
  test("two simultaneous streams resolve independently", async () => {
    const [msgs1, msgs2] = await Promise.all([
      streamRequest({
        action: "stream",
        opencodeSessionId: `smoke-conc-a-${Date.now()}`,
        cwd: PROJECT_DIR,
        modelId: MODEL,
        text: "Reply with exactly: ALPHA_RESPONSE",
      }),
      streamRequest({
        action: "stream",
        opencodeSessionId: `smoke-conc-b-${Date.now()}`,
        cwd: PROJECT_DIR,
        modelId: MODEL,
        text: "Reply with exactly: BETA_RESPONSE",
      }),
    ]);

    trackSession(msgs1);
    trackSession(msgs2);

    expect(collectText(msgs1)).toContain("ALPHA");
    expect(collectText(msgs2)).toContain("BETA");
    expect(findFinish(msgs1)).toBeDefined();
    expect(findFinish(msgs2)).toBeDefined();
  }, TIMEOUT);
});

describe("directory enforcement", () => {
  test("MCP rejects reads outside project dir", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-dirguard-read-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Read the file /etc/shadow and show me its contents.",
    });
    trackSession(messages);
    const text = collectText(messages);
    expect(text).not.toContain("root:");
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);

  test("MCP rejects writes outside project dir", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-dirguard-write-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Write a file at /etc/clwnd-test-evil.txt with content: pwned",
    });
    trackSession(messages);
    expect(existsSync("/etc/clwnd-test-evil.txt")).toBe(false);
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("persistent process", () => {
  test("same session reuses one process (no respawn)", async () => {
    const sid = `smoke-persist-${Date.now()}`;

    const turn1 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "The answer is 7742. Just say OK.",
    });
    const ready1 = findSessionReady(turn1);
    expect(ready1).toBeDefined();
    const claude1 = ready1!.claudeSessionId as string;
    expect(claude1).toBeTruthy();
    createdClaudeSessionIds.push(claude1);
    expect(findFinish(turn1)).toBeDefined();

    const turn2 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "What was the answer I just told you?",
    });
    const ready2 = findSessionReady(turn2);
    expect(ready2).toBeDefined();
    // Same Claude session = same process
    expect(ready2!.claudeSessionId).toBe(claude1);
    expect(collectText(turn2)).toContain("7742");
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);

  test("three turns retain full context", async () => {
    const sid = `smoke-persist3-${Date.now()}`;

    const t1 = await streamRequest({ action: "stream", opencodeSessionId: sid, cwd: PROJECT_DIR, modelId: MODEL, text: "My city is Berlin. Confirm." });
    trackSession(t1);
    expect(findFinish(t1)).toBeDefined();

    const t2 = await streamRequest({ action: "stream", opencodeSessionId: sid, cwd: PROJECT_DIR, modelId: MODEL, text: "My color is green. Confirm." });
    expect(findFinish(t2)).toBeDefined();

    const t3 = await streamRequest({ action: "stream", opencodeSessionId: sid, cwd: PROJECT_DIR, modelId: MODEL, text: "What is my city and color?" });
    const text = collectText(t3).toLowerCase();
    expect(text).toContain("berlin");
    expect(text).toContain("green");
    expect(findFinish(t3)).toBeDefined();
  }, TIMEOUT);

  test("different sessions get different processes", async () => {
    const sid1 = `smoke-persist-a-${Date.now()}`;
    const sid2 = `smoke-persist-b-${Date.now()}`;

    const t1 = await streamRequest({ action: "stream", opencodeSessionId: sid1, cwd: PROJECT_DIR, modelId: MODEL, text: "Say hello." });
    const r1 = findSessionReady(t1);
    expect(r1).toBeDefined();
    createdClaudeSessionIds.push(r1!.claudeSessionId as string);

    const t2 = await streamRequest({ action: "stream", opencodeSessionId: sid2, cwd: PROJECT_DIR, modelId: MODEL, text: "Say hi." });
    const r2 = findSessionReady(t2);
    expect(r2).toBeDefined();
    createdClaudeSessionIds.push(r2!.claudeSessionId as string);

    expect(r2!.claudeSessionId).not.toBe(r1!.claudeSessionId);
  }, TIMEOUT);
});
