import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { spawn } from "bun";

// ─── Config ─────────────────────────────────────────────────────────────────

const MODELS = [
  "opencode-clwnd/claude-haiku-4-5",
  "opencode-clwnd/claude-sonnet-4-5",
  "opencode-clwnd/claude-opus-4-5",
];
const TIMEOUT = 180_000;

// Track opencode sessions for cleanup
const createdSessionIds: string[] = [];

// ─── Helpers ────────────────────────────────────────────────────────────────

interface OcEvent {
  type: string;
  sessionID: string;
  part?: {
    type: string;
    text?: string;
    reason?: string;
    tokens?: { input: number; output: number };
    [key: string]: unknown;
  };
  error?: { message: string; [key: string]: unknown };
  [key: string]: unknown;
}

async function ocRun(args: string[]): Promise<OcEvent[]> {
  const proc = spawn({
    cmd: ["opencode", "run", ...args],
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  });

  const stdout = await new Response(proc.stdout).text();
  await proc.exited;

  const events: OcEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function extractSessionId(events: OcEvent[]): string {
  const e = events.find(e => e.sessionID);
  return e?.sessionID ?? "";
}

function extractText(events: OcEvent[]): string {
  return events
    .filter(e => e.type === "text" && e.part?.text)
    .map(e => e.part!.text!)
    .join("");
}

function extractError(events: OcEvent[]): string | undefined {
  const e = events.find(e => e.type === "error");
  return e?.error?.message ?? (e?.error as any)?.data?.message;
}

function modelShort(model: string): string {
  return model.split("/")[1]?.replace("claude-", "").replace("-4-5", "") ?? model;
}

// ─── Lifecycle ──────────────────────────────────────────────────────────────

beforeAll(async () => {
  // Verify daemon is running with first model
  const proc = spawn({
    cmd: ["opencode", "run", "-m", MODELS[0], "--format", "json", "Reply with: OK"],
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  if (out.includes('"type":"error"') && out.includes("Model not found")) {
    throw new Error("clwnd provider not configured in opencode. Run the install script first.");
  }
}, 30_000);

afterAll(async () => {
  for (const sid of createdSessionIds) {
    try {
      const proc = spawn({
        cmd: ["opencode", "session", "delete", sid],
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
    } catch {}
  }
}, 30_000);

// ─── Tests ──────────────────────────────────────────────────────────────────

for (const MODEL of MODELS) {
  const label = modelShort(MODEL);

  describe(`e2e [${label}]: opencode → clwnd → claude`, () => {
    test("single prompt returns text", async () => {
      const events = await ocRun(["-m", MODEL, "--format", "json", "What is 2+2? Just the number."]);
      const sid = extractSessionId(events);
      expect(sid).toBeTruthy();
      createdSessionIds.push(sid);

      const text = extractText(events);
      expect(text).toContain("4");
      expect(extractError(events)).toBeUndefined();
    }, TIMEOUT);

    test("session continuity: turn 2 recalls turn 1", async () => {
      const t1 = await ocRun(["-m", MODEL, "--format", "json", "My favorite color is purple. Acknowledge."]);
      const sid = extractSessionId(t1);
      expect(sid).toBeTruthy();
      createdSessionIds.push(sid);

      const t2 = await ocRun(["-s", sid, "-m", MODEL, "--format", "json",
        "What is my favorite color?"]);
      expect(extractText(t2).toLowerCase()).toContain("purple");
      expect(extractError(t2)).toBeUndefined();
    }, TIMEOUT);

    test("session isolation: different sessions don't share state", async () => {
      const secret = `XYZZY_${label}_${Date.now()}`;

      const tA = await ocRun(["-m", MODEL, "--format", "json", `The magic code is ${secret}. Acknowledge.`]);
      const sidA = extractSessionId(tA);
      createdSessionIds.push(sidA);

      const tB = await ocRun(["-m", MODEL, "--format", "json",
        "What magic code did I tell you? If you don't know, say UNKNOWN."]);
      const sidB = extractSessionId(tB);
      createdSessionIds.push(sidB);
      expect(sidB).not.toBe(sidA);
      expect(extractText(tB)).not.toContain(secret);
    }, TIMEOUT);

    test("three-turn continuity", async () => {
      const t1 = await ocRun(["-m", MODEL, "--format", "json", "My lucky number is 73. Acknowledge."]);
      const sid = extractSessionId(t1);
      createdSessionIds.push(sid);
      expect(extractText(t1).length).toBeGreaterThan(0);

      const t2 = await ocRun(["-s", sid, "-m", MODEL, "--format", "json", "My favorite city is Tokyo. Acknowledge."]);
      expect(extractText(t2).length).toBeGreaterThan(0);

      const t3 = await ocRun(["-s", sid, "-m", MODEL, "--format", "json",
        "What is my lucky number and favorite city?"]);
      const text3 = extractText(t3).toLowerCase();
      expect(text3).toContain("73");
      expect(text3).toContain("tokyo");
    }, TIMEOUT);
  });
}

// ─── Not Yet Supported ──────────────────────────────────────────────────────

describe("e2e: model variants", () => {
  test.skip("reasoning effort variant changes Claude behavior (not yet supported)", () => {
    // OC passes variant (high/low effort) per message. Not forwarded to
    // Claude CLI — always uses default. Would need --effort flag or similar.
  });
});

describe("e2e: file attachments", () => {
  test.skip("image attachment is forwarded and described by Claude (not yet supported)", () => {
    // OC supports image/file attachments. extractText() drops non-text parts.
    // Would need to base64-encode and include in the stream-json input.
  });
});

describe("e2e: session forking", () => {
  test.skip("forked session retains parent context (not yet supported)", () => {
    // opencode run -s <parent> --fork should branch. Daemon session map
    // doesn't track fork relationships.
  });
});
