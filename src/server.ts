import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TraceStore } from "./store.ts";

export interface Viewer {
  url: string;
  close(): Promise<void>;
}

export async function startViewer(project: string): Promise<Viewer> {
  const store = new TraceStore(project);
  await store.refresh();
  const assets = join(dirname(fileURLToPath(import.meta.url)), "web");
  const clients = new Set<ServerResponse>();
  let baseUrl = "";
  let refreshError: string | undefined;
  let stopping = false;

  const json = (response: ServerResponse, status: number, data: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(data));
  };
  const broadcast = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      // SSE carries invalidations, never the trace. Slow clients reconnect and
      // fetch a snapshot instead of buffering an unbounded event history.
      if (!client.write(frame)) { client.destroy(); clients.delete(client); }
    }
  };
  const refresh = async () => {
    try {
      const changed = await store.refresh();
      const recovered = Boolean(refreshError);
      refreshError = undefined;
      if (changed || recovered) broadcast("change", { revision: store.revision });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== refreshError) broadcast("trace-error", { error: message });
      refreshError = message;
    }
  };

  const server = createServer((request, response) => {
    void (async () => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
      // Keep project traces inaccessible to cross-origin pages and reject DNS rebinding.
      if (request.headers.host !== new URL(baseUrl).host ||
        (request.headers.origin && request.headers.origin !== baseUrl)) {
        json(response, 403, { error: "只允许本地查看器访问" });
        return;
      }
      if (request.method !== "GET") { json(response, 405, { error: "只支持 GET" }); return; }
      const url = new URL(request.url ?? "/", baseUrl);
      const staticFiles: Record<string, [string, string]> = {
        "/": ["index.html", "text/html; charset=utf-8"],
        "/app.js": ["app.js", "text/javascript; charset=utf-8"],
        "/style.css": ["style.css", "text/css; charset=utf-8"],
      };
      const asset = staticFiles[url.pathname];
      if (asset) {
        response.writeHead(200, { "Content-Type": asset[1] });
        response.end(await readFile(join(assets, asset[0])));
        return;
      }
      if (url.pathname === "/api/live") {
        response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive", "X-Accel-Buffering": "no" });
        response.write(`retry: 1000\nevent: change\ndata: ${JSON.stringify({ revision: store.revision })}\n\n`);
        if (refreshError) response.write(`event: trace-error\ndata: ${JSON.stringify({ error: refreshError })}\n\n`);
        clients.add(response);
        request.on("close", () => { clients.delete(response); });
        return;
      }
      await refresh();
      if (refreshError) { json(response, 500, { error: refreshError }); return; }
      if (url.pathname === "/api/sessions") {
        json(response, 200, { project: resolve(project), sessions: store.listSessions() });
        return;
      }
      const match = /^\/api\/sessions\/([^/]+)(?:\/(events|event|download))?$/.exec(url.pathname);
      if (!match) { json(response, 404, { error: "页面不存在" }); return; }
      const id = decodeURIComponent(match[1]);
      if (!store.getSession(id)) { json(response, 404, { error: "会话不存在" }); return; }
      if (!match[2]) { json(response, 200, store.getSession(id)); return; }
      if (match[2] === "event") {
        const event = await store.getEvent(id, url.searchParams.get("id") ?? "");
        json(response, event ? 200 : 404, event ?? { error: "事件不存在" });
        return;
      }
      if (match[2] === "events") {
        const params = url.searchParams;
        const limit = Number(params.get("limit") ?? 40);
        json(response, 200, await store.getEvents(id, {
          turnId: params.get("turn") ?? undefined, category: params.get("category") ?? undefined,
          type: params.get("type") ?? undefined, tool: params.get("tool") ?? undefined,
          q: params.get("q") ?? undefined, before: params.get("before") ?? undefined,
          errors: params.get("errors") === "true", limit: Number.isFinite(limit) ? limit : 40,
        }));
        return;
      }
      response.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Content-Disposition": `attachment; filename="looplog-${encodeURIComponent(id)}.jsonl"`,
      });
      // Each fragment keeps its recorderId and seq. Omit an unterminated crash tail.
      for (const file of store.exportFiles(id)!) {
        if (file.bytes === 0) continue;
        for await (const chunk of createReadStream(file.path, { start: 0, end: file.bytes - 1 })) {
          if (response.destroyed) return;
          if (!response.write(chunk)) await new Promise<void>((done) => {
            const finish = () => { response.off("drain", finish); response.off("close", finish); done(); };
            response.once("drain", finish);
            response.once("close", finish);
          });
        }
      }
      response.end();
    })().catch((error: unknown) => {
      if (response.headersSent) response.destroy();
      else json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("无法取得本地查看地址");
  baseUrl = `http://127.0.0.1:${address.port}`;
  const poll = setInterval(() => { if (!stopping) void refresh(); }, 750);
  const heartbeat = setInterval(() => { broadcast("heartbeat", {}); }, 10000);
  poll.unref();
  heartbeat.unref();
  return {
    url: baseUrl,
    async close() {
      if (stopping) return;
      stopping = true;
      clearInterval(poll);
      clearInterval(heartbeat);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise<void>((done, reject) => { server.close((error) => error ? reject(error) : done()); server.closeIdleConnections(); });
    },
  };
}
