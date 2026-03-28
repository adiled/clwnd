// ─── Drone LLM ─────────────────────────────────────────────────────────────
// The drone's brain. Calls the running OC server's model endpoint directly.
// No SDK. Just HTTP to localhost. Uses whatever free model OC has.

import { SYSTEM_PROMPT, buildPrompt, type DroneContext } from "./drone-prompts.ts";
import type { Assessment } from "./hum.ts";

export interface DroneJudgment {
  assessment: Assessment;
  action: "none" | "reseed" | "respawn" | "swallow" | "alert";
  reason: string;
}

// OC server's LLM endpoint — create a throwaway session, send one message, read response
export async function droneThink(
  ctx: DroneContext,
  ocPort = 4096,
): Promise<DroneJudgment> {
  const base = `http://127.0.0.1:${ocPort}`;

  // Create a temporary session for the evaluation
  const sessionResp = await fetch(`${base}/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ directory: process.env.HOME ?? "/" }),
    signal: AbortSignal.timeout(5000),
  });
  if (!sessionResp.ok) throw new Error(`drone: session create ${sessionResp.status}`);
  const session = await sessionResp.json() as { id: string };

  try {
    // Send the evaluation prompt using the free model
    const msgResp = await fetch(`${base}/session/${session.id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: { providerID: "opencode", modelID: "gpt-5-nano" },
        parts: [
          { type: "text", text: `${SYSTEM_PROMPT}\n\n${buildPrompt(ctx)}` },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!msgResp.ok) throw new Error(`drone: message ${msgResp.status}`);
    const msg = await msgResp.json() as { parts?: Array<{ type: string; text?: string }> };
    const content = (msg.parts ?? []).filter(p => p.type === "text").map(p => p.text ?? "").join("");

    // Parse judgment from response
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { assessment: "serene", action: "none", reason: "no JSON in response" };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      assessment: parsed.assessment ?? "serene",
      action: parsed.action ?? "none",
      reason: parsed.reason ?? "",
    };
  } catch (e) {
    return { assessment: "serene", action: "none", reason: `evaluation failed: ${e}` };
  } finally {
    // Clean up the temporary session
    fetch(`${base}/session/${session.id}`, { method: "DELETE" }).catch(() => {});
  }
}
