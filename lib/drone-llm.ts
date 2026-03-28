// ─── Drone LLM ─────────────────────────────────────────────────────────────
// The drone's brain. Calls the running OC server's model endpoint directly.
// No SDK. Just HTTP to localhost. Uses whatever free model OC has.

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

async function ocMessage(base: string, sessionId: string, text: string, timeout = 10000): Promise<string> {
  const resp = await fetch(`${base}/session/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: droneModel(), parts: [{ type: "text", text }] }),
    signal: AbortSignal.timeout(timeout),
  });
  if (!resp.ok) throw new Error(`drone: message ${resp.status}`);
  const msg = await resp.json() as { parts?: Array<{ type: string; text?: string }> };
  return (msg.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("").trim();
}

// Two turns: triage then treat.
export async function droneThink(
  ctx: DroneContext,
  ocPort = 4096,
): Promise<DroneJudgment> {
  const base = `http://127.0.0.1:${ocPort}`;

  const sessionResp = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: process.env.HOME ?? "/" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!sessionResp.ok) throw new Error(`drone: session create ${sessionResp.status}`);
  const session = await sessionResp.json() as { id: string };

  try {
    // Turn 1: Triage — one word
    const triageText = await ocMessage(base, session.id,
      `${TRIAGE_PROMPT}\n\n${buildTriagePrompt(ctx)}`, 8000);
    const category = triageText.toLowerCase().replace(/[^a-z-]/g, "") as TriageCategory;

    if (category === "healthy" || !CATEGORY_TO_ASSESSMENT[category]) {
      return { assessment: "serene", action: "none", reason: `triage: ${triageText}` };
    }

    // Turn 2: Treat — targeted action
    const treatText = await ocMessage(base, session.id,
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
  } finally {
    // Archive thinking then delete — async, don't block
    (async () => {
      try {
        // Export the session's thinking
        const exportResp = await fetch(`${base}/session/${session.id}/message`);
        if (exportResp.ok) {
          const messages = await exportResp.json() as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>;
          const thinking = messages
            .filter(m => m.info.role === "assistant")
            .flatMap(m => m.parts.filter(p => p.type === "text").map(p => p.text ?? ""))
            .join("\n");
          if (thinking) {
            const stateDir = process.env.XDG_STATE_HOME
              ? `${process.env.XDG_STATE_HOME}/clwnd`
              : `${process.env.HOME}/.local/state/clwnd`;
            const { mkdirSync, appendFileSync } = await import("fs");
            mkdirSync(`${stateDir}`, { recursive: true });
            appendFileSync(`${stateDir}/drone-thinking.log`,
              `${new Date().toISOString()} session=${session.id}\n${thinking}\n---\n`);
          }
        }
      } catch {}
      // Delete the throwaway session
      fetch(`${base}/session/${session.id}`, { method: "DELETE" }).catch(() => {});
    })();
  }
}
