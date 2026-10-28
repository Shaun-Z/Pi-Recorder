// Offline integration fixture. Pi loads this through its normal extension loader.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("fixture-reload", {
    description: "Reload the isolated smoke-test runtime",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  pi.registerProvider("looplog-fixture", {
    api: "looplog-fixture-api",
    apiKey: "offline-fixture-only",
    baseUrl: "http://127.0.0.1/unused",
    models: [{
      id: "local", name: "Looplog offline fixture", reasoning: true, input: ["text"],
      contextWindow: 100000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop",
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        await options?.onPayload?.({ model: model.id, messages: context.messages, fixture: true }, model);
        await options?.onResponse?.({ status: 200, headers: { "x-fixture": "local", "set-cookie": "FIXTURE_COOKIE_DO_NOT_RECORD" } }, model);
        await options?.onProviderStreamEvent?.({ type: "fixture.start" }, model);
        stream.push({ type: "start", partial: message });
        const previous = context.messages.at(-1);
        if (previous?.role !== "toolResult") {
          message.content.push({ type: "thinking", thinking: "" });
          stream.push({ type: "thinking_start", contentIndex: 0, partial: message });
          message.content[0] = { type: "thinking", thinking: "检查本地工具输出。" };
          stream.push({ type: "thinking_delta", contentIndex: 0, delta: "检查本地工具输出。", partial: message });
          stream.push({ type: "thinking_end", contentIndex: 0, content: "检查本地工具输出。", partial: message });
          const toolCall = { type: "toolCall" as const, id: `fixture-${Date.now()}`, name: "bash", arguments: { command: "printf 'looplog-smoke-ok\\n'" } };
          message.content.push(toolCall);
          stream.push({ type: "toolcall_start", contentIndex: 1, partial: message });
          stream.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: message });
          message.stopReason = "toolUse";
        } else {
          message.content.push({ type: "text", text: "" });
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          const text = '本地验证通过。<img src=x onerror="window.__looplogXss=1">';
          message.content[0] = { type: "text", text };
          stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message });
        }
        await options?.onProviderStreamEvent?.({ type: "fixture.end", reason: message.stopReason }, model);
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      })().catch((error: unknown) => {
        message.stopReason = "error";
        message.errorMessage = String(error);
        stream.push({ type: "error", reason: "error", error: message });
      });
      return stream;
    },
  });
}
