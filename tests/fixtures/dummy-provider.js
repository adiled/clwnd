exports.default = async function(input) {
  return {
    models: {
      dummy: {
        specificationVersion: "v2",
        modelId: "echo",
        provider: "dummy",
        supportedUrls: {},
        async doGenerate(opts) {
          const last = opts.prompt.findLast(m => m.role === "user");
          const text = typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).filter(p => p.type === "text").map(p => p.text).join(" ");
          return {
            content: [{ type: "text", text: "OK. " + text }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            finishReason: "stop",
            response: { id: "dummy-" + Date.now(), timestamp: new Date(), modelId: "echo" },
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
          const id = "dummy-" + Date.now();
          return {
            stream: new ReadableStream({
              async start(controller) {
                await new Promise(r => setTimeout(r, 10));
                controller.enqueue({ type: "response-metadata", id, timestamp: new Date(), modelId: "echo" });
                controller.enqueue({ type: "text-start", id: "t1" });
                controller.enqueue({ type: "text-delta", id: "t1", delta: "OK. " + text });
                controller.enqueue({ type: "text-end", id: "t1" });
                controller.enqueue({
                  type: "finish",
                  finishReason: "stop",
                  usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
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
