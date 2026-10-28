import { createReadStream } from "node:fs";
import { open, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { traceDirectory } from "./trace.ts";
import type { RecorderState, TraceRecord } from "./trace.ts";

// Pi and custom tools may add arbitrary JSON fields. Narrow at this boundary,
// keeping the opaque payload on disk instead of retaining it in the index.
export function object(value: unknown): Record<string, any> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : {};
}

function messageText(value: unknown): string {
  const message = object(value);
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content.map((part: unknown) => {
    const content = object(part);
    return content.text ?? content.thinking ?? (content.name ? `[${content.name}]` : "");
  }).join("\n");
}

export interface UsageView {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost?: number;
}

function usageView(value: unknown): UsageView | undefined {
  const usage = object(value);
  if (typeof usage.totalTokens !== "number") return undefined;
  return {
    input: usage.input ?? 0,
    output: usage.output ?? 0,
    cacheRead: usage.cacheRead ?? 0,
    cacheWrite: usage.cacheWrite ?? 0,
    ...(typeof usage.reasoning === "number" ? { reasoning: usage.reasoning } : {}),
    totalTokens: usage.totalTokens,
    ...(typeof usage.cost?.total === "number" ? { cost: usage.cost.total } : {}),
  };
}

export interface ToolView {
  id: string;
  name: string;
  parentId?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  startEventId?: string;
  endEventId?: string;
}

export interface TurnView {
  id: string;
  recorderId: string;
  runId?: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  model?: string;
  provider?: string;
  thinkingLevel?: string;
  stopReason?: string;
  status: string;
  usage?: UsageView;
  messageEventId?: string;
  inputs: { text: string; eventId: string }[];
  tools: ToolView[];
}

interface InternalTurn extends TurnView { startedElapsed: number; }

export interface TaskView {
  id: string;
  recorderId: string;
  prompt: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: string;
  turns: TurnView[];
}

interface InternalTask extends Omit<TaskView, "turns"> { startedElapsed: number; turns: InternalTurn[]; }

export interface EventView {
  id: string;
  recorderId: string;
  seq: number;
  timestamp: string;
  type: string;
  taskId?: string;
  runId?: string;
  turnId?: string;
  preview: string;
  toolName?: string;
  isError: boolean;
}

interface EventRef extends EventView { path: string; offset: number; length: number; }
interface FileIndex { path: string; offset: number; recorderId: string; sessionId?: string; stopped: boolean; }
interface SessionIndex {
  id: string;
  name?: string;
  cwd?: string;
  startedAt: string;
  updatedAt: string;
  metadataAt: string;
  events: EventRef[];
  tasks: Map<string, InternalTask>;
  turns: Map<string, InternalTurn>;
  tools: Map<string, ToolView>;
  files: Set<string>;
}

export interface EventQuery {
  turnId?: string;
  category?: string;
  type?: string;
  tool?: string;
  q?: string;
  errors?: boolean;
  before?: string;
  limit?: number;
}

const categories: Record<string, Set<string>> = {
  messages: new Set(["input", "before_agent_start", "message_start", "message_end"]),
  context: new Set(["recorder_start", "before_agent_start", "context", "context_with_system", "before_provider_request", "after_provider_response"]),
  tools: new Set(["tool_execution_start", "tool_call", "tool_execution_update", "tool_result", "tool_execution_end"]),
};

function preview(record: TraceRecord): string {
  const data = object(record.data);
  return String(data.prompt ?? data.text ?? data.toolName ?? data.errorMessage ??
    messageText(data.message) ?? "").replace(/\s+/g, " ").slice(0, 160);
}

function publicEvent(ref: EventRef): EventView {
  const { path: _path, offset: _offset, length: _length, ...view } = ref;
  return view;
}

export class TraceStore {
  readonly directory: string;
  revision = 0;
  private files = new Map<string, FileIndex>();
  private sessions = new Map<string, SessionIndex>();
  private refs = new Map<string, EventRef>();
  private states = new Map<string, RecorderState>();
  private refreshing?: Promise<boolean>;
  private activeSignature = "";

  constructor(project: string) { this.directory = traceDirectory(project); }

