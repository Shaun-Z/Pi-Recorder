const $ = (id) => document.getElementById(id);
const labels = { running: "执行中", idle: "待命", completed: "已完成", aborted: "已取消", error: "错误", interrupted: "已中断", closed: "已关闭" };
const state = {
  sessions: [], sessionId: new URLSearchParams(location.search).get("session"), session: null,
  turnId: null, category: "", events: [], cursor: null, expanded: new Set(), cache: new Map(), epoch: 0,
};
const number = (value) => value === undefined ? "未提供" : new Intl.NumberFormat("zh-CN").format(value);
const duration = (value) => value === undefined ? "未提供" : value < 1000 ? `${Math.round(value)} ms` : value < 60000 ? `${(value / 1000).toFixed(1)} s` : `${(value / 60000).toFixed(1)} min`;
const time = (value) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const empty = (parent, text) => parent.replaceChildren(el("p", "empty", text));
const badge = (status) => el("span", `badge ${status}`, labels[status] ?? status);
function showError(message) { $("error").hidden = !message; $("error").textContent = message ?? ""; }
async function api(path) {
  const response = await fetch(path);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `读取失败（${response.status}）`);
  return data;
}
const sessionPath = () => `/api/sessions/${encodeURIComponent(state.sessionId)}`;

function renderSessions() {
  $("session-count").textContent = state.sessions.length;
  const query = $("session-search").value.toLowerCase();
  const sessions = state.sessions.filter((session) => JSON.stringify(session).toLowerCase().includes(query));
  $("sessions").replaceChildren();
  if (!sessions.length) { empty($("sessions"), query ? "没有匹配的会话。" : "还没有记录。加载插件后，发送一个任务即可开始。"); return; }
  for (const session of sessions) {
    const button = el("button", `session-item ${session.id === state.sessionId ? "selected" : ""}`);
    button.append(el("span", "name", session.name || session.prompt || "新会话"), el("time", "", time(session.updatedAt)));
    const meta = el("span", "meta");
    meta.append(badge(session.status), el("span", "", `${session.turnCount} turn`), el("span", "", `${number(session.usage?.totalTokens ?? 0)} token`));
    button.append(meta);
    button.addEventListener("click", () => { void selectSession(session.id); });
    $("sessions").append(button);
  }
}

async function selectSession(id) {
  state.sessionId = id;
  state.turnId = null;
  state.expanded.clear();
  state.cache.clear();
  history.replaceState(null, "", `?session=${encodeURIComponent(id)}`);
  renderSessions();
  await refreshSession(true);
}

function renderSession() {
  const session = state.session;
  $("session-title").textContent = session.name || session.prompt || "新会话";
  $("session-meta").textContent = `${session.id} · ${session.eventCount} 个事件 · ${time(session.startedAt)}`;
  $("session-state").className = `badge ${session.status}`;
  $("session-state").textContent = labels[session.status] ?? session.status;
  $("stat-turns").textContent = number(session.tasks.reduce((sum, task) => sum + task.turns.length, 0));
  $("stat-tokens").textContent = session.usage ? number(session.usage.totalTokens) : "—";
  $("stat-duration").textContent = duration(session.durationMs);
  $("stat-cost").textContent = session.usage?.cost === undefined ? "未提供" : `$${session.usage.cost.toFixed(5)}`;
  $("stat-tokens").title = session.usage ? `输入 ${number(session.usage.input)} · 输出 ${number(session.usage.output)} · 缓存读取 ${number(session.usage.cacheRead)} · 缓存写入 ${number(session.usage.cacheWrite)}` : "未提供";
  $("download").hidden = false;
  $("download").href = `${sessionPath()}/download`;
  if (session.errors.length) showError(`记录器错误：${session.errors.join("；")}`);
  renderTimeline();
}

