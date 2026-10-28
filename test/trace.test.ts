import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import test from "node:test";
import { modelMetadata, observableEvent, serialize, TraceRecorder } from "../src/trace.ts";
import { TraceStore } from "../src/store.ts";
import { assistant, records, task, workspace } from "./helpers.ts";

test("serializes snapshots immediately, preserving repeated references and explicit non-JSON values", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "snapshots", maxPendingBytes: 128 });
  try {
    await recorder.start({ cwd: env.project });
    const message = { content: "first" };
    const pending = recorder.record("message_update", { message, partial: message });
    message.content = "second";
    await pending;
    await recorder.record("message_update", { message });
    await recorder.close();
    const events = await records(recorder);
    assert.equal((events[1].data as any).message.content, "first");
    assert.equal((events[1].data as any).partial.content, "first");
    assert.equal((events[2].data as any).message.content, "second");
    assert.deepEqual(events.map((event) => event.seq), [1, 2, 3, 4]);
    const circular: any = { n: 9n, missing: undefined, error: new Error("example") };
    circular.self = circular;
    const data = JSON.parse(serialize(circular));
    assert.equal(data.n.value, "9");
    assert.equal(data.self.$type, "circular");
    assert.equal("missing" in data, false);
    assert.equal(data.error.message, "example");
  } finally { await recorder.close(); await env.cleanup(); }
});

test("does not capture credential configuration or authentication response headers", () => {
  const model = { id: "test", provider: "fixture", headers: { Authorization: "SECRET" }, apiKey: "SECRET", baseUrl: "https://user:SECRET@host/?key=SECRET" };
  assert.equal(JSON.stringify(modelMetadata(model)).includes("SECRET"), false);
  const event = observableEvent({ type: "model_select", model, previousModel: model });
  assert.equal(JSON.stringify(event).includes("SECRET"), false);
  const response = observableEvent({ type: "after_provider_response", status: 200, headers: { "Set-Cookie": "SECRET", Authorization: "SECRET", "x-request-id": "request" } });
  assert.deepEqual((response as any).headers, { "x-request-id": "request" });
});

test("groups repeated turnIndex across retries and counts final usage once", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "retry" });
  try {
    await recorder.start({ cwd: env.project, sessionName: "Retry" });
    await recorder.record("before_agent_start", { prompt: "retry me" });
    for (const reason of ["error", "stop"]) {
      await recorder.record("agent_start", {});
      await recorder.record("turn_start", { turnIndex: 0 });
      const message = assistant("answer", reason);
      await recorder.record("message_update", { message });
      await recorder.record("message_end", { message });
      await recorder.record("turn_end", { turnIndex: 0, message, outcome: reason === "error" ? "error" : "completed" });
      await recorder.record("agent_end", { messages: [message] });
    }
    await recorder.record("agent_settled", { aborted: false });
    await recorder.close();
    const store = new TraceStore(env.project);
    await store.refresh();
    const view = store.getSession("retry")!;
    assert.equal(view.tasks.length, 1);
    assert.equal(view.tasks[0].turns.length, 2);
    assert.notEqual(view.tasks[0].turns[0].runId, view.tasks[0].turns[1].runId);
    assert.notEqual(view.tasks[0].turns[0].id, view.tasks[0].turns[1].id);
    assert.equal(view.tasks[0].status, "completed");
    assert.equal(view.usage?.totalTokens, 40);
    assert.equal(view.usage?.cost, 0.002);
    assert.equal(view.tasks[0].turns[0].usage?.reasoning, 2);
  } finally { await recorder.close(); await env.cleanup(); }
});

test("records consecutive turns, queued input, nested tools, compaction and branch events", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "tools" });
  try {
    await recorder.start({ cwd: env.project });
    await recorder.record("before_agent_start", { prompt: "tools" });
    await recorder.record("agent_start", {});
    for (let turnIndex = 0; turnIndex < 2; turnIndex++) {
      await recorder.record("turn_start", { turnIndex });
      if (turnIndex === 0) {
        await recorder.record("input", { text: "follow up", streamingBehavior: "followUp" });
        for (const [toolCallId, parentToolCallId] of [["parent", undefined], ["parent/1", "parent"]]) {
          await recorder.record("tool_execution_start", { toolCallId, parentToolCallId, toolName: "bash", args: { command: "echo example" } });
          await recorder.record("tool_execution_update", { toolCallId, toolName: "bash", partialResult: { content: "partial" } });
          await recorder.record("tool_execution_end", { toolCallId, parentToolCallId, toolName: "bash", result: { content: "example" }, durationMs: 12, isError: false });
        }
      } else {
        await recorder.record("message_start", { message: { role: "user", content: [{ type: "text", text: "follow up" }] } });
      }
      await recorder.record("turn_end", { turnIndex, message: assistant(), outcome: "completed" });
    }
    for (const type of ["session_before_compact", "session_compact", "session_tree", "model_select"]) await recorder.record(type, { example: true });
    await recorder.record("agent_end", {});
    await recorder.record("agent_settled", { aborted: false });
    await recorder.close();
    const store = new TraceStore(env.project);
    await store.refresh();
    const turns = store.getSession("tools")!.tasks[0].turns;
    assert.equal(turns[0].tools[1].parentId, "parent");
    assert.equal(turns[0].tools[1].durationMs, 12);
    assert.equal(turns[1].inputs[0].text, "follow up");
    assert.equal((await store.getEvents("tools", { type: "session_compact" }))!.items.length, 1);
    const filtered = (await store.getEvents("tools", { q: "echo example", tool: "bash", category: "tools" }))!;
    assert.equal(filtered.items.length, 2);
  } finally { await recorder.close(); await env.cleanup(); }
});

