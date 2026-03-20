import { generateId } from "@ai-sdk/provider-utils";
import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
  LanguageModelV2Prompt,
} from "@ai-sdk/provider";
import type { ClwndConfig } from "./types.ts";

// ─── Tool Mapping (Claude CLI MCP → OpenCode native) ────────────────────────

const MCP_PREFIX = "mcp__clwnd__";

// Map MCP tool names to OpenCode tool names
function mapToolName(name: string): string {
  if (name.startsWith(MCP_PREFIX)) return name.slice(MCP_PREFIX.length);
  return name;
}

// snake_case → camelCase field mapping per tool
const INPUT_FIELD_MAP: Record<string, Record<string, string>> = {
  read:  { file_path: "filePath" },
  edit:  { file_path: "filePath", old_string: "oldString", new_string: "newString", replace_all: "replaceAll" },
  write: { file_path: "filePath" },
  bash:  {}, // command, description, timeout are already correct
  glob:  {}, // pattern, path are already correct
  grep:  {}, // pattern, path, include are already correct
};

function mapToolInput(toolName: string, input: string): string {
  const ocName = mapToolName(toolName);
  const fieldMap = INPUT_FIELD_MAP[ocName];
  if (!fieldMap || Object.keys(fieldMap).length === 0) return input;
  try {
    const parsed = JSON.parse(input);
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(parsed)) {
      mapped[fieldMap[k] ?? k] = v;
    }
    return JSON.stringify(mapped);
  } catch {
    return input;
  }
}

// Extract <!--clwnd-meta:...--> from MCP tool result text
function parseToolResult(resultText: string): { output: string; title: string; metadata: Record<string, unknown> } {
  const metaMatch = resultText.match(/<!--clwnd-meta:(.*?)-->/s);
  let title = "";
  let metadata: Record<string, unknown> = {};
  let output = resultText;

  if (metaMatch) {
    output = resultText.replace(/\n?<!--clwnd-meta:.*?-->/s, "").trim();
    try {
      const parsed = JSON.parse(metaMatch[1]);
      title = parsed.title ?? "";
      metadata = parsed.metadata ?? {};
    } catch {}
  }

  return { output, title, metadata };
}

interface IpcToDaemon {
  action: string;
  opencodeSessionId: string;
  [key: string]: unknown;
}

interface IpcToPlugin {
  action: string;
  opencodeSessionId?: string;
  chunkType?: string;
  finishReason?: string;
  usage?: Record<string, number>;
  providerMetadata?: Record<string, unknown>;
  message?: string;
  claudeSessionId?: string;
  model?: string;
  tools?: string[];
  [key: string]: unknown;
}

function defaultSocketPath(): string {
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime) return `${runtime}/clwnd/clwnd.sock`;
  return "/tmp/clwnd.sock";
}

const SOCK_PATH = (process.env.CLWND_SOCKET ?? defaultSocketPath()) + ".http";

// POST to daemon, get streaming NDJSON response back
function streamCall(msg: IpcToDaemon): Promise<Response> {
  return fetch("http://localhost/stream", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
    unix: SOCK_PATH,
  } as RequestInit);
}

async function ipcCall(msg: IpcToDaemon): Promise<void> {
  const r = await fetch("http://localhost/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(msg),
    unix: SOCK_PATH,
  } as RequestInit);
  if (!r.ok) throw new Error(`clwnd IPC ${r.status}`);
}

function extractText(prompt: LanguageModelV2Prompt): string {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i];
    if (m.role === "user") {
      if (typeof m.content === "string") return m.content;
      if (Array.isArray(m.content)) {
        for (const p of m.content as Array<{ type: string; text?: string }>) {
          if (p.type === "text" && p.text) return p.text;
        }
      }
    }
  }
  return "";
}

// Parse NDJSON lines from buffer
function parseNDJSON(buffer: string, sessionId: string): { messages: IpcToPlugin[]; remaining: string } {
  const messages: IpcToPlugin[] = [];
  const lines = buffer.split("\n");
  const remaining = lines.pop() ?? "";

  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line) as IpcToPlugin;
      messages.push(msg);
    } catch {}
  }

  return { messages, remaining };
}