  refresh(): Promise<boolean> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = this.scan().finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private async scan(): Promise<boolean> {
    let changed = false;
    let folders;
    try { folders = await readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    for (const folder of folders) {
      if (!folder.isDirectory()) continue;
      const directory = join(this.directory, folder.name);
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        const path = join(directory, entry.name);
        if (entry.name.endsWith(".state.json")) {
          try {
            const state = JSON.parse(await readFile(path, "utf8")) as RecorderState;
            if (!state.recorderId || !state.updatedAt) continue;
            const previous = this.states.get(state.recorderId);
            if (previous?.status !== state.status || previous?.error !== state.error) changed = true;
            this.states.set(state.recorderId, state);
          } catch (error) {
            if (!((error instanceof SyntaxError) || (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
          }
        }
        if (!entry.name.endsWith(".jsonl")) continue;
        let file = this.files.get(path);
        if (!file) {
          file = { path, offset: 0, recorderId: entry.name.slice(0, -6), stopped: false };
          this.files.set(path, file);
        }
        const size = (await stat(path)).size;
        if (size <= file.offset) continue;
        // Do not commit an incomplete trailing line; read it again after append.
        let pending: Buffer = Buffer.alloc(0);
        for await (const chunk of createReadStream(path, { start: file.offset, end: size - 1 })) {
          pending = pending.length ? Buffer.concat([pending, chunk as Buffer]) : chunk as Buffer;
          let newline: number;
          let consumed = 0;
          while ((newline = pending.indexOf(10, consumed)) !== -1) {
            const bytes = pending.subarray(consumed, newline);
            const length = newline - consumed + 1;
            try {
              const record = JSON.parse(bytes.toString("utf8")) as TraceRecord;
              if (record.schemaVersion !== 1 || typeof record.seq !== "number" || typeof record.sessionId !== "string") {
                throw new Error(`不支持的日志格式：${path}:${file.offset}`);
              }
              if (record.recorderId !== file.recorderId || (file.sessionId && file.sessionId !== record.sessionId)) {
                throw new Error(`日志实例标识不一致：${path}:${file.offset}`);
              }
              file.sessionId = record.sessionId;
              this.apply(record, path, file.offset, length);
              if (record.type === "recorder_stop") file.stopped = true;
              changed = true;
            } catch (error) {
              // Only the unterminated last line is tolerated. Corrupt complete
              // lines are surfaced instead of silently losing records.
              throw new Error(`无法读取日志 ${path}（字节 ${file.offset}）：${String(error)}`);
            }
            file.offset += length;
            consumed = newline + 1;
          }
          pending = pending.subarray(consumed);
        }
      }
    }
    const signature = [...this.files.values()].map((file) => `${file.recorderId}:${this.isActive(file.recorderId)}`).join(",");
    if (signature !== this.activeSignature) { changed = true; this.activeSignature = signature; }
    if (changed) this.revision++;
    return changed;
  }

  private isActive(recorderId: string): boolean {
    if ([...this.files.values()].some((file) => file.recorderId === recorderId && file.stopped)) return false;
    const state = this.states.get(recorderId);
    return state?.status === "recording" && Date.now() - Date.parse(state.updatedAt) < 15000;
  }

  private apply(record: TraceRecord, path: string, offset: number, length: number): void {
    const id = `${record.recorderId}:${record.seq}`;
    if (this.refs.has(id)) return;
    const data = object(record.data);
    let session = this.sessions.get(record.sessionId);
    if (!session) {
      session = {
        id: record.sessionId, startedAt: record.timestamp, updatedAt: record.timestamp, metadataAt: "",
        events: [], tasks: new Map(), turns: new Map(), tools: new Map(), files: new Set(),
      };
      this.sessions.set(record.sessionId, session);
    }
    session.files.add(path);
    if (record.timestamp < session.startedAt) session.startedAt = record.timestamp;
    if (record.timestamp > session.updatedAt) session.updatedAt = record.timestamp;
    if (record.type === "recorder_start" && record.timestamp >= session.metadataAt) {
      session.name = typeof data.sessionName === "string" ? data.sessionName : undefined;
      session.cwd = data.cwd ?? session.cwd;
      session.metadataAt = record.timestamp;
    }
    if (record.type === "session_info_changed" && record.timestamp >= session.metadataAt) {
      session.name = data.name;
      session.metadataAt = record.timestamp;
    }
    const ref: EventRef = {
      id, recorderId: record.recorderId, seq: record.seq, timestamp: record.timestamp,
      type: record.type, taskId: record.taskId, runId: record.runId, turnId: record.turnId,
      preview: preview(record), toolName: data.toolName,
      isError: Boolean(data.isError || data.errorMessage || data.outcome === "error" ||
        data.message?.stopReason === "error" || record.type === "session_compact_failed" ||
        (record.type === "after_provider_response" && data.status >= 400)),
      path, offset, length,
    };
    session.events.push(ref);
    this.refs.set(id, ref);

    let task: InternalTask | undefined;
    if (record.taskId) {
      task = session.tasks.get(record.taskId);
      if (!task) {
        task = {
          id: record.taskId, recorderId: record.recorderId, prompt: "恢复中的任务",
          startedAt: record.timestamp, startedElapsed: record.elapsedMs, status: "running", turns: [],
        };
        session.tasks.set(task.id, task);
      }
      if (record.type === "before_agent_start") task.prompt = String(data.prompt ?? (messageText(data.message) || "扩展触发的任务")).slice(0, 240);
      if (record.type === "agent_settled") {
        task.endedAt = record.timestamp;
        task.durationMs = record.elapsedMs - task.startedElapsed;
        task.status = data.aborted ? "aborted" : task.turns.at(-1)?.status === "error" ? "error" : "completed";
      }
    }
    let turn: InternalTurn | undefined;
    if (record.turnId && task) {
      turn = session.turns.get(record.turnId);
      if (!turn) {
        turn = {
          id: record.turnId, recorderId: record.recorderId, runId: record.runId,
          index: typeof data.turnIndex === "number" ? data.turnIndex : task.turns.length,
          startedAt: record.timestamp, startedElapsed: record.elapsedMs, status: "running", tools: [], inputs: [],
        };
        session.turns.set(turn.id, turn);
        task.turns.push(turn);
      }
      if (record.type === "message_start" && data.message?.role === "user") {
        turn.inputs.push({ text: messageText(data.message).slice(0, 200), eventId: id });
      }
      const message = object(data.message);
      if ((record.type === "message_end" || record.type === "turn_end") && message.role === "assistant") {
        turn.model = message.model;
        turn.provider = message.provider;
        turn.thinkingLevel = message.thinkingLevel ?? message.providerThinkingLevel;
        turn.stopReason = message.stopReason;
        turn.usage = usageView(message.usage);
        turn.messageEventId = id;
      }
      if (record.type === "turn_end") {
        turn.status = data.outcome ?? (message.stopReason === "error" ? "error" : message.stopReason === "aborted" ? "aborted" : "completed");
        turn.endedAt = record.timestamp;
        turn.durationMs = record.elapsedMs - turn.startedElapsed;
      }
    }
    if (turn && typeof data.toolCallId === "string" && record.type.startsWith("tool_")) {
      const toolKey = `${record.recorderId}:${data.toolCallId}`;
      let tool = session.tools.get(toolKey);
      if (!tool) {
        tool = { id: data.toolCallId, name: data.toolName ?? "tool", parentId: data.parentToolCallId, status: "running", startedAt: record.timestamp };
        session.tools.set(toolKey, tool);
        turn.tools.push(tool);
      }
      if (record.type === "tool_execution_start") tool.startEventId = id;
      if (record.type === "tool_execution_end") {
        tool.endEventId = id;
        tool.endedAt = record.timestamp;
        tool.durationMs = data.durationMs ?? Date.parse(record.timestamp) - Date.parse(tool.startedAt);
        tool.status = data.isError ? "error" : "completed";
      }
    }
  }

  listSessions(): object[] {
    return [...this.sessions.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((session) => {
      const view = this.sessionView(session);
      const { tasks: _tasks, ...summary } = view;
      return { ...summary, taskCount: session.tasks.size, turnCount: session.turns.size };
    });
  }

  getSession(id: string): ReturnType<TraceStore["sessionView"]> | undefined {
    const session = this.sessions.get(id);
    return session ? this.sessionView(session) : undefined;
  }

  private sessionView(session: SessionIndex) {
    const recorderIds = new Set([...session.files].map((path) => this.files.get(path)!.recorderId));
    const active = [...recorderIds].some((id) => this.isActive(id));
    const errors = [...recorderIds].map((id) => this.states.get(id)?.error).filter(Boolean);
    const state = (status: string, recorderId: string) => status === "running" && !this.isActive(recorderId) ? "interrupted" : status;
    const tasks: TaskView[] = [...session.tasks.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt)).map((task) => {
      const { startedElapsed: _elapsed, turns, ...rest } = task;
      return {
        ...rest, status: state(task.status, task.recorderId),
        turns: turns.map((turn) => {
          const { startedElapsed: _start, tools, ...restTurn } = turn;
          return { ...restTurn, status: state(turn.status, turn.recorderId), tools: tools.map((tool) => ({ ...tool, status: state(tool.status, turn.recorderId) })) };
        }),
      };
    });
    const usages = tasks.flatMap((task) => task.turns.flatMap((turn) => turn.usage ? [turn.usage] : []));
    const total = usages.reduce((sum, usage) => ({
      input: sum.input + usage.input, output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite,
      totalTokens: sum.totalTokens + usage.totalTokens,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 });
    const lastTask = tasks.at(-1);
    return {
      id: session.id, name: session.name, cwd: session.cwd, startedAt: session.startedAt, updatedAt: session.updatedAt,
      prompt: lastTask?.prompt, status: errors.length ? "error" : active ? lastTask?.status === "running" ? "running" : "idle" : lastTask?.status ?? "closed",
      active, errors, eventCount: session.events.length, tasks,
      usage: usages.length ? { ...total, ...(usages.every((usage) => usage.cost !== undefined) ? { cost: usages.reduce((sum, usage) => sum + usage.cost!, 0) } : {}) } : undefined,
      durationMs: tasks.reduce((sum, task) => sum + (task.durationMs ?? 0), 0),
    };
  }

  async getEvent(sessionId: string, id: string): Promise<TraceRecord | undefined> {
    const ref = this.refs.get(id);
    if (!ref || !this.sessions.get(sessionId)?.files.has(ref.path)) return undefined;
    const file = await open(ref.path, "r");
    try {
      const buffer = Buffer.alloc(ref.length);
      let read = 0;
      while (read < buffer.length) {
        const result = await file.read(buffer, read, buffer.length - read, ref.offset + read);
        if (!result.bytesRead) throw new Error("日志在读取期间被截断");
        read += result.bytesRead;
      }
      return JSON.parse(buffer.toString("utf8")) as TraceRecord;
    } finally { await file.close(); }
  }

  async getEvents(sessionId: string, query: EventQuery = {}): Promise<{ items: EventView[]; nextCursor: string | null } | undefined> {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;
    const ordered = [...session.events].sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.recorderId.localeCompare(b.recorderId) || a.seq - b.seq);
    let index = query.before ? ordered.findIndex((ref) => ref.id === query.before) - 1 : ordered.length - 1;
    const items: EventView[] = [];
    const limit = Math.min(100, Math.max(1, query.limit ?? 40));
    const category = query.category ? categories[query.category] : undefined;
    for (; index >= 0; index--) {
      const ref = ordered[index];
      if (query.turnId && ref.turnId !== query.turnId) continue;
      if (category && !category.has(ref.type)) continue;
      if (query.type && ref.type !== query.type) continue;
      if (query.tool && !ref.toolName?.toLowerCase().includes(query.tool.toLowerCase())) continue;
      if (query.errors && !ref.isError) continue;
      if (query.q) {
        const event = await this.getEvent(sessionId, ref.id);
        if (!JSON.stringify(event).toLowerCase().includes(query.q.toLowerCase())) continue;
      }
      items.push(publicEvent(ref));
      if (items.length >= limit) break;
    }
    return { items, nextCursor: index > 0 && items.length ? items.at(-1)!.id : null };
  }

  exportFiles(sessionId: string): { path: string; bytes: number }[] | undefined {
    const session = this.sessions.get(sessionId);
    return session ? [...session.files].map((path) => ({ path, bytes: this.files.get(path)!.offset })) : undefined;
  }
}
