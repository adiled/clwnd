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

  const gitInit = spawn({
    cmd: ["git", "init"],
    cwd: PROJECT_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  await gitInit.exited;

  // Seed with files so the repo isn't empty
  await Bun.write(join(PROJECT_DIR, "hello.txt"), "hello world\n");
  await Bun.write(join(PROJECT_DIR, "config.json"), JSON.stringify({ version: 1, name: "smoke-test" }, null, 2) + "\n");

  // Grant Claude CLI tool permissions for this project
  mkdirSync(join(PROJECT_DIR, ".claude"), { recursive: true });
  await Bun.write(join(PROJECT_DIR, ".claude", "settings.json"), JSON.stringify({
    permissions: {
      allow: [
        "Bash(*)","Read(*)","Write(*)","Edit(*)","Glob(*)","Grep(*)",
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
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const reader = daemon.stdout!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const deadline = Date.now() + 10_000;

  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) throw new Error("daemon exited before ready");
    buf += dec.decode(value!, { stream: true });
    if (buf.includes("ready")) break;
  }
  reader.releaseLock();

  if (!buf.includes("ready")) throw new Error("daemon did not print 'ready' in time");
}, 20_000);

afterAll(async () => {
  try { daemon.kill(); } catch {}
  await daemon.exited.catch(() => {});

  for (const p of [TEST_SOCK, HTTP_SOCK]) {
    if (existsSync(p)) try { unlinkSync(p); } catch {}
  }

  // Clean up session JSONL files
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

  // Remove test project
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
    expect(text).toContain("SMOKE_OK");
    expect(findFinish(messages)).toBeDefined();
    expect(findFinish(messages)!.usage).toBeDefined();
  }, TIMEOUT);
});

describe("file read", () => {
  test("reads an existing project file", async () => {
    const messages = await streamRequest({
      action: "stream",
      opencodeSessionId: `smoke-read-${Date.now()}`,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: `Read the file hello.txt in ${PROJECT_DIR} and reply with its exact contents, nothing else.`,
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(collectText(messages)).toContain("hello world");
    expect(findFinish(messages)).toBeDefined();
  }, TIMEOUT);
});

describe("file write", () => {
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

    // Verify the file was actually created on disk
    expect(existsSync(targetFile)).toBe(true);
    const content = readFileSync(targetFile, "utf-8");
    expect(content).toContain(marker);
  }, TIMEOUT);
});

describe("file edit", () => {
  test("edits an existing project file", async () => {
    // Seed a file to edit
    const editTarget = join(PROJECT_DIR, "to-edit.txt");
    await Bun.write(editTarget, "color = red\nsize = large\n");

    // Stage it so Edit tool can work on it
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
      text: `In the file ${editTarget}, change "color = red" to "color = blue". Use the Edit tool. Then confirm what you changed.`,
    });

    trackSession(messages);
    expect(hasToolChunks(messages)).toBe(true);
    expect(findFinish(messages)).toBeDefined();

    // Verify the edit was applied on disk
    const content = readFileSync(editTarget, "utf-8");
    expect(content).toContain("color = blue");
    expect(content).not.toContain("color = red");
  }, TIMEOUT);
});

describe("bash execution", () => {
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

    // Turn 1: establish a fact
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
    const text1 = collectText(turn1);
    expect(text1.length).toBeGreaterThan(0);
    expect(findFinish(turn1)).toBeDefined();

    // Turn 2: same opencodeSessionId — daemon must --resume with same claudeSessionId
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

    // Key assertion: same Claude CLI session was resumed
    expect(claudeSid2).toBe(claudeSid1);

    expect(collectText(turn2)).toContain("XYLOPHONE_42");
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);

  test("different opencodeSessionId gets different claudeSessionId (no crosstalk)", async () => {
    const sid1 = `smoke-iso-a-${Date.now()}`;
    const sid2 = `smoke-iso-b-${Date.now()}`;

    // Session A: establish a fact
    const turn1 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid1,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "Remember this secret: MANGO_77. Confirm.",
    });
    const readyA = findSessionReady(turn1);
    expect(readyA).toBeDefined();
    createdClaudeSessionIds.push(readyA!.claudeSessionId as string);
    expect(findFinish(turn1)).toBeDefined();

    // Session B (different ID): ask for the secret — should NOT know it
    const turn2 = await streamRequest({
      action: "stream",
      opencodeSessionId: sid2,
      cwd: PROJECT_DIR,
      modelId: MODEL,
      text: "What secret did I tell you? If you don't know, reply with exactly: NO_SECRET",
    });
    const readyB = findSessionReady(turn2);
    expect(readyB).toBeDefined();
    createdClaudeSessionIds.push(readyB!.claudeSessionId as string);

    // Different Claude sessions
    expect(readyB!.claudeSessionId).not.toBe(readyA!.claudeSessionId);

    // Should not recall MANGO_77
    const text2 = collectText(turn2);
    expect(text2).not.toContain("MANGO_77");
    expect(findFinish(turn2)).toBeDefined();
  }, TIMEOUT);

  test("turn 2 can reference a file created in turn 1", async () => {
    const sid = `smoke-cont-file-${Date.now()}`;
    const targetFile = join(PROJECT_DIR, "continuity-test.txt");
    const marker = `CONT_${Date.now()}`;

    // Turn 1: create a file
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

    // Turn 2: same session — Claude CLI resumes, remembers what it did
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
