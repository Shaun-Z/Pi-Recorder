import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/index.ts";
import { TraceStore } from "../src/store.ts";
import { workspace } from "./helpers.ts";

test("repeated session_start reuses the writer and shutdown closes every resource", async () => {
  const env = await workspace();
  const handlers = new Map<string, (event: any, ctx: ExtensionContext) => Promise<void>>();
  const pi = {
    on: (name: string, handler: (event: any, ctx: ExtensionContext) => Promise<void>) => { handlers.set(name, handler); },
    registerCommand: () => {}, getSessionName: () => undefined, getActiveTools: () => [],
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: env.project, ui: { notify: () => {}, setStatus: () => {} }, getSystemPrompt: () => "system",
    sessionManager: { getSessionId: () => "rebound", getSessionFile: () => undefined, getHeader: () => null, buildContextEntries: () => [] },
  } as unknown as ExtensionContext;
  extension(pi);
  try {
    const start = handlers.get("session_start")!;
    await start({ type: "session_start", reason: "resume" }, ctx);
    await start({ type: "session_start", reason: "resume" }, ctx);
    const input = { type: "input", text: "keep this input", images: [{ type: "image", data: "original" }] };
    const before = JSON.stringify(input);
    assert.equal(await handlers.get("input")!(input, ctx), undefined);
    assert.equal(JSON.stringify(input), before, "observer must not change input");
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    const store = new TraceStore(env.project);
    await store.refresh();
    assert.equal(store.exportFiles("rebound")!.length, 1);
    assert.equal(store.getSession("rebound")!.active, false);
    assert.equal((await store.getEvents("rebound", { type: "session_start" }))!.items.length, 1);
  } finally {
    await handlers.get("session_shutdown")!({ type: "session_shutdown", reason: "quit" }, ctx);
    await env.cleanup();
  }
});
