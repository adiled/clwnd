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

// ─── Turn 1: Triage ────────────────────────────────────────────────────────
// Give the LLM everything. Ask for one word.

export const TRIAGE_PROMPT = `You are a sentinel drone. You triage AI coding sessions.
Given the session state below, respond with ONLY one word — the category:
healthy, context-loss, ghost, hemorrhage, stuck, drift, duplicate`;

export function buildTriagePrompt(ctx: DroneContext): string {
  return [
    `Response text (last 500 chars): "${ctx.responseText.slice(-500)}"`,
    `In-flight tools: ${ctx.inflightTools}`,
    `Pending permissions: ${ctx.pendingPermissions}`,
    `Tokens burned: ${ctx.tokensBurned}`,
    `Turn count: ${ctx.turnCount}`,
    `Tools used: ${ctx.toolNames.join(", ") || "none"}`,
    `Wane local=${ctx.localWane} remote=${ctx.remoteWane}`,
    `Missed heartbeats: ${ctx.missedBeats}`,
    `Unacknowledged messages: ${ctx.pendingEchoes}`,
  ].join("\n");
}

export type TriageCategory = "healthy" | "context-loss" | "ghost" | "hemorrhage" | "stuck" | "drift" | "duplicate";

// ─── Turn 2: Treat ─────────────────────────────────────────────────────────
// Targeted prompt per category. Only relevant context. Sharp question.

const TREAT_PROMPTS: Record<Exclude<TriageCategory, "healthy">, string> = {
  "context-loss": `The AI responded as if it has no conversation history. This happens when JSONL seeding failed, turnsSent was wrong, or the process respawned without re-seed.
Signs: "I don't have previous context", "this is a new session", repeating info the user already provided, asking questions already answered, generic responses ignoring prior discussion.
Respond with ONLY JSON: { "action": "swallow" | "reseed" | "none", "reason": "one line" }`,

  "ghost": `The AI mentioned "No response requested" or referred to phantom messages. This is a JSONL seeding artifact — leafUuid or timestamps were wrong.
Respond with ONLY JSON: { "action": "respawn" | "reseed" | "none", "reason": "one line" }`,

  "hemorrhage": `Token burn far exceeds what the prompt warrants. A simple question burning >50K tokens suggests duplicate context injection, stale uncompacted history, or repeated system reminders.
Respond with ONLY JSON: { "action": "reseed" | "alert" | "none", "reason": "one line" }`,

  "stuck": `No tokens streaming but the process is alive. In-flight tools with no progress. Permission pending with no user action.
Respond with ONLY JSON: { "action": "respawn" | "alert" | "none", "reason": "one line" }`,

  "drift": `Local and remote wane diverge. One side's state is stale. This means turnsSent, claudeSessionId, or needsRespawn are out of sync.
Respond with ONLY JSON: { "action": "reseed" | "respawn" | "none", "reason": "one line" }`,

  "duplicate": `The AI repeated the same text or tool call. Suggests double-emission from streaming + final message, or duplicate hum routing.
Respond with ONLY JSON: { "action": "alert" | "none", "reason": "one line" }`,
};

export function buildTreatPrompt(category: Exclude<TriageCategory, "healthy">, ctx: DroneContext): string {
  return `${TREAT_PROMPTS[category]}\n\nSession state:\n${buildTriagePrompt(ctx)}`;
}
