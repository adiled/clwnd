// ─── Drone LLM ─────────────────────────────────────────────────────────────
// The drone's brain. Uses the OC SDK to create throwaway sessions for triage.
// Workspace-isolated: drone sessions don't pollute the user's session list.

import { TRIAGE_PROMPT, buildTriagePrompt, buildTreatPrompt, type DroneContext, type TriageCategory } from "./drone-prompts.ts";
import type { Assessment } from "./hum.ts";
import { loadConfig } from "./config.ts";

export interface DroneJudgment {
  assessment: Assessment;
  action: "none" | "reseed" | "respawn" | "swallow" | "alert";
  reason: string;
}

const CATEGORY_TO_ASSESSMENT: Record<TriageCategory, Assessment> = {
  "healthy": "serene",
  "context-loss": "critical",
  "ghost": "critical",
  "hemorrhage": "tense",
  "stuck": "critical",
  "drift": "tense",
  "duplicate": "alert",
};

function droneModel() {
  const cfg = loadConfig();
  return cfg.droneModel;
}

// ─── Workspace ──────────────────────────────────────────────────────────────
// Drone sessions live in an isolated workspace — invisible to the user.

let workspaceId: string | null = null;

export function setDroneWorkspace(id: string): void {
  workspaceId = id;
}

// ─── OC messaging ──────────────────────────────────────────────────────────

function applyWorkspace(url: URL): URL {
  if (workspaceId) url.searchParams.set("workspace", workspaceId);
  return url;
}

async function ocMessage(base: string, sessionId: string, text: string, timeout = 10000): Promise<string> {
  const url = applyWorkspace(new URL(`/session/${sessionId}/message`, base));
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: droneModel(), parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`drone: message ${resp.status}`);
  const msg = await resp.json() as { parts?: Array<{ type: string; text?: string }> };
  return (msg.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("").trim();
}

// ─── Dedicated sessions ────────────────────────────────────────────────────
// Each clwnd session gets its own drone session — persistent, not throwaway.
// The drone accumulates context about the session's health over time.

const droneSessions = new Map<string, { id: string; base: string }>();

async function ensureDroneSession(base: string, sigil: string): Promise<string> {
  const existing = droneSessions.get(sigil);
  if (existing && existing.base === base) return existing.id;

  const url = applyWorkspace(new URL("/session", base));
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: process.env.HOME ?? "/" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) throw new Error(`drone: session create ${resp.status}`);
  const session = await resp.json() as { id: string };
  droneSessions.set(sigil, { id: session.id, base });
  return session.id;
}

export function releaseDroneSession(sigil: string): void {
  const entry = droneSessions.get(sigil);
  if (!entry) return;
  droneSessions.delete(sigil);
  const url = applyWorkspace(new URL(`/session/${entry.id}`, entry.base));
  fetch(url, { method: "DELETE" }).catch(() => {});
}

// ─── Think ─────────────────────────────────────────────────────────────────
// Two turns per evaluation in the session's dedicated drone session.

export async function droneThink(
  ctx: DroneContext,
  ocBaseUrl = "http://127.0.0.1:4096",
  sigil = "default",
): Promise<DroneJudgment> {
  const sessionId = await ensureDroneSession(ocBaseUrl, sigil);

  try {
    // Turn 1: Triage — one word
    const triageText = await ocMessage(ocBaseUrl, sessionId,
      `${TRIAGE_PROMPT}\n\n${buildTriagePrompt(ctx)}`, 8000);
    const category = triageText.toLowerCase().replace(/[^a-z-]/g, "") as TriageCategory;

    if (category === "healthy" || !CATEGORY_TO_ASSESSMENT[category]) {
      return { assessment: "serene", action: "none", reason: `triage: ${triageText}` };
    }

    // Turn 2: Treat — targeted action
    const treatText = await ocMessage(ocBaseUrl, sessionId,
      buildTreatPrompt(category, ctx), 10000);

    const jsonMatch = treatText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { assessment: CATEGORY_TO_ASSESSMENT[category], action: "none", reason: `treat parse failed: ${treatText}` };
    }
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      assessment: CATEGORY_TO_ASSESSMENT[category],
      action: parsed.action ?? "none",
      reason: parsed.reason ?? category,
    };
  } catch (e) {
    return { assessment: "serene", action: "none", reason: `evaluation failed: ${e}` };
  }
}
