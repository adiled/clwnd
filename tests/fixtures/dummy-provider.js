const { readFileSync } = require("fs");
const { join } = require("path");

// Load seed fixture — replay assistant responses in order
const fixture = JSON.parse(readFileSync(join(__dirname, "seed-session.json"), "utf8"));
const assistantParts = fixture.messages
  .filter(m => m.info.role === "assistant")
  .map(m => m.parts);
let replayIdx = 0;

function nextParts(userText) {
  if (replayIdx < assistantParts.length) {
    return assistantParts[replayIdx++];
  }
  // Fallback: simple text response
  return [{ type: "text", text: "OK. " + userText }];
}

// AI SDK provider factory — OC looks for exports starting with "create"
exports.createPiano = function createPiano(options) {
  const model = {
    specificationVersion: "v2",
    modelId: "pianoV2",
    provider: options?.name ?? "piano",
    supportedUrls: {},
    async doGenerate(opts) {
      const last = opts.prompt.findLast(m => m.role === "user");
      const text = typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).filter(p => p.type === "text").map(p => p.text).join(" ");
      const parts = nextParts(text);
      const reply = parts.filter(p => p.type === "text").map(p => p.text).join("\n");
      return {
        content: [{ type: "text", text: reply }],
        usage: { inputTokens: 10, outputTokens: reply.length, totalTokens: reply.length + 10 },
        finishReason: "stop",
        response: { id: "dummy-" + Date.now(), timestamp: new Date(), modelId: "pianoV2" },
        providerMetadata: {},
        warnings: [],
        request: { body: {} },
      };
    },
    async doStream(opts) {
      const last = opts.prompt.findLast(m => m.role === "user");
      const text = typeof last?.content === "string"
        ? last.content
        : (last?.content ?? []).filter(p => p.type === "text").map(p => p.text).join(" ");
      const parts = nextParts(text);
      const id = "dummy-" + Date.now();
      let reasoningIdx = 0;

      return {
        stream: new ReadableStream({
          async start(controller) {
            await new Promise(r => setTimeout(r, 10));
            controller.enqueue({ type: "response-metadata", id, timestamp: new Date(), modelId: "pianoV2" });

            for (const p of parts) {
              if (p.type === "reasoning") {
                const rid = "r" + (reasoningIdx++);
                controller.enqueue({ type: "reasoning-start", id: rid });
                controller.enqueue({ type: "reasoning-delta", id: rid, delta: p.text });
                controller.enqueue({ type: "reasoning-end", id: rid });
              } else if (p.type === "text") {
                controller.enqueue({ type: "text-start", id: "t1" });
                controller.enqueue({ type: "text-delta", id: "t1", delta: p.text });
                controller.enqueue({ type: "text-end", id: "t1" });
              }
            }

            const totalText = parts.filter(p => p.type === "text" || p.type === "reasoning").map(p => p.text || "").join("");
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 10, outputTokens: totalText.length, totalTokens: totalText.length + 10 },
              providerMetadata: {},
            });
            controller.close();
          },
        }),
        rawCall: { raw: {}, rawHeaders: {} },
        warnings: [],
      };
    },
  };

  return {
    languageModel(modelId) {
      return model;
    },
  };
};
