// ─── Drone Prompts ─────────────────────────────────────────────────────────
//
// The drone's brain. Each prompt is a heuristic expressed as natural language.
// The LLM evaluates the accumulated session state against these prompts and
// returns an assessment + action.
//
// These prompts are derived from every horror in clwnd's commit history.
// They encode what went wrong so the drone can prevent it from happening again.

export interface DroneContext {
  responseText: string;
  inflightTools: number;
  pendingPermissions: number;
  tokensBurned: number;
  turnCount: number;
  localWane: number;
  remoteWane: number;
  missedBeats: number;
  pendingEchoes: number;
  toolNames: string[];
}

export const SYSTEM_PROMPT = `You are a sentinel drone monitoring the health of an AI coding session.
You observe the accumulated state of a session and assess its health.

You respond with ONLY a JSON object, no markdown, no explanation:
{
  "assessment": "serene" | "alert" | "tense" | "critical",
  "action": "none" | "reseed" | "respawn" | "swallow" | "alert",
  "reason": "one line explanation"
}

Assessment levels:
- serene: everything is healthy, normal operation
- alert: active session, worth watching
- tense: something is off, intervention may be needed soon
- critical: immediate action required

Actions:
- none: do nothing, continue observing
- reseed: re-export OC history into Claude CLI JSONL (context may be stale or lost)
- respawn: kill the Claude CLI process and start fresh (process is stuck or corrupted)
- swallow: discard the current response, re-send the prompt (response is garbage)
- alert: notify the user that something needs attention`;

export function buildPrompt(ctx: DroneContext): string {
  const parts: string[] = [];

  parts.push("Session state:");
  parts.push(`- Response text (last 500 chars): "${ctx.responseText.slice(-500)}"`);
  parts.push(`- In-flight tools: ${ctx.inflightTools}`);
  parts.push(`- Pending permissions: ${ctx.pendingPermissions}`);
  parts.push(`- Tokens burned this turn: ${ctx.tokensBurned}`);
  parts.push(`- Turn count: ${ctx.turnCount}`);
  parts.push(`- Tool names used: ${ctx.toolNames.join(", ") || "none"}`);
  parts.push(`- Local wane: ${ctx.localWane}, Remote wane: ${ctx.remoteWane}`);
  parts.push(`- Missed heartbeats: ${ctx.missedBeats}`);
  parts.push(`- Unacknowledged messages: ${ctx.pendingEchoes}`);

  parts.push("");
  parts.push("Known failure patterns from history:");
  parts.push("1. CONTEXT LOSS: The AI responds as if it has no conversation history. Phrases like 'I don't have any previous context', 'this is a new session', 'your first message was', 'from what you've shared in this conversation' (when there IS prior history). Also subtle: repeating information the user already provided, asking questions that were already answered, or giving generic responses that ignore specific prior discussion. Action: swallow.");
  parts.push("2. GHOST RESPONSES: The AI mentions 'No response requested' or refers to phantom messages that don't exist. This is a JSONL seeding artifact. Action: reseed + respawn.");
  parts.push("3. TOKEN HEMORRHAGE: Tokens burned far exceed what the prompt warrants. A simple question burning >50K tokens suggests duplicate context injection or stale history. Action: reseed.");
  parts.push("4. STUCK PROCESS: No tokens streaming for extended period but the process is alive. In-flight tools > 0 with no progress. Permission pending with no user action. Action: respawn.");
  parts.push("5. WANE DRIFT: Local and remote wane diverge. One side's state is stale. The longer the drift, the more dangerous. Action: reseed.");
  parts.push("6. DUPLICATE OUTPUT: The AI repeats the same text or tool call. Suggests double-emission from streaming + final message. Action: alert.");

  parts.push("");
  parts.push("Assess this session. What is the health? What action should be taken?");

  return parts.join("\n");
}
