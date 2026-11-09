// Monitor: who works on what (task -> pattern run -> agents) and what they say to each other.
// It is a panel tab and, opened with ?view=monitor, the whole content of its own window.
// Messages are read from the bus by sender/receiver (topic names are shared by every run).
let mo = { tree: [], sel: null, focus: window.__view?.focus ?? null, feed: [], feedError: "", filterAgent: "", text: "", paused: false, ui: null, listening: false };

const inMonitorWindow = () => window.__view?.view === "monitor";
const allAgents = (g) => [...new Map([...g.direct, ...g.runs.flatMap((r) => r.agents)].map((a) => [a.id, a])).values()];
// "run-…" (what a window is opened with) and "task:N" / "agent:ID" are the same keys the list uses.
const monitorKey = (focus) => (!focus ? null : focus.startsWith("run-") ? `run:${focus}` : focus);

function scopeOf(key) {
  if (!key) return null;
  const [kind, ...rest] = key.split(":"), id = rest.join(":");
  for (const g of mo.tree) {
    if (kind === "task" && g.kind === "task" && String(g.task.id) === id) return { key, title: `#${g.task.id} ${g.task.title}`, agents: allAgents(g) };
    if (kind === "none" && g.kind === "none") return { key, title: "No task", agents: allAgents(g) };
    for (const r of g.runs) if (kind === "run" && r.run.id === id) return { key, title: `${r.run.pattern} (${r.run.id})`, agents: r.agents, run: r.run };
    const found = allAgents(g).find((a) => kind === "agent" && a.id === id);
    if (found) return { key, title: `${found.role} (${found.id})`, agents: [found] };
  }
  return null;
}

async function fetchMonitor() {
  const [tasks, runs] = await Promise.all([invokeP("task_list").catch(() => []), invokeP("run_list").catch(() => [])]);
  let registry = [];
  if (sb.status?.running) {
    try { registry = (await invoke("api_call", { method: "shepherd.agent.list", params: {} })).agents; } catch (_) { /* layer off or server gone */ }
  }
  if (!registry.length) registry = await invoke("agent_list").catch(() => []);
  return { tasks, runs, registry };
}

async function drawMonitor() {
  poll("monitor", refreshMonitor, 2000);
  if (!mo.listening && window.__TAURI__?.event?.listen) {
    mo.listening = true; // another request to open the window brings it here: focus what it asked for
    window.__TAURI__.event.listen("monitor-focus", (e) => { const key = monitorKey(e.payload?.focus); if (scopeOf(key)) selectMonitor(key); });
  }
  mo.ui = null;
  try { await loadMonitor(); } catch (e) { $("list").replaceChildren(el("div", { className: "empty" }, String(e))); }
}

async function refreshMonitor() {
  if (mo.paused) return;
  try { await loadMonitor(); } catch (_) { /* keep the last view */ }
}

async function loadMonitor() {
  const data = await fetchMonitor();
  mo.tree = buildMonitorTree(data.tasks, data.runs, data.registry);
  if (!scopeOf(mo.sel)) {
    const wanted = monitorKey(mo.focus);
    mo.sel = scopeOf(wanted) ? wanted : mo.tree[0] ? (mo.tree[0].kind === "task" ? `task:${mo.tree[0].task.id}` : "none") : null;
    if (scopeOf(wanted)) mo.focus = null;
  }
  renderMonitorList();
  if (!mo.ui) renderMonitorDetail(); else fillAgents();
  await loadFeed();
}

function selectMonitor(key) { mo.sel = key; mo.ui = null; mo.filterAgent = ""; renderMonitorList(); renderMonitorDetail(); loadFeed(); }

function renderMonitorList() {
  const items = el("div", { id: "items" });
  const row = (depth, key, label, meta, badge) => items.append(el("button", { className: `item depth${depth}` + (key === mo.sel ? " sel" : ""), onclick: () => selectMonitor(key) },
    el("span", {}, label + " ", badge ?? ""), el("small", {}, meta ?? "")));
  for (const g of mo.tree) {
    const nAgents = allAgents(g).length;
    row(0, g.kind === "task" ? `task:${g.task.id}` : "none", g.kind === "task" ? `#${g.task.id} ${g.task.title}` : "No task", `${g.runs.length} run(s) · ${nAgents} agent(s)`);
    for (const a of g.direct) row(1, `agent:${a.id}`, `${a.role} (${a.id})`, "directo", stateSpan(a.state));
    for (const r of g.runs) {
      const [txt, cls] = runBadge(r.run.state);
      row(1, `run:${r.run.id}`, `Run ${r.run.id.replace(/^run-/, "")}`, `${r.agents.length} agent(s)`, el("span", { className: "badge " + cls }, txt));
      for (const a of r.agents) row(2, `agent:${a.id}`, `${a.role} (${a.id})`, a.vendor ?? "", stateSpan(a.state));
    }
  }
  if (!mo.tree.length) items.append(el("div", { className: "dim pad" }, "No tasks, runs, or agents in this project."));
  const foot = el("div", { className: "panel-actions" }, el("button", { className: "btn small", onclick: refreshMonitor }, "Refresh"),
    cleanButton(cl.busForce ? "Force clear" : "Clear message bus", async () => { await cleanBus(); await refreshMonitor(); }, renderMonitorList, "Delete bus messages, topics, and subscriptions"));
  if (!inMonitorWindow()) foot.append(el("button", { className: "btn small", title: "Open this monitor in a separate window", onclick: () => openMonitorWindow(mo.sel) }, "Open in new window"));
  $("list").replaceChildren(items, foot);
}

