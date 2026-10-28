import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TraceRecorder } from "../src/trace.ts";
import type { TraceRecord } from "../src/trace.ts";

export async function workspace() {
  const project = await mkdtemp(join(tmpdir(), "looplog-test-"));
  return { project, cleanup: () => rm(project, { recursive: true, force: true }) };
}

export async function records(recorder: TraceRecorder): Promise<TraceRecord[]> {
  await recorder.flush();
  return (await readFile(recorder.filePath, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as TraceRecord);
}

export function assistant(text = "done", stopReason = "stop") {
  return {
    role: "assistant", provider: "fixture", model: "local", thinkingLevel: "low",
    content: [{ type: "thinking", thinking: "visible thinking" }, { type: "text", text }],
    stopReason,
    usage: { input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoning: 2, totalTokens: 20, cost: { total: 0.001 } },
  };
}

export async function task(recorder: TraceRecorder, prompt = "hello", stopReason = "stop") {
  await recorder.record("input", { text: prompt, source: "interactive" });
  await recorder.record("before_agent_start", { prompt, systemPrompt: "system" });
  await recorder.record("agent_start", {});
  await recorder.record("turn_start", { turnIndex: 0 });
  await recorder.record("message_start", { message: { role: "user", content: [{ type: "text", text: prompt }] } });
  const message = assistant("done", stopReason);
  await recorder.record("context_with_system", { messages: [{ role: "system", content: "system" }] });
  await recorder.record("before_provider_request", { payload: { messages: [{ content: prompt }] } });
  await recorder.record("message_update", { message, assistantMessageEvent: { type: "text_delta", delta: "done" } });
  await recorder.record("message_end", { message });
  await recorder.record("turn_end", { turnIndex: 0, message, outcome: stopReason === "error" ? "error" : stopReason === "aborted" ? "aborted" : "completed" });
  await recorder.record("agent_end", { messages: [message] });
  await recorder.record("agent_settled", { aborted: stopReason === "aborted" });
}
