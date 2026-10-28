import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { join, resolve } from "node:path";
import { TraceStore } from "../src/store.ts";

// Uses the installed `pi` executable, an isolated config and a local-only provider.
// Keep the generated project so it can also be inspected in the browser.
const root = resolve("test-workspace");
await mkdir(root, { recursive: true });
const project = await mkdtemp(join(root, "smoke-"));
const config = join(project, "pi-config");
await mkdir(config);
const testBin = join(project, "test-bin");
await mkdir(testBin);
// Exercise /looplog without launching or taking focus from the user's browser.
for (const executable of ["open", "xdg-open"]) {
  await writeFile(join(testBin, executable), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}
await writeFile(join(config, "settings.json"), JSON.stringify({ quietStartup: true, retry: { enabled: false }, compaction: { enabled: false } }));
const child = spawn("pi", [
  "--mode", "rpc", "--offline", "--no-extensions", "--no-mcp", "--no-skills",
  "--no-prompt-templates", "--no-themes", "--no-context-files",
  "-e", resolve("test/fixtures/provider.ts"), "-e", resolve("src/index.ts"),
  "--model", "looplog-fixture/local", "--tools", "bash", "--session-dir", join(project, "pi-sessions"),
], {
  cwd: project,
  env: { ...process.env, PATH: `${testBin}:${process.env.PATH ?? ""}`, PI_CODING_AGENT_DIR: config, PI_TELEMETRY: "0", PI_OFFLINE: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-10000); });
const messages: any[] = [];
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  try { messages.push(JSON.parse(line)); }
  catch { stderr = (stderr + `\n${line}`).slice(-10000); }
});
let spawnError: Error | undefined;
child.once("error", (error) => { spawnError = error; });
async function waitFor(predicate: () => boolean, label: string, timeout = 20000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Pi 提前退出：${child.exitCode}\n${stderr}`);
    if (Date.now() - started > timeout) throw new Error(`等待 ${label} 超时\n${stderr}\n${JSON.stringify(messages.slice(-3))}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
let sequence = 0;
async function command(type: string, fields: Record<string, unknown> = {}) {
  const id = `smoke-${++sequence}`;
  child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
  await waitFor(() => messages.some((message) => message.type === "response" && message.id === id), type);
  const response = messages.find((message) => message.type === "response" && message.id === id);
  assert.equal(response.success, true, JSON.stringify(response));
  return response.data;
}

try {
  await command("get_state");
  for (const text of ["/devtest", "/devtest example", "/looplog status"]) await command("prompt", { message: text });
  const notices = messages.filter((message) => message.type === "extension_ui_request" && message.method === "notify").map((message) => message.message);
  assert.ok(notices.includes("DEV extension loaded"), "startup notification missing");
  assert.ok(notices.includes("devtest: hello"));
  assert.ok(notices.includes("devtest: example"));
  assert.ok(notices.some((message: string) => message.includes("记录状态：recording")));
  let settled = messages.filter((message) => message.type === "agent_settled").length;
  await command("prompt", { message: "请用 bash 输出 looplog-smoke-ok，然后给出确认。" });
  await waitFor(() => messages.filter((message) => message.type === "agent_settled").length > settled, "first agent_settled");
  const original = await command("get_state");
  await command("prompt", { message: "/looplog" });
  const firstUrl = messages.filter((message) => message.method === "notify").map((message) => message.message as string).findLast((message) => message.startsWith("本地记录：http"))?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(firstUrl, "viewer command must publish a local URL");
  assert.match(await (await fetch(firstUrl)).text(), /执行时间线/);
  assert.equal((await (await fetch(`${firstUrl}/api/sessions/${original.sessionId}`)).json()).usage.totalTokens, 30);
  await command("new_session");
  await assert.rejects(fetch(firstUrl), "old viewer must close on session replacement");
  settled = messages.filter((message) => message.type === "agent_settled").length;
  await command("prompt", { message: "再次运行本地验证。" });
  await waitFor(() => messages.filter((message) => message.type === "agent_settled").length > settled, "second agent_settled");
  await command("switch_session", { sessionPath: original.sessionFile });
  assert.equal((await command("get_state")).sessionId, original.sessionId);
  await command("prompt", { message: "/fixture-reload" });
  assert.equal((await command("get_state")).sessionId, original.sessionId);
  await command("prompt", { message: "/looplog" });
  const reloadedUrl = messages.filter((message) => message.method === "notify").map((message) => message.message as string).findLast((message) => message.startsWith("本地记录：http"))?.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(reloadedUrl, "viewer must reopen after reload");
  assert.equal((await fetch(`${reloadedUrl}/app.js`)).status, 200);
  settled = messages.filter((message) => message.type === "agent_settled").length;
  await command("prompt", { message: "恢复和 reload 后继续验证。" });
  await waitFor(() => messages.filter((message) => message.type === "agent_settled").length > settled, "resumed agent_settled");
  child.stdin.end();
  await Promise.race([once(child, "exit"), new Promise<never>((_done, reject) => setTimeout(() => reject(new Error("Pi shutdown timed out")), 10000).unref())]);

  const store = new TraceStore(project);
  await store.refresh();
  const sessions = store.listSessions() as any[];
  assert.equal(sessions.length, 2, "new_session must replace the recorder");
  for (const summary of sessions) {
    const session = store.getSession(summary.id)!;
    const expectedTasks = summary.id === original.sessionId ? 2 : 1;
    assert.equal(session.tasks.length, expectedTasks);
    assert.ok(session.tasks.every((task) => task.status === "completed" && task.turns.length === 2));
    assert.equal(session.usage?.totalTokens, 30 * expectedTasks);
    if (summary.id === original.sessionId) assert.equal(store.exportFiles(summary.id)!.length, 3, "startup, resume, reload fragments");
    assert.equal(session.tasks[0].turns[0].tools[0].name, "bash");
    const events = (await store.getEvents(summary.id, { limit: 100 }))!.items;
    for (const type of ["before_provider_request", "after_provider_response", "provider_stream_event", "context_with_system", "tool_execution_start", "tool_execution_end", "message_update", "turn_end", "session_shutdown"]) {
      assert.ok(events.some((event) => event.type === type), `missing ${type}`);
    }
    const toolResult = events.find((event) => event.type === "tool_execution_end")!;
    assert.match(JSON.stringify((await store.getEvent(summary.id, toolResult.id))!.data), /looplog-smoke-ok/);
    for (const file of store.exportFiles(summary.id)!) {
      const text = await readFile(file.path, "utf8");
      assert.equal(text.includes("FIXTURE_COOKIE_DO_NOT_RECORD"), false);
      assert.equal(text.includes("offline-fixture-only"), false);
    }
  }
  const report = { project, sessions: sessions.map((session) => session.id), verified: ["startup", "devtest", "status", "looplog viewer", "provider hooks", "visible thinking", "bash", "two turns", "new_session", "resume", "reload", "shutdown"] };
  await writeFile(join(root, "latest-smoke.json"), JSON.stringify(report, null, 2));
  console.log(`Pi smoke passed\n${JSON.stringify(report, null, 2)}`);
} catch (error) {
  console.error(`Smoke workspace: ${project}`);
  throw error;
} finally {
  if (child.exitCode === null) child.kill("SIGTERM");
  lines.close();
}