function renderTimeline() {
  $("timeline").replaceChildren();
  if (!state.session.tasks.length) { empty($("timeline"), "会话已加载。等待新的任务…\n启用前的上下文可在“上下文 / 请求”查看。"); return; }
  state.session.tasks.forEach((task, taskIndex) => {
    const section = el("article", "task");
    const heading = el("div", "task-heading");
    heading.append(el("span", "number", String(taskIndex + 1).padStart(2, "0")), el("span", "prompt", task.prompt), badge(task.status));
    section.append(heading);
    task.turns.forEach((turn, turnIndex) => {
      const row = el("div", `turn ${turn.status}`);
      const button = el("button", `turn-card ${state.turnId === turn.id ? "selected" : ""}`);
      const top = el("div", "turn-top");
      top.append(el("strong", "", `Turn ${turnIndex + 1}`), badge(turn.status));
      const bottom = el("div", "turn-bottom");
      const model = el("span", "model", turn.model ?? "等待模型响应");
      model.title = `${turn.provider ?? ""}/${turn.model ?? ""} · thinking ${turn.thinkingLevel ?? "未提供"} · 停止原因 ${turn.stopReason ?? "未提供"} · Pi turnIndex ${turn.index}`;
      bottom.append(model, el("span", "", `${turn.usage ? `${number(turn.usage.totalTokens)} tok · ` : ""}${duration(turn.durationMs)}`));
      button.append(top, bottom);
      const toolMs = turn.tools.filter((tool) => !tool.parentId).reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
      if (turn.durationMs > 0) {
        const track = el("div", "track");
        const fraction = Math.min(1, toolMs / turn.durationMs);
        const modelPart = el("span", "model-time");
        modelPart.style.width = `${(1 - fraction) * 100}%`;
        const toolPart = el("span", "tool-time");
        toolPart.style.width = `${fraction * 100}%`;
        track.append(modelPart, toolPart);
        button.append(track, el("div", "track-label", "蓝：模型与等待 · 绿：工具累计耗时（并行调用可能重叠）"));
      }
      button.addEventListener("click", () => { state.turnId = turn.id; renderTimeline(); void loadEvents(); });
      row.append(button);
      for (const input of turn.inputs) row.append(el("div", "input-note", `↳ 输入进入此 turn：${input.text}`));
      for (const tool of turn.tools) {
        const toolButton = el("button", `tool-row ${tool.status}`);
        let depth = 0;
        let parent = tool.parentId;
        const visited = new Set([tool.id]);
        while (parent && !visited.has(parent)) { visited.add(parent); depth++; parent = turn.tools.find((candidate) => candidate.id === parent)?.parentId; }
        toolButton.style.paddingLeft = `${depth * 14 + 2}px`;
        toolButton.append(el("span", "", tool.parentId ? "└" : "↳"), el("span", "tool-label", tool.name), el("span", "", duration(tool.durationMs)), badge(tool.status));
        toolButton.addEventListener("click", () => {
          state.turnId = turn.id;
          state.category = "tools";
          state.expanded.add(tool.endEventId ?? tool.startEventId);
          renderTimeline();
          renderTabs();
          void loadEvents();
        });
        row.append(toolButton);
      }
      section.append(row);
    });
    $("timeline").append(section);
  });
}

function renderTabs() {
  document.querySelectorAll("[data-category]").forEach((button) => button.classList.toggle("selected", button.dataset.category === state.category));
}

async function loadEvents(more = false) {
  if (!state.sessionId) return;
  const epoch = ++state.epoch;
  const sessionId = state.sessionId;
  const path = sessionPath();
  const params = new URLSearchParams();
  if (state.turnId) params.set("turn", state.turnId);
  if (state.category) params.set("category", state.category);
  for (const [field, id] of [["q", "event-search"], ["type", "event-type"], ["tool", "tool-name"]]) {
    if ($(id).value.trim()) params.set(field, $(id).value.trim());
  }
  if ($("errors-only").checked) params.set("errors", "true");
  if (more && state.cursor) params.set("before", state.cursor);
  $("detail-title").textContent = state.turnId ? "当前 turn 详情" : "会话全部事件";
  $("event-count").textContent = "正在读取…";
  try {
    const result = await api(`${path}/events?${params}`);
    if (epoch !== state.epoch || sessionId !== state.sessionId) return;
    state.events = more ? [...state.events, ...result.items.filter((item) => !state.events.some((existing) => existing.id === item.id))] : result.items;
    state.cursor = result.nextCursor;
    renderEvents();
  } catch (error) { if (epoch === state.epoch) showError(error.message); }
}

function renderEvents() {
  $("events").replaceChildren();
  $("more").hidden = !state.cursor;
  $("event-count").textContent = `已显示 ${state.events.length} 个事件 · 最新在前 · 点击展开完整数据`;
  if (!state.events.length) { empty($("events"), "没有匹配的事件。可切换分类或清除筛选条件。"); return; }
  for (const event of state.events) {
    const article = el("article", `event ${event.isError ? "error" : ""}`);
    const button = el("button", "event-toggle");
    button.setAttribute("aria-expanded", String(state.expanded.has(event.id)));
    const meta = el("span", "event-meta");
    meta.append(el("span", "event-type", event.type), el("time", "", time(event.timestamp).split(" ").at(-1)));
    button.append(meta);
    if (event.preview) button.append(el("span", "event-preview", event.preview));
    const body = el("div", "event-body");
    body.hidden = !state.expanded.has(event.id);
    button.addEventListener("click", () => {
      if (state.expanded.has(event.id)) state.expanded.delete(event.id); else state.expanded.add(event.id);
      body.hidden = !state.expanded.has(event.id);
      button.setAttribute("aria-expanded", String(!body.hidden));
      if (!body.hidden) void loadDetail(event, body);
    });
    article.append(button, body);
    $("events").append(article);
    if (!body.hidden) void loadDetail(event, body);
  }
}

