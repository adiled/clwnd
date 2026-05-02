// ─── Heuristic Engine ──────────────────────────────────────────────────────
// Fast, deterministic first gate for context-loss detection. Flags
// suspicion — does NOT decide. The LLM judge in ./llm.ts decides.
// Two tiers: CRITICAL (auto-flag, near-zero false positives mid-conversation)
//            SUSPICIOUS (lowers threshold, invokes LLM evaluator)

// Critical: explicit context loss admission — the honest failure mode
const CONTEXT_LOSS_EXPLICIT = [
  /\bi don'?t (have|see|recall|remember) (any )?(previous|prior|earlier|context|history|conversation)/i,
  /\bno (previous|prior) (context|history|conversation|messages?)/i,
  /\b(new|fresh|blank) (session|conversation|chat)\b/i,
  /\bthere'?s nothing (before|prior|earlier)/i,
  /\byour (first|very first) message/i,
  /\bno (history|context) (available|found|stored|present)/i,
  /\bI (can'?t|cannot) (access|see|view|read) (any )?(previous|prior|earlier)/i,
  /\bthis (is|appears to be) (a |the )?(start|beginning) of (our|a|the) conversation/i,
  /\bI (don'?t|do not) have (access to|visibility into|information about) (your |the |any )?(previous|prior)/i,
];

// Critical: identity reset — never legitimate after turn 1
const IDENTITY_RESET = [
  /\bI'?m (OpenCode|Claude|an AI|a coding) ?(assistant|agent|language model|helper)?[.,!]/i,
  /\b(best coding agent|software engineering tasks|Use the instructions below)/i,
  /\bas an AI (language model|assistant|,? I)/i,
  /\bI apologize.{0,30}(don'?t|cannot|can'?t) (have|access)/i,
];

// Critical: greeting reset — emoji greetings or "how can I help" mid-stream
const GREETING_RESET = [
  /^.{0,20}(👋|Hey!|Hello!|Hi there).{0,30}(help|assist|can I)/i,
  /\bhow can I (help|assist) you( today| with)?\??/i,
  /\bwhat (would you like|do you want|can I do|shall I) (me to |to )?(help|do|work)/i,
  /\bI (can|could) help (you )?(with|by):\s*\n/i,
];

// Suspicious: compensation — Claude searches/hedges instead of remembering
const COMPENSATION = [
  /\b(let me|I'?ll) (search|look|check|scan|grep|find) (the |this |your |for )/i,
  /\b(don'?t|do not|can'?t|cannot) (see|find) any (references?|mention|results?)\b/i,
  /\bcould you (provide|give|share) (more|additional|some) (context|details|information)/i,
  /\b(if|are) you (referring|asking|talking) (to|about)/i,
  /\bcould (refer|mean|be referring) to/i,
  /\b(not sure|unsure|unclear) what (you'?re|you are) (referring|asking|talking) (to|about)/i,
];

// Suspicious: formality shift — trust reset, back to transactional mode
const FORMALITY_SHIFT = [
  /\bI'?d (need|require) (more|additional) (information|context|details) (to|before|in order)/i,
  /\bbefore I (proceed|continue|do that).{0,30}(confirm|sure|want)/i,
  /\byou (might|may) want to (check|ask|verify|consult)/i,
  /\b(not|isn'?t) (within|in) my (scope|primary|capabilities|focus)/i,
  /\bI (want to|need to|should) (make sure|ensure|verify|confirm) (this is|you want|before)/i,
];

export type SuspicionLevel = "critical" | "suspicious" | "none";

export function heuristicSuspicion(text: string): boolean {
  return classifySuspicion(text) !== "none";
}

export function classifySuspicion(text: string): SuspicionLevel {
  if (CONTEXT_LOSS_EXPLICIT.some((p) => p.test(text))) return "critical";
  if (IDENTITY_RESET.some((p) => p.test(text))) return "critical";
  if (GREETING_RESET.some((p) => p.test(text))) return "critical";
  if (COMPENSATION.some((p) => p.test(text))) return "suspicious";
  if (FORMALITY_SHIFT.some((p) => p.test(text))) return "suspicious";
  return "none";
}
