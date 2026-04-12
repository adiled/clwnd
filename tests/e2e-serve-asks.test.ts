import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { spawn, type Subprocess } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";

const PORT = 14568;
const BASE = `http://127.0.0.1:${PORT}`;
const MODEL = { providerID: "opencode-clwnd", modelID: "claude-sonnet-4-5" };
const HOME = process.env.HOME ?? "/tmp";
const SUITE_DIR = join(HOME, ".clwnd-e2e-asks");
const PROJECT_DIR = join(SUITE_DIR, "project");
const TIMEOUT = 180_000;
const activeSessions: string[] = [];

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

async function sendMessage(sid: string, text: string): Promise<any> {
  const r = await fetch(`${BASE}/session/${sid}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(120_000),
  });
  return r.json();
}

let ocProc: Subprocess | null = null;
let dead = false;
function skipIfDead() { if (dead) throw new Error("OC server failed to start"); }

beforeAll(async () => {
  rmSync(SUITE_DIR, { recursive: true, force: true });
  mkdirSync(PROJECT_DIR, { recursive: true });
  const g = spawn({ cmd: ["git", "init"], cwd: PROJECT_DIR, stdout: "pipe", stderr: "pipe" });
  await g.exited;

  ocProc = spawn({
    cmd: ["opencode", "serve", "--port", String(PORT)],
    cwd: PROJECT_DIR,
    stdout: "pipe", stderr: "pipe",
  });
  for (let i = 0; i < 30; i++) {
    try { const r = await fetch(`${BASE}/session`); if (r.ok) break; } catch {}
    await Bun.sleep(1000);
  }
  try { await fetch(`${BASE}/session`); } catch { dead = true; }
}, 60_000);

afterEach(async () => { activeSessions.splice(0); });
afterAll(async () => { if (ocProc) { ocProc.kill(); await ocProc.exited; } });

describe("e2e-asks: do_code through permission pipeline", () => {
  test("creates a typescript file", async () => {
    skipIfDead();
    const sid = await createSession();
    const target = join(PROJECT_DIR, "hello.ts");

    await sendMessage(sid, `Create ${target} with content: export const HELLO = "world";`);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("HELLO");
  }, TIMEOUT);

  test("replaces a symbol in an existing file", async () => {
    skipIfDead();
    const sid = await createSession();
    const target = join(PROJECT_DIR, "edit-me.ts");
    await Bun.write(target, `export function greet() {\n  return "old";\n}\n`);

    await sendMessage(sid, `In ${target}, change the greet function to return "new" instead of "old".`);

    const after = readFileSync(target, "utf-8");
    expect(after).toContain("new");
    expect(after).not.toContain('"old"');
  }, TIMEOUT);
});

describe("e2e-asks: do_noncode through permission pipeline", () => {
  test("creates a markdown file", async () => {
    skipIfDead();
    const sid = await createSession();
    const target = join(PROJECT_DIR, "readme.md");

    await sendMessage(sid, `Create ${target} with content: # Hello World`);

    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf-8")).toContain("Hello World");
  }, TIMEOUT);
});