async function loadDetail(event, body) {
  body.replaceChildren(el("p", "loading", "读取完整数据…"));
  const projectSession = state.sessionId;
  try {
    let record = state.cache.get(event.id);
    if (!record) {
      record = await api(`${sessionPath()}/event?id=${encodeURIComponent(event.id)}`);
      if (state.cache.size >= 30) state.cache.delete(state.cache.keys().next().value);
      state.cache.set(event.id, record);
    }
    if (projectSession !== state.sessionId || !body.isConnected) return;
    body.replaceChildren();
    const add = (title, content) => { body.append(el("h3", "", title), el("pre", "", typeof content === "string" ? content : JSON.stringify(content, null, 2))); };
    const data = record.data ?? {};
    if (data.message) {
      add("消息角色", data.message.role ?? "未提供");
      if (typeof data.message.content === "string") add("内容", data.message.content);
      else for (const content of data.message.content ?? []) {
        if (content.type === "text") add("回复", content.text);
        else if (content.type === "thinking") add("Thinking（模型可见输出）", content.thinking ?? "未提供");
        else if (content.type === "toolCall") add(`工具调用 · ${content.name}`, content.arguments);
        else add(content.type ?? "内容", content);
      }
      if (data.message.usage) add("用量与费用估算", data.message.usage);
      if (data.message.errorMessage) add("错误", data.message.errorMessage);
    } else if (record.type === "before_provider_request") add("模型请求体（本插件观察时的快照）", data.payload);
    else if (record.type === "context_with_system" || record.type === "context") add(record.type === "context_with_system" ? "完整上下文（含系统消息和工具声明）" : "对话上下文", data.messages);
    else if (record.type === "before_agent_start") { add("任务输入", data.prompt ?? data.message ?? "未提供"); add("系统提示", data.systemPrompt ?? "未提供"); }
    else if (record.type === "input") add(data.streamingBehavior ? `追加输入 · ${data.streamingBehavior}` : "输入", data.text);
    else if (record.type.startsWith("tool_")) {
      if (data.args ?? data.input) add("工具参数", data.args ?? data.input);
      if (data.result ?? data.partialResult ?? data.content) add("工具输出", data.result ?? data.partialResult ?? data.content);
      if (data.durationMs !== undefined) add("工具耗时", duration(data.durationMs));
    } else add("事件数据", data);
    const details = el("details");
    details.append(el("summary", "", "完整原始 JSON（所有字段）"));
    details.addEventListener("toggle", () => { if (details.open && !details.querySelector("pre")) details.append(el("pre", "", JSON.stringify(record, null, 2))); });
    body.append(details);
  } catch (error) { body.replaceChildren(el("p", "loading", `读取失败：${error.message}`)); }
}

let refreshing = false;
let pendingRefresh = false;
async function refreshSession(force = false) {
  if (!state.sessionId) return;
  const selected = state.sessionId;
  try {
    const session = await api(sessionPath());
    if (selected !== state.sessionId) return;
    state.session = session;
    renderSession();
    if (force || $("follow").checked) await loadEvents();
  } catch (error) { showError(error.message); }
}
async function refresh(force = false) {
  if (refreshing) { pendingRefresh = true; return; }
  refreshing = true;
  try {
    const result = await api("/api/sessions");
    showError("");
    state.sessions = result.sessions;
    $("project").textContent = result.project;
    $("project").title = result.project;
    if (!state.sessions.some((session) => session.id === state.sessionId)) state.sessionId = state.sessions[0]?.id ?? null;
    renderSessions();
    if (state.sessionId) await refreshSession(force);
  } catch (error) { showError(error.message); }
  finally { refreshing = false; if (pendingRefresh) { pendingRefresh = false; void refresh(); } }
}
function debounce(fn) { let timer; return () => { clearTimeout(timer); timer = setTimeout(fn, 250); }; }
$("session-search").addEventListener("input", renderSessions);
$("refresh").addEventListener("click", () => { void refresh(true); });
$("all-events").addEventListener("click", () => { state.turnId = null; renderTimeline(); void loadEvents(); });
$("more").addEventListener("click", () => { $("follow").checked = false; void loadEvents(true); });
$("follow").addEventListener("change", () => { if ($("follow").checked) void loadEvents(); });
for (const id of ["event-search", "event-type", "tool-name"]) $(id).addEventListener("input", debounce(() => { void loadEvents(); }));
$("errors-only").addEventListener("change", () => { void loadEvents(); });
document.querySelectorAll("[data-category]").forEach((button) => button.addEventListener("click", () => { state.category = button.dataset.category; renderTabs(); void loadEvents(); }));
const source = new EventSource("/api/live");
source.onopen = () => { $("connection").textContent = "● 实时已连接"; $("connection").className = "online"; };
source.onerror = () => { $("connection").textContent = "连接中断，正在重连…"; $("connection").className = ""; };
source.addEventListener("change", () => { void refresh(); });
source.addEventListener("trace-error", (event) => { showError(JSON.parse(event.data).error); });
void refresh(true);
