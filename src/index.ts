import { spawn } from "node:child_process";
import type { ExtensionAPI, ExtensionContext, ExtensionEvent } from "@earendil-works/pi-coding-agent";
import { modelMetadata, observableEvent, TraceRecorder, traceDirectory } from "./trace.ts";
import { startViewer } from "./server.ts";
import type { Viewer } from "./server.ts";

function openBrowser(url: string): Promise<void> {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((resolveOpen, reject) => {
    const child = spawn(command, args, { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveOpen() : reject(new Error(`浏览器启动失败（${code}）`)));
  });
}

export default function (pi: ExtensionAPI) {
  let recorder: TraceRecorder | undefined;
  let viewer: Viewer | undefined;
  let startingViewer: Promise<Viewer> | undefined;
  let startupError: string | undefined;
  let currentContext: ExtensionContext | undefined;

  function reportError(ctx: ExtensionContext, error: Error) {
    startupError = error.message;
    ctx.ui.setStatus("looplog", "● 记录错误");
    ctx.ui.notify(`Pi-Recorder 记录失败：${error.message}`, "error");
  }

  pi.on("session_start", async (event, ctx) => {
    currentContext = ctx;
    ctx.ui.notify("DEV extension loaded", "info");
    // RPC rebinding can emit session_start twice for one runtime. Keep the
    // writer and its heartbeat instead of replacing it with an orphaned writer.
    if (recorder?.status === "recording" && recorder.sessionId === ctx.sessionManager.getSessionId()) {
      await recorder.record(event.type, event);
      ctx.ui.setStatus("looplog", "● 本地记录中");
      return;
    }
    await recorder?.close("replaced");
    startupError = undefined;
    recorder = new TraceRecorder({ project: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), onError: (error) => reportError(currentContext ?? ctx, error) });
    try {
      await recorder.start({
        cwd: ctx.cwd,
        sessionName: pi.getSessionName(),
        sessionFile: ctx.sessionManager.getSessionFile(),
        sessionHeader: ctx.sessionManager.getHeader(),
        lifecycle: event,
        nodeVersion: process.version,
        snapshot: {
          systemPrompt: ctx.getSystemPrompt(),
          contextEntries: ctx.sessionManager.buildContextEntries(),
          model: modelMetadata(ctx.model),
          thinkingLevel: ctx.thinkingLevel,
          activeTools: pi.getActiveTools(),
        },
      });
      if (recorder.status === "recording") ctx.ui.setStatus("looplog", "● 本地记录中");
    } catch (error) {
      if (!startupError) reportError(ctx, error instanceof Error ? error : new Error(String(error)));
    }
  });

  // Keep explicit registration so Pi's event overloads remain checked by tsc.
  const observe = async (event: ExtensionEvent) => {
    await recorder?.record(event.type, observableEvent(event as unknown as { type: string; [key: string]: unknown }));
  };
  pi.on("input", observe);
  pi.on("before_agent_start", observe);
  pi.on("agent_start", observe);
  pi.on("agent_end", observe);
  pi.on("agent_before_settle", observe);
  pi.on("agent_settled", observe);
  pi.on("turn_start", observe);
  pi.on("turn_end", observe);
  pi.on("context", observe);
  pi.on("context_with_system", observe);
  pi.on("before_provider_request", observe);
  pi.on("after_provider_response", observe);
  pi.on("provider_stream_event", observe);
  pi.on("message_start", observe);
  pi.on("message_update", observe);
  pi.on("message_end", observe);
  pi.on("tool_execution_start", observe);
  pi.on("tool_call", observe);
  pi.on("tool_execution_update", observe);
  pi.on("tool_result", observe);
  pi.on("tool_execution_end", observe);
  pi.on("session_info_changed", observe);
  pi.on("session_before_switch", observe);
  pi.on("session_before_fork", observe);
  pi.on("session_before_tree", observe);
  pi.on("session_tree", observe);
  pi.on("session_before_compact", observe);
  pi.on("session_compact", observe);
  pi.on("session_compact_failed", observe);
  pi.on("model_select", observe);
  pi.on("thinking_level_select", observe);
  pi.on("user_bash", observe);
  pi.on("ui_prompt_start", observe);
  pi.on("ui_prompt_end", observe);
  pi.on("cache_warming_decision", observe);

  pi.on("session_shutdown", async (event) => {
    try {
      await recorder?.record(event.type, event);
      await recorder?.close(event.reason);
    } finally {
      const currentViewer = viewer ?? await startingViewer?.catch(() => undefined);
      await currentViewer?.close();
      viewer = undefined;
    }
  });

  pi.registerCommand("looplog", {
    description: "打开本地 turn 记录；/looplog status 查看状态",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "status") {
        ctx.ui.notify([
          `记录状态：${startupError ? "error" : recorder?.status ?? "未启动"}`,
          `保存位置：${traceDirectory(ctx.cwd)}`,
          ...(startupError ? [`错误：${startupError}`] : []),
          `查看地址：${viewer?.url ?? "运行 /looplog 打开"}`,
        ].join("\n"), startupError ? "error" : "info");
        return;
      }
      if (command) { ctx.ui.notify("用法：/looplog 或 /looplog status", "warning"); return; }
      await recorder?.flush();
      try {
        startingViewer ??= startViewer(ctx.cwd).catch((error: unknown) => { startingViewer = undefined; throw error; });
        viewer = await startingViewer;
        const url = `${viewer.url}/?session=${encodeURIComponent(ctx.sessionManager.getSessionId())}`;
        ctx.ui.notify(`本地记录：${url}`, "info");
        try { await openBrowser(url); }
        catch { ctx.ui.notify(`请在浏览器打开：${url}`, "warning"); }
      } catch (error) { ctx.ui.notify(`查看器启动失败：${String(error)}`, "error"); }
    },
  });

  pi.registerCommand("devtest", {
    description: "Test development extension",
    handler: async (args, ctx) => {
      ctx.ui.notify(`devtest: ${args || "hello"}`, "info");
    },
  });
}