test("multiple instances and reload fragments share a session without importing context usage", async () => {
  const env = await workspace();
  const first = new TraceRecorder({ project: env.project, sessionId: "same-session" });
  const second = new TraceRecorder({ project: env.project, sessionId: "same-session" });
  try {
    await first.start({ snapshot: { contextEntries: [{ message: assistant() }] } });
    await second.start({ lifecycle: { reason: "reload" } });
    await Promise.all([task(first, "first"), task(second, "second")]);
    await first.close("reload");
    await second.close();
    const store = new TraceStore(env.project);
    await store.refresh();
    const view = store.getSession("same-session")!;
    assert.equal(view.tasks.length, 2);
    assert.equal(view.usage?.totalTokens, 40);
    assert.equal(store.exportFiles("same-session")!.length, 2);
    assert.equal((await store.refresh()), false);
  } finally { await first.close(); await second.close(); await env.cleanup(); }
});

for (const stopReason of ["stop", "aborted", "error"]) {
  test(`final task state: ${stopReason}`, async () => {
    const env = await workspace();
    const recorder = new TraceRecorder({ project: env.project, sessionId: stopReason });
    try {
      await recorder.start({});
      await task(recorder, "test", stopReason);
      await recorder.close();
      const store = new TraceStore(env.project);
      await store.refresh();
      assert.equal(store.getSession(stopReason)!.tasks[0].status, stopReason === "stop" ? "completed" : stopReason);
    } finally { await recorder.close(); await env.cleanup(); }
  });
}

test("incomplete UTF-8 tail is ignored until completed; unfinished tasks become interrupted", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "crash" });
  try {
    await recorder.start({});
    await recorder.record("before_agent_start", { prompt: "unfinished" });
    await recorder.record("agent_start", {});
    await recorder.record("turn_start", { turnIndex: 0 });
    await recorder.close();
    const event = { schemaVersion: 1, recorderId: recorder.recorderId, sessionId: "crash", seq: 100, timestamp: new Date().toISOString(), elapsedMs: 100, type: "example", data: { text: "你好" } };
    const line = Buffer.from(`${JSON.stringify(event)}\n`);
    await appendFile(recorder.filePath, line.subarray(0, line.length - 4));
    const store = new TraceStore(env.project);
    await store.refresh();
    assert.equal(store.getSession("crash")!.tasks[0].status, "interrupted");
    assert.equal((await store.getEvents("crash", { type: "example" }))!.items.length, 0);
    await appendFile(recorder.filePath, line.subarray(line.length - 4));
    await store.refresh();
    const found = (await store.getEvents("crash", { type: "example" }))!.items[0];
    assert.equal((await store.getEvent("crash", found.id))!.data && ((await store.getEvent("crash", found.id))!.data as any).text, "你好");
  } finally { await recorder.close(); await env.cleanup(); }
});

test("disk failure is reported once and is persisted as an error state", async () => {
  const env = await workspace();
  const errors: Error[] = [];
  let fail = false;
  const recorder = new TraceRecorder({ project: env.project, sessionId: "failure", onError: (error) => errors.push(error), write: async (file, line) => {
    if (fail) throw new Error("ENOSPC: fixture disk full");
    await file.writeFile(line);
  } });
  try {
    await recorder.start({});
    fail = true;
    await recorder.record("input", { text: "fail" });
    await recorder.flush();
    await recorder.record("input", { text: "also fail" });
    await recorder.close();
    assert.equal(recorder.status, "error");
    assert.equal(errors.length, 1);
    const sidecar = JSON.parse(await readFile(recorder.filePath.replace(".jsonl", ".state.json"), "utf8"));
    assert.equal(sidecar.status, "error");
    const store = new TraceStore(env.project);
    await store.refresh();
    assert.match(store.getSession("failure")!.errors.join(), /ENOSPC/);
  } finally { await recorder.close(); await env.cleanup(); }
});

test("large payloads are saved without truncation and loaded only on demand", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "large", maxPendingBytes: 1024 });
  try {
    await recorder.start({});
    const payload = { text: "完整数据".repeat(200000) };
    await recorder.record("before_provider_request", { payload });
    await recorder.close();
    const store = new TraceStore(env.project);
    await store.refresh();
    const page = (await store.getEvents("large", { type: "before_provider_request" }))!;
    assert.ok(JSON.stringify(page).length < 1000, "index must not embed the full payload");
    const event = (await store.getEvent("large", page.items[0].id))!;
    assert.equal((event.data as any).payload.text, payload.text);
  } finally { await recorder.close(); await env.cleanup(); }
});
