import { randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface TraceRecord {
  schemaVersion: 1;
  recorderId: string;
  sessionId: string;
  taskId?: string;
  runId?: string;
  turnId?: string;
  seq: number;
  timestamp: string;
  elapsedMs: number;
  type: string;
  data: unknown;
}

export interface RecorderState {
  recorderId: string;
  sessionId: string;
  pid: number;
  updatedAt: string;
  status: "recording" | "closed" | "error";
  error?: string;
}

export function traceDirectory(project: string): string {
  return join(resolve(project), ".pi", "loop-in-loop");
}

// The event can contain repeated object references, not just JSON values. Only
// true cycles are replaced; repeated snapshots remain complete.
export function serialize(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value, function (_key, current: unknown) {
    if (typeof current === "bigint") return { $type: "bigint", value: String(current) };
    if (current instanceof Error) return { name: current.name, message: current.message, stack: current.stack };
    if (current instanceof AbortSignal) return { aborted: current.aborted, reason: current.reason };
    if (current && typeof current === "object") {
      while (ancestors.length && ancestors.at(-1) !== this) ancestors.pop();
      if (ancestors.includes(current)) return { $type: "circular" };
      ancestors.push(current);
    }
    return current;
  });
}

export function modelMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  return Object.fromEntries([
    "id", "name", "api", "provider", "reasoning", "contextWindow", "maxTokens",
    "cost", "input", "thinkingLevelMap",
  ].filter((key) => model[key] !== undefined).map((key) => [key, model[key]]));
}

export function observableEvent(event: { type: string; [key: string]: unknown }): unknown {
  if (event.type === "model_select") {
    return { ...event, model: modelMetadata(event.model), previousModel: modelMetadata(event.previousModel) };
  }
  if (event.type === "after_provider_response") {
    const headers = event.headers as Record<string, string>;
    return {
      ...event,
      headers: Object.fromEntries(Object.entries(headers).filter(([key]) =>
        !/^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key)$/i.test(key))),
    };
  }
  return event;
}

interface RecorderOptions {
  project: string;
  sessionId: string;
  onError?: (error: Error) => void;
  maxPendingBytes?: number;
  // Injectable only for deterministic disk-failure tests.
  write?: (file: FileHandle, line: string) => Promise<void>;
}

export class TraceRecorder {
  readonly recorderId = randomUUID();
  readonly sessionId: string;
  readonly directory: string;
  readonly filePath: string;
  private readonly statePath: string;
  private readonly options: RecorderOptions;
  private file?: FileHandle;
  private tail: Promise<void> = Promise.resolve();
  private pendingBytes = 0;
  private seq = 0;
  private started = performance.now();
  private timer?: ReturnType<typeof setInterval>;
  private stateTail: Promise<void> = Promise.resolve();
  private closing = false;
  private closed = false;
  private failure?: Error;
  private taskId?: string;
  private runId?: string;
  private turnId?: string;

  constructor(options: RecorderOptions) {
    this.options = options;
    this.sessionId = options.sessionId;
    // Encode untrusted session IDs as one segment, including "." and "..".
    this.directory = join(traceDirectory(options.project), Buffer.from(options.sessionId).toString("base64url"));
    this.filePath = join(this.directory, `${this.recorderId}.jsonl`);
    this.statePath = join(this.directory, `${this.recorderId}.state.json`);
  }

  get status(): "recording" | "closed" | "error" {
    return this.failure ? "error" : this.closed ? "closed" : "recording";
  }

  get error(): string | undefined { return this.failure?.message; }

  async start(metadata: unknown): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      this.file = await open(this.filePath, "ax", 0o600);
      await this.record("recorder_start", metadata);
      await this.flush();
      if (this.failure) throw this.failure;
      await this.writeState();
      this.timer = setInterval(() => { void this.writeState(); }, 5000);
      this.timer.unref();
    } catch (error) {
      this.fail(error);
      await this.file?.close().catch(() => {});
      this.file = undefined;
      throw this.failure;
    }
  }

  async record(type: string, data: unknown): Promise<void> {
    if (this.closed || this.closing || this.failure || !this.file) return;
    if (type === "before_agent_start") {
      this.taskId = randomUUID();
      this.runId = undefined;
      this.turnId = undefined;
    } else if (type === "agent_start") {
      this.taskId ??= randomUUID();
      this.runId = randomUUID();
      this.turnId = undefined;
    } else if (type === "turn_start") {
      this.taskId ??= randomUUID();
      this.runId ??= randomUUID();
      this.turnId = randomUUID();
    }

    let line: string;
    try {
      // Serialize synchronously, before the provider mutates its partial message.
      line = serialize({
        schemaVersion: 1,
        recorderId: this.recorderId,
        sessionId: this.sessionId,
        ...(this.taskId ? { taskId: this.taskId } : {}),
        ...(this.runId ? { runId: this.runId } : {}),
        ...(this.turnId ? { turnId: this.turnId } : {}),
        seq: ++this.seq,
        timestamp: new Date().toISOString(),
        elapsedMs: performance.now() - this.started,
        type,
        data,
      } satisfies TraceRecord) + "\n";
    } catch (error) {
      this.fail(error);
      return;
    }

    if (type === "turn_end") this.turnId = undefined;
    if (type === "agent_end") { this.runId = undefined; this.turnId = undefined; }
    if (type === "agent_settled") { this.taskId = undefined; this.runId = undefined; this.turnId = undefined; }

    const bytes = Buffer.byteLength(line);
    this.pendingBytes += bytes;
    this.tail = this.tail.then(async () => {
      if (this.failure || !this.file) return;
      if (this.options.write) await this.options.write(this.file, line);
      else await this.file.writeFile(line);
    }).catch((error: unknown) => { this.fail(error); }).finally(() => { this.pendingBytes -= bytes; });

    // One very large event is allowed, but the queue cannot grow without bound.
    if (this.pendingBytes >= (this.options.maxPendingBytes ?? 2 * 1024 * 1024)) await this.tail;
    if (type === "turn_end" || type === "agent_settled") await this.flush(type === "agent_settled");
  }

  async flush(sync = false): Promise<void> {
    await this.tail;
    if (sync && this.file && !this.failure) {
      try { await this.file.datasync(); } catch (error) { this.fail(error); }
    }
  }

  async close(reason = "quit"): Promise<void> {
    if (this.closed || this.closing) return;
    await this.record("recorder_stop", { reason });
    this.closing = true;
    if (this.timer) clearInterval(this.timer);
    await this.flush(true);
    try { await this.file?.close(); } catch (error) { this.fail(error); }
    this.file = undefined;
    this.closed = true;
    await this.writeState();
  }

  private fail(value: unknown): void {
    if (this.failure) return;
    this.failure = value instanceof Error ? value : new Error(String(value));
    this.options.onError?.(this.failure);
    void this.writeState();
  }

  private writeState(): Promise<void> {
    // Serialize state updates to avoid heartbeat/shutdown rename races.
    this.stateTail = this.stateTail.then(async () => {
      const state: RecorderState = {
        recorderId: this.recorderId,
        sessionId: this.sessionId,
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        status: this.status,
        ...(this.error ? { error: this.error } : {}),
      };
      const temporary = `${this.statePath}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, this.statePath);
    }).catch((error: unknown) => {
      if (!this.failure) {
        this.failure = error instanceof Error ? error : new Error(String(error));
        this.options.onError?.(this.failure);
      }
    });
    return this.stateTail;
  }
}
