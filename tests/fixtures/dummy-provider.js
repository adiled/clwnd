const { readFileSync } = require("fs");
const { join } = require("path");

// Load seed fixture — replay assistant responses in order
const fixture = JSON.parse(readFileSync(join(__dirname, "seed-session.json"), "utf8"));
const assistantTexts = fixture.messages
  .filter(m => m.info.role === "assistant")
  .map(m => m.parts.filter(p => p.type === "text").map(p => p.text).join("\n"));
let replayIdx = 0;

function nextReply(userText) {
  // If we have fixture responses, replay them; otherwise echo
  if (replayIdx < assistantTexts.length) {
    return assistantTexts[replayIdx++];
  }
  return "OK. " + userText;
}

exports.default = async function(input) {
  return {
    models: {
      "gpt-5-nano": {
        specificationVersion: "v2",
        modelId: "gpt-5-nano",
        provider: "opencode",
        supportedUrls: {},
        async doGenerate(opts) {
          const last = opts.prompt.findLast(m => m.role === "user");
          const text = typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).filter(p => p.type === "text").map(p => p.text).join(" ");
          const reply = nextReply(text);
          return {
            content: [{ type: "text", text: reply }],
            usage: { inputTokens: 10, outputTokens: reply.length, totalTokens: reply.length + 10 },
            finishReason: "stop",
            response: { id: "dummy-" + Date.now(), timestamp: new Date(), modelId: "gpt-5-nano" },
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
          const reply = nextReply(text);
          const id = "dummy-" + Date.now();
          return {
            stream: new ReadableStream({
              async start(controller) {
                await new Promise(r => setTimeout(r, 10));
                controller.enqueue({ type: "response-metadata", id, timestamp: new Date(), modelId: "gpt-5-nano" });
                controller.enqueue({ type: "text-start", id: "t1" });
                controller.enqueue({ type: "text-delta", id: "t1", delta: reply });
                controller.enqueue({ type: "text-end", id: "t1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 10, outputTokens: reply.length, totalTokens: reply.length + 10 },
                  providerMetadata: {},
                });
                controller.close();
              },
            }),
            rawCall: { raw: {}, rawHeaders: {} },
            warnings: [],
          };
        },
      },
    },
  };
};