export class ClwndModel implements LanguageModelV2 {
  readonly specificationVersion = "v2";
  readonly modelId: string;
  readonly provider = "clwnd";
  readonly supportedUrls: Record<string, RegExp[]> = {};

  constructor(
    modelId: string,
    private config: ClwndConfig = {},
  ) {
    this.modelId = modelId;
  }

  async doGenerate(
    opts: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<{
    content: LanguageModelV2Content[];
    finishReason: LanguageModelV2FinishReason;
    usage: LanguageModelV2Usage;
    warnings: LanguageModelV2CallWarning[];
    request: { body: unknown };
    response: { id: string; timestamp: Date; modelId: string };
    providerMetadata: Record<string, unknown>;
  }> {
    const sid = opts.headers?.["x-opencode-session"] ?? generateId();
    const text = extractText(opts.prompt);
    const warnings: LanguageModelV2CallWarning[] = [];
    const cwd = this.config.cwd ?? process.cwd();

    let reasoning = "";
    let responseText = "";
    const toolCalls: LanguageModelV2Content[] = [];
    const toolInputAccum = new Map<string, string>();
    let resolved = false;

    const result = await new Promise<{
      content: LanguageModelV2Content[];
      finishReason: LanguageModelV2FinishReason;
      usage: LanguageModelV2Usage;
      providerMetadata: Record<string, unknown>;
    }>((resolve, reject) => {
      const abort = () => {
        if (resolved) return;
        resolved = true;
        // Don't send destroy — daemon manages session lifecycle for --resume.
        reject(new Error("aborted"));
      };
      opts.abortSignal?.addEventListener("abort", abort);

      streamCall({
        action: "stream",
        opencodeSessionId: sid,
        cwd,
        modelId: this.modelId,
        text,

      }).then(async (resp) => {
        if (!resp.body) { abort(); return; }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value!, { stream: true });
            const { messages, remaining } = parseNDJSON(buffer, sid);
            buffer = remaining;

            for (const msg of messages) {
              if (msg.action === "chunk") {
                const ct = msg.chunkType as string;
                if (ct === "reasoning_delta" && typeof msg.delta === "string") reasoning += msg.delta;
                if (ct === "text_delta" && typeof msg.delta === "string") responseText += msg.delta;
                if (ct === "tool_input_start" && msg.toolCallId) toolInputAccum.set(msg.toolCallId as string, "");
                if (ct === "tool_input_delta" && msg.toolCallId && msg.partialJson) {
                  const prev = toolInputAccum.get(msg.toolCallId as string) ?? "";
                  toolInputAccum.set(msg.toolCallId as string, prev + msg.partialJson);
                }
                if (ct === "tool_call" && msg.toolCallId && msg.toolName) {
                  const accumulated = toolInputAccum.get(msg.toolCallId as string) ?? "{}";
                  const mapped = mapToolInput(msg.toolName as string, accumulated);
                  let input: unknown = {};
                  try { input = JSON.parse(mapped); } catch { input = {}; }
                  toolCalls.push({
                    type: "tool-call",
                    toolCallId: msg.toolCallId,
                    toolName: mapToolName(msg.toolName as string),
                    input,
                  } as LanguageModelV2Content);
                }
              }

              if (msg.action === "finish") {
                if (resolved) return;
                resolved = true;
                const finishReason = (msg.finishReason ?? "stop") as LanguageModelV2FinishReason;
                const usage = (msg.usage ?? { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined }) as LanguageModelV2Usage;
                const providerMetadata = msg.providerMetadata ?? {};
                const content: LanguageModelV2Content[] = [];
                if (reasoning) content.push({ type: "reasoning", text: reasoning } as LanguageModelV2Content);
                if (responseText) content.push({ type: "text", text: responseText } as LanguageModelV2Content);
                content.push(...toolCalls);
                opts.abortSignal?.removeEventListener("abort", abort);
                reader.releaseLock();
                resolve({ content, finishReason, usage, providerMetadata });
                return;
              }

              if (msg.action === "error") {
                if (resolved) return;
                resolved = true;
                opts.abortSignal?.removeEventListener("abort", abort);
                reader.releaseLock();
                reject(new Error(msg.message));
                return;
              }
            }
          }
        } finally {
          try { reader.releaseLock(); } catch {}
        }
        if (!resolved) { resolved = true; reject(new Error("stream ended without finish")); }
      }).catch((e) => {
        if (!resolved) { resolved = true; reject(e); }
      });

      setTimeout(() => { if (!resolved) abort(); }, 120000);
    });

    return {
      ...result,
      warnings,
      request: { body: { text } },
      response: { id: sid, timestamp: new Date(), modelId: this.modelId },
    };
  }

  async doStream(
    opts: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<{
    stream: ReadableStream<LanguageModelV2StreamPart>;
    rawCall: { raw: unknown; rawHeaders: unknown };
    warnings: LanguageModelV2CallWarning[];
  }> {
    const sid = opts.headers?.["x-opencode-session"] ?? generateId();
    const text = extractText(opts.prompt);
    const warnings: LanguageModelV2CallWarning[] = [];
    const cwd = this.config.cwd ?? process.cwd();
    const self = this;
    const toolInputAccum = new Map<string, string>();

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      async start(controller) {
        const textId = generateId();
        const reasoningId = generateId();
        let done = false;
        let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
        let textStarted = false;
        let reasoningStarted = false;

        function emit(part: LanguageModelV2StreamPart) {
          if (done) return;
          try { controller.enqueue(part); } catch { done = true; }
        }

        function close() {
          if (done) return;
          done = true;
          try { reader?.releaseLock(); } catch {}
          try { controller.close(); } catch {}
        }

        opts.abortSignal?.addEventListener("abort", () => {
          // Don't send destroy — the daemon manages session lifecycle.
          // Sending destroy here would nuke the session map entry needed for --resume.
          close();
        });

        let resp: Response;
        try {
          resp = await streamCall({
            action: "stream",
            opencodeSessionId: sid,
            cwd,
            modelId: self.modelId,
            text,
    
          });
        } catch (e) {
          emit({ type: "error", error: new Error(String(e)) } as LanguageModelV2StreamPart);
          close();
          return;
        }

        if (!resp.body) { close(); return; }
        reader = resp.body.getReader();

        emit({ type: "stream-start", warnings } as LanguageModelV2StreamPart);

        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (!done) {
            const { done: rd, value } = await reader.read();
            if (rd) { close(); break; }
            buffer += decoder.decode(value!, { stream: true });
            const { messages, remaining } = parseNDJSON(buffer, sid);
            buffer = remaining;

            for (const msg of messages) {
              if (msg.action === "chunk") {
                const ct = msg.chunkType;
                if (ct === "text_start" || (ct === "text_delta" && !textStarted)) {
                  if (!textStarted) {
                    textStarted = true;
                    emit({ type: "text-start", id: textId } as LanguageModelV2StreamPart);
                  }
                }
                if (ct === "text_delta" && msg.delta) {
                  emit({ type: "text-delta", id: textId, delta: msg.delta } as LanguageModelV2StreamPart);
                }
                if (ct === "reasoning_start" || (ct === "reasoning_delta" && !reasoningStarted)) {
                  if (!reasoningStarted) {
                    reasoningStarted = true;
                    emit({ type: "reasoning-start", id: reasoningId } as LanguageModelV2StreamPart);
                  }
                }
                if (ct === "reasoning_delta" && msg.delta) {
                  emit({ type: "reasoning-delta", id: reasoningId, delta: msg.delta } as LanguageModelV2StreamPart);
                }
                if (ct === "reasoning_end") {
                  emit({ type: "reasoning-end", id: reasoningId } as LanguageModelV2StreamPart);
                  reasoningStarted = false; // prevent double-end at finish
                }
                if (ct === "tool_input_start" && msg.toolCallId && msg.toolName) {
                  toolInputAccum.set(msg.toolCallId as string, "");
                  emit({ type: "tool-input-start", id: msg.toolCallId, toolName: mapToolName(msg.toolName as string) } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_input_delta" && msg.toolCallId && msg.partialJson) {
                  const prev = toolInputAccum.get(msg.toolCallId as string) ?? "";
                  toolInputAccum.set(msg.toolCallId as string, prev + msg.partialJson);
                  emit({ type: "tool-input-delta", id: msg.toolCallId, delta: msg.partialJson } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_call" && msg.toolCallId && msg.toolName) {
                  const ocToolName = mapToolName(msg.toolName as string);
                  // For MCP tools, tool_input_start may never fire (Claude CLI emits
                  // the full assistant message, not streaming content blocks). Emit
                  // tool-input-start so OpenCode's processor creates the part entry.
                  if (!toolInputAccum.has(msg.toolCallId as string)) {
                    emit({ type: "tool-input-start", id: msg.toolCallId, toolName: ocToolName } as LanguageModelV2StreamPart);
                  }
                  // Resolve input: prefer accumulated from streaming, fall back to msg.input
                  const accumulated = toolInputAccum.get(msg.toolCallId as string);
                  let rawInput: string;
                  if (accumulated) {
                    rawInput = mapToolInput(msg.toolName as string, accumulated);
                  } else if (msg.input && typeof msg.input === "object") {
                    rawInput = mapToolInput(msg.toolName as string, JSON.stringify(msg.input));
                  } else {
                    rawInput = "{}";
                  }
                  emit({
                    type: "tool-call",
                    toolCallId: msg.toolCallId,
                    toolName: ocToolName,
                    input: rawInput,
                    providerExecuted: true,
                  } as LanguageModelV2StreamPart);
                }
                if (ct === "tool_result" && msg.toolCallId) {
                  const raw = (msg as Record<string, unknown>).result ?? "";
                  const { output, title, metadata } = parseToolResult(typeof raw === "string" ? raw : JSON.stringify(raw));
                  emit({
                    type: "tool-result",
                    toolCallId: msg.toolCallId,
                    result: { output, title, metadata },
                    providerExecuted: true,
                  } as LanguageModelV2StreamPart);
                }
              }

              if (msg.action === "finish") {
                // Emit text-end / reasoning-end before finish
                if (textStarted) {
                  emit({ type: "text-end", id: textId } as LanguageModelV2StreamPart);
                }
                if (reasoningStarted) {
                  emit({ type: "reasoning-end", id: reasoningId } as LanguageModelV2StreamPart);
                }
                const u = msg.usage as Record<string, unknown> | undefined;
                emit({
                  type: "finish",
                  finishReason: (msg.finishReason ?? "stop") as LanguageModelV2FinishReason,
                  usage: {
                    inputTokens: (u?.input_tokens ?? u?.inputTokens) as number | undefined,
                    outputTokens: (u?.output_tokens ?? u?.outputTokens) as number | undefined,
                    totalTokens: undefined,
                  },
                  providerMetadata: msg.providerMetadata ?? {},
                } as LanguageModelV2StreamPart);
                close();
                return;
              }

              if (msg.action === "error") {
                emit({ type: "error", error: new Error(msg.message) } as LanguageModelV2StreamPart);
                close();
                return;
              }
            }
          }
        } catch (e) {
          emit({ type: "error", error: new Error(String(e)) } as LanguageModelV2StreamPart);
          close();
        }
      },

      cancel() {
        // Don't send destroy — daemon manages session lifecycle for --resume.
      },
    });

    return {
      stream,
      rawCall: { raw: { text }, rawHeaders: {} },
      warnings,
    };
  }
}

export function createClwnd(config: ClwndConfig = {}) {
  const fn = (modelId: string): LanguageModelV2 => new ClwndModel(modelId, config);
  fn.languageModel = (modelId: string) => new ClwndModel(modelId, config);
  return fn;
}
