import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import test from "node:test";
import { startViewer } from "../src/server.ts";
import { TraceRecorder } from "../src/trace.ts";
import { task, workspace } from "./helpers.ts";

test("viewer serves historical sessions, paginated filters, full detail and complete JSONL", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "web-session" });
  let viewer;
  try {
    await recorder.start({ cwd: env.project });
    await task(recorder, '<img src=x onerror="alert(1)"> searchable payload');
    await recorder.close();
    await appendFile(recorder.filePath, '{"unfinished":');
    viewer = await startViewer(env.project);
    const get = async (path: string) => {
      const response = await fetch(`${viewer!.url}${path}`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const sessions = await get("/api/sessions");
    assert.equal(sessions.sessions.length, 1);
    assert.equal(sessions.sessions[0].turnCount, 1);
    assert.equal(sessions.sessions[0].usage.totalTokens, 20);
    const path = "/api/sessions/web-session";
    const page = await get(`${path}/events?limit=2`);
    assert.equal(page.items.length, 2);
    assert.ok(page.nextCursor);
    const second = await get(`${path}/events?limit=2&before=${encodeURIComponent(page.nextCursor)}`);
    assert.equal(second.items.length, 2);
    assert.notEqual(second.items[0].id, page.items[0].id);
    const filtered = await get(`${path}/events?category=context&q=searchable`);
    assert.equal(filtered.items.some((item: any) => item.type === "before_provider_request"), true);
    const detail = await get(`${path}/event?id=${encodeURIComponent(filtered.items[0].id)}`);
    assert.equal(detail.sessionId, "web-session");
    const session = await get(path);
    const byTurn = await get(`${path}/events?turn=${session.tasks[0].turns[0].id}`);
    assert.ok(byTurn.items.length);
    assert.ok(byTurn.items.every((event: any) => event.turnId));
    const response = await fetch(`${viewer.url}${path}/download`);
    const exported = (await response.text()).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(exported.length, sessions.sessions[0].eventCount);
    assert.equal(response.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    assert.equal((await fetch(`${viewer.url}/api/sessions/unknown`)).status, 404);
    assert.equal((await fetch(`${viewer.url}/api/sessions/web-session/event?id=unknown`)).status, 404);
    assert.equal((await fetch(`${viewer.url}/src/trace.ts`)).status, 404);
    assert.equal((await fetch(`${viewer.url}/api/sessions`, { headers: { Origin: "https://example.org" } })).status, 403);
    const spoofedHost = await new Promise<number | undefined>((done, reject) => {
      httpGet(`${viewer!.url}/api/sessions`, { headers: { Host: "attacker.invalid" } }, (response) => {
        response.resume();
        done(response.statusCode);
      }).once("error", reject);
    });
    assert.equal(spoofedHost, 403);
    const html = await fetch(viewer.url);
    assert.match(await html.text(), /执行时间线/);
    assert.match(html.headers.get("content-security-policy")!, /script-src 'self'/);
    const js = await (await fetch(`${viewer.url}/app.js`)).text();
    assert.equal(js.includes("innerHTML"), false);
    assert.equal(js.includes("textContent"), true);
    assert.match(await (await fetch(`${viewer.url}/style.css`)).text(), /\.workspace/);
  } finally { await viewer?.close(); await recorder.close(); await env.cleanup(); }
});

test("live invalidations work across instances and reconnect loads the current snapshot", async () => {
  const env = await workspace();
  const recorder = new TraceRecorder({ project: env.project, sessionId: "live" });
  let viewer;
  const controller = new AbortController();
  try {
    viewer = await startViewer(env.project);
    const stream = await fetch(`${viewer.url}/api/live`, { signal: controller.signal });
    const reader = stream.body!.getReader();
    assert.match(Buffer.from((await reader.read()).value!).toString(), /event: change/);
    await recorder.start({});
    await task(recorder);
    await recorder.flush();
    const deadline = AbortSignal.timeout(5000);
    const frame = await Promise.race([
      reader.read(),
      new Promise<never>((_resolve, reject) => deadline.addEventListener("abort", () => reject(new Error("SSE update timed out")), { once: true })),
    ]);
    assert.match(Buffer.from(frame.value!).toString(), /event: change/);
    controller.abort();
    const sessions = await (await fetch(`${viewer.url}/api/sessions`)).json();
    assert.equal(sessions.sessions[0].active, true);
    const reconnect = await fetch(`${viewer.url}/api/live`, { signal: AbortSignal.timeout(2000) });
    const secondReader = reconnect.body!.getReader();
    assert.match(Buffer.from((await secondReader.read()).value!).toString(), /event: change/);
    await secondReader.cancel();
    await recorder.close();
    const ended = await (await fetch(`${viewer.url}/api/sessions/live`)).json();
    assert.equal(ended.active, false);
  } finally { controller.abort(); await viewer?.close(); await recorder.close(); await env.cleanup(); }
});

test("empty project has an empty session list", async () => {
  const env = await workspace();
  const viewer = await startViewer(env.project);
  try {
    assert.deepEqual((await (await fetch(`${viewer.url}/api/sessions`)).json()).sessions, []);
  } finally { await viewer.close(); await env.cleanup(); }
});