const stateSpan = (state) => { const [txt, cls] = stateBadge(state); return el("span", { className: "badge " + cls }, txt); };

// Detail is built once per selection so typing in the filters survives the polling.
function renderMonitorDetail() {
  const sc = scopeOf(mo.sel);
  if (!sc) return $("detail").replaceChildren(el("div", { className: "empty" }, "Select a task, run, or agent."));
  const ui = { head: el("div", { className: "head" }, sc.title, el("span", { className: "state" })), meta: el("div", { className: "meta" }), agents: el("div", { className: "block" }), feed: el("div", { className: "mfeed" }) };
  const who = el("select", { onchange: () => { mo.filterAgent = who.value; renderFeed(); } }, el("option", { value: "" }, "All agents"));
  const text = el("input", { type: "text", placeholder: "filtrar texto", value: mo.text, oninput: () => { mo.text = text.value; renderFeed(); } });
  const pause = el("button", { className: "btn small", onclick: () => { mo.paused = !mo.paused; pause.textContent = mo.paused ? "Resume" : "Pause feed"; } }, mo.paused ? "Resume" : "Pause feed");
  ui.who = who;
  const blocks = el("div", { className: "blocks" }, ui.agents,
    el("div", { className: "block" }, el("h4", {}, "MESSAGES:"), el("div", { className: "tools" }, who, text, pause), ui.feed));
  mo.ui = ui;
  fillAgents();
  $("detail").replaceChildren(ui.head, ui.meta, blocks);
}

function fillAgents() {
  const sc = scopeOf(mo.sel); if (!sc || !mo.ui) return;
  const { ui } = mo;
  ui.meta.textContent = [sc.run ? `Pattern: ${sc.run.pattern} · ${sc.run.kind ?? ""} · state ${sc.run.state}` : null, sc.run?.task ? `Objective: ${sc.run.task.split("\n")[0].slice(0, 90)}` : null, `${sc.agents.length} agent(s)`].filter(Boolean).join(" | ");
  const known = [...ui.who.options].slice(1).map((o) => o.value);
  if (known.join() !== sc.agents.map((a) => a.id).join()) {
    ui.who.replaceChildren(el("option", { value: "" }, "All agents"), ...sc.agents.map((a) => el("option", { value: a.id, selected: a.id === mo.filterAgent }, `${a.role} (${a.id})`)));
  }
  ui.agents.replaceChildren(el("h4", {}, "AGENTS:"), ...(sc.agents.length ? sc.agents.map((a) => el("div", { className: "arow" },
    el("span", {}, `${a.role} (${a.id}) `, stateSpan(a.state)), el("span", { className: "dim" }, [a.vendor, a.model].filter(Boolean).join("/") + (a.workspace ? ` · workspace ${a.workspace}` : "")), el("span", { className: "grow" }),
    !inMonitorWindow() && a.pane && !TERMINAL_STATES.includes(a.state) ? el("button", { className: "mini", onclick: () => focusPane(a.pane) }, "Go to terminal") : "")) : [el("div", { className: "dim" }, "No agents yet.")]));
}

async function loadFeed() {
  const sc = scopeOf(mo.sel); if (!sc || !mo.ui) return;
  const ids = sc.agents.map((a) => a.id);
  mo.feedError = "";
  if (!ids.length) mo.feed = [];
  else try { mo.feed = await invoke("bus_feed", { agents: ids, after: null, limit: 300 }); } catch (e) { mo.feed = []; mo.feedError = String(e); }
  renderFeed();
}

const clock = (ts) => (ts ?? "").replace("T", " ").slice(11, 19);

function renderFeed() {
  const box = mo.ui?.feed; if (!box) return;
  const q = mo.text.trim().toLowerCase();
  const rows = mo.feed.filter((m) => (!mo.filterAgent || m.from === mo.filterAgent || m.to === mo.filterAgent)
    && (!q || [m.content, m.from, m.to, m.topic].some((s) => (s ?? "").toLowerCase().includes(q))));
  const nearEnd = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  box.replaceChildren(...(mo.feedError ? [el("div", { className: "bad" }, mo.feedError)] : rows.length ? rows.map((m) => el("div", { className: "m" },
    el("span", { className: "dim" }, clock(m.ts)), el("span", {}, m.from, m.to ? ` → ${m.to}` : m.topic ? ` → #${m.topic}` : ""), el("span", { className: "dim" }, m.kind ?? ""),
    el("span", { title: m.content }, m.content.length > 600 ? m.content.slice(0, 600) + "…" : m.content))) : [el("div", { className: "dim" }, mo.feed.length ? "No messages match this filter." : "No messages from these agents yet.")]));
  if (nearEnd) box.scrollTop = box.scrollHeight;
}

// Opens this monitor in its own window (or brings it forward), focused on `focus` ("task:N", "run-…", "agent:ID").
async function openMonitorWindow(focus) {
  try { await invoke("open_monitor", { root: projectRoot(), focus: focus ?? null }); }
  catch (e) { flash(String(e)); }
}

// Shows the monitor tab of the main window focused on `focus`.
function showMonitorTab(focus) { mo.sel = null; mo.focus = focus; openPanelTab("monitor"); }
