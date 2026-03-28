// Dummy provider for tests — responds instantly with canned text.
// Registered as opencode plugin, available as dummy/echo.
// Used in place of free models for gap fill / cold start tests.

import type { Plugin } from "@opencode-ai/plugin";

const dummyPlugin: Plugin = async (input) => {
  return {
    models: {
      echo: {
        specificationVersion: "v2" as const,
        modelId: "echo",
        provider: "dummy",
        supportedUrls: {},
        async doGenerate(opts: any) {
          const last = opts.prompt.findLast((m: any) => m.role === "user");
          const text = typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
          return {
            content: [{ type: "text" as const, text: `OK. ${text}` }],
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
            finishReason: "stop" as const,
            response: { id: "dummy", timestamp: new Date(), modelId: "echo" },
            providerMetadata: {},
            warnings: [],
            request: { body: {} },
          };
        },
        async doStream(opts: any) {
          const last = opts.prompt.findLast((m: any) => m.role === "user");
          const text = typeof last?.content === "string"
            ? last.content
            : (last?.content ?? []).filter((p: any) => p.type === "text").map((p: any) => p.text).join(" ");
          const response = `OK. ${text}`;
          const stream = new ReadableStream({
            start(controller) {
              controller.enqueue({ type: "text-start", id: "t1" });
              controller.enqueue({ type: "text-delta", id: "t1", delta: response });
              controller.enqueue({ type: "text-end", id: "t1" });
              controller.enqueue({
                type: "finish",
                finishReason: "stop",
                usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
                providerMetadata: {},
              });
              controller.close();
            },
          });
          return { stream, rawCall: { raw: {}, rawHeaders: {} }, warnings: [] };
        },
      },
    },
  };
};

export { dummyPlugin };
export default dummyPlugin;
