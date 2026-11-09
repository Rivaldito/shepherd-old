// Herdr-like shell over the Shepherd server API: Workspaces (workspaces) and Agents in the sidebar,
// tabs, split panes with live terminals. The server owns every terminal; this paints `pane.read`
// output and sends keys back. Server events only say "re-read the snapshot".
let ws = { lastFocused: null, snap: null, wid: null, tid: null, panel: false, error: "", forms: { space: null, agent: null }, sagents: [], promptFor: null, rename: null };
const paneEls = new Map(); // pane_id -> { root, head, pre, text, busy, q, chain, ... }
let tickN = 0;

const srv = (method, params) => invoke("api_call", { method, params: params ?? {} });
const baseName = (p) => (p ?? "").split("/").filter(Boolean).pop() ?? "";
const hue = (s) => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

function flash(msg) {
  sb.note = msg; renderStatus();
  setTimeout(() => { if (sb.note === msg) { sb.note = ""; renderStatus(); } }, 6000);
}

// Runs a server method, refreshes the view, and reports failures in the status bar.
async function act(method, params) {
  try { const r = await srv(method, params); scheduleRefresh(); return r; }
  catch (e) { ws.lastError = String(e); flash(String(e)); return null; }
}

async function closeShepherdAgent(id, finished = false) {
  if (!finished && !await act("shepherd.agent.kill", { id })) return;
  await act("shepherd.agent.clean", { ids: [id] });
}

function closePane(paneId) {
  const agent = ws.snap?.agents.find((a) => a.pane_id === paneId)?.shepherd;
  if (agent?.id) return closeShepherdAgent(agent.id, isFinished({ sid: agent.id, sstate: agent.state }));
  return act("pane.close", { pane_id: paneId });
}

function closeButton(run, label, glyph = "✕") {
  return el("button", { className: "mini icon-button", title: label, "aria-label": label, onclick: (e) => { e.stopPropagation(); run(); } }, glyph);
}

function inlineEdit(initial, commit, cancel) {
  const input = el("input", { type: "text", className: "inline", value: initial });
  input.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") commit(input.value.trim()); if (e.key === "Escape") cancel(); });
  input.addEventListener("blur", cancel);
  setTimeout(() => { input.focus(); input.select(); }, 0);
  return input;
}

// The project the views are about: the folder of the active workspace (its linked checkout, else where its
// terminal is). The Rust side finds the project root from it; null means "the one the app started in".
const projectRoot = () => window.__view?.root || workspaceRootOf(ws.snap?.workspaces.find((w) => w.workspace_id === ws.wid), activeCwd()) || null;
// invoke() for commands that read a project (tasks, patterns, runs, skills, git, files, config).
const invokeP = (cmd, args = {}) => invoke(cmd, { ...args, root: projectRoot() });

// ---- state ---------------------------------------------------------------------------------
let refreshTimer = 0, refreshing = false, again = false;
function scheduleRefresh() { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshSnapshot, 60); }
function onServerConnected() { scheduleRefresh(); }

async function refreshSnapshot() {
  if (refreshing) { again = true; return; }
  refreshing = true;
  try { ws.snap = (await srv("session.snapshot")).snapshot; ws.error = ""; selectDefaults(); }
  catch (e) { ws.snap = null; ws.error = String(e); }
  // Shepherd's own registry (roles, tasks, state); absent when the orchestration layer is off.
  try { ws.sagents = ws.snap ? (await srv("shepherd.agent.list")).agents : []; } catch (_) { ws.sagents = []; }
  renderWorkspace();
  refreshing = false;
  if (again) { again = false; scheduleRefresh(); }
}

const tabsOf = (wid) => ws.snap.tabs.filter((t) => t.workspace_id === wid);
const currentLayout = () => ws.snap?.layouts.find((l) => l.tab_id === ws.tid);

function selectDefaults() {
  const s = ws.snap;
  if (!s.workspaces.some((w) => w.workspace_id === ws.wid)) ws.wid = s.focused_workspace_id ?? s.workspaces[0]?.workspace_id ?? null;
  const tabs = ws.wid ? tabsOf(ws.wid) : [];
  if (!tabs.some((t) => t.tab_id === ws.tid)) ws.tid = (tabs.find((t) => t.tab_id === s.workspaces.find((w) => w.workspace_id === ws.wid)?.active_tab_id) ?? tabs[0])?.tab_id ?? null;
}

function selectWorkspace(id) { ws.wid = id; ws.tid = null; ws.panel = false; selectDefaults(); renderWorkspace(); srv("workspace.focus", { workspace_id: id }).catch(() => {}); }
function selectTab(id) { ws.tid = id; ws.panel = false; renderWorkspace(); srv("tab.focus", { tab_id: id }).catch(() => {}); }
function focusPane(paneId) {
  const p = ws.snap.panes.find((x) => x.pane_id === paneId); if (!p) return;
  ws.wid = p.workspace_id; ws.tid = p.tab_id; ws.panel = false; renderWorkspace();
  act("pane.focus", { pane_id: paneId });
}

// ---- rendering -----------------------------------------------------------------------------
function renderWorkspace() {
  $("panes").hidden = ws.panel; $("shepherd-panel").hidden = !ws.panel;
  // Another workspace means another project: the open panel view must read that one.
  const root = projectRoot();
  if (root !== ws.root) { ws.root = root; if (ws.panel) draw(); }
  renderSidebar(); renderTabs();
  if (!ws.panel) renderPanes();
}

function statusDot(status) { return el("span", { className: "sdot " + (status ?? "unknown") }); }

function spaceRow(w) {
  const label = w.label || `Workspace ${w.number}`;
  if (ws.rename === "w:" + w.workspace_id) {
    return el("div", { className: "space" }, inlineEdit(label, (v) => { ws.rename = null; if (v) act("workspace.rename", { workspace_id: w.workspace_id, label: v }); renderWorkspace(); }, () => { ws.rename = null; renderWorkspace(); }));
  }
  return el("div", { className: "space" + (w.workspace_id === ws.wid ? " sel" : ""), onclick: () => selectWorkspace(w.workspace_id), ondblclick: () => { ws.rename = "w:" + w.workspace_id; renderWorkspace(); } },
    el("span", { className: "avatar", style: `background:hsl(${hue(label)} 55% 45%)` }, label[0].toUpperCase()),
    el("span", { className: "slabel", title: label }, label),
    el("span", { className: "smeta" }, statusDot(w.agent_status), `${w.tab_count}t·${w.pane_count}p`),
    el("span", { className: "sbtns" }, closeButton(() => act("workspace.close", { workspace_id: w.workspace_id }), "Close workspace")));
}

function newSpaceForm() {
  const name = el("input", { type: "text", className: "inline", placeholder: "Workspace name" });
  const cwd = el("input", { type: "text", className: "inline", placeholder: "Folder (optional)" });
  const cancel = () => { ws.forms.space = null; renderWorkspace(); };
  const create = async () => {
    const params = { focus: true }; if (name.value.trim()) params.label = name.value.trim(); if (cwd.value.trim()) params.cwd = cwd.value.trim();
    ws.forms.space = null;
    const r = await act("workspace.create", params);
    if (r) { ws.wid = r.workspace.workspace_id; ws.tid = r.tab.tab_id; ws.panel = false; }
    renderWorkspace();
  };
  for (const i of [name, cwd]) i.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Enter") create(); if (e.key === "Escape") cancel(); });
  setTimeout(() => name.focus(), 0);
  return el("div", { className: "space form" }, name, cwd, el("div", { className: "row" }, el("button", { className: "btn small", onclick: create }, "Create"), el("button", { className: "mini", onclick: cancel }, "✕")));
}

const AGENT_GROUPS = [["blocked", "Blocked"], ["working", "Working"], ["done", "Completed"], ["idle", "Idle"]];

function activeCwd() {
  const s = ws.snap, l = currentLayout();
  return s?.panes.find((p) => p.pane_id === l?.focused_pane_id)?.cwd ?? "";
}

function openSpawnForm() {
  const close = () => { ws.forms.agent = null; renderWorkspace(); };
  return spawnForm({ root: activeCwd(), onDone: (agent) => { close(); if (agent.pane) focusPane(agent.pane); }, onCancel: close });
}

function agentRow(r) {
  const finished = isFinished(r);
  const actions = [];
  if (r.canPrompt) actions.push(el("button", { className: "mini", title: "Send prompt", onclick: (e) => { e.stopPropagation(); ws.promptFor = ws.promptFor === r.pane ? null : r.pane; renderWorkspace(); } }, "✎"));
  if (r.sid) actions.push(closeButton(() => closeShepherdAgent(r.sid, finished), "Close agent"));
  else if (r.pane) actions.push(closeButton(() => closePane(r.pane), "Close agent pane"));
  const row = el("div", { className: "agent", onclick: () => r.pane && focusPane(r.pane) }, statusDot(r.status),
    el("span", { className: "aname" }, r.title), el("span", { className: "asub", title: r.sub }, r.sub), el("span", { className: "abtns" }, ...actions));
  if (!ws.promptFor || ws.promptFor !== r.pane) return [row]; // rows without a pane never match
  const prompt = inlineEdit("", (text) => { ws.promptFor = null; if (text) act("agent.prompt", { target: r.pane, text }); renderWorkspace(); }, () => { ws.promptFor = null; renderWorkspace(); });
  prompt.placeholder = "Message this agent (press Enter to send)";
  return [row, el("div", { className: "agent-prompt" }, prompt)];
}

function renderAgentsSide() {
  const box = $("agents-side"), groups = {};
  for (const r of agentRows(ws.snap, ws.sagents)) (groups[r.status] ??= []).push(r);
  const out = [];
  if (ws.forms.agent) out.push(ws.forms.agent); // built once so a refresh does not wipe the typed task
  for (const [key, title] of AGENT_GROUPS) {
    if (!groups[key]) continue;
    out.push(el("div", { className: "ghead " + key }, `${title} ${groups[key].length}`));
    for (const r of groups[key]) out.push(...agentRow(r));
  }
  box.replaceChildren(...(out.length ? out : [el("div", { className: "dim pad" }, "No agents. Press + to launch one.")]));
}

function renderSidebar() {
  const s = ws.snap, box = $("spaces");
  if (!s) { box.replaceChildren(el("div", { className: "dim pad" }, ws.error ? "Not connected to the server." : "Connecting…")); $("agents-side").replaceChildren(); return; }
  const rows = s.workspaces.map(spaceRow);
  if (ws.forms.space) rows.unshift(ws.forms.space); // built once: a refresh must not wipe what is being typed
  box.replaceChildren(...(rows.length ? rows : [el("div", { className: "dim pad" }, "No workspaces yet. Press + to create one.")]));
  renderAgentsSide();
}

function tabButton(t) {
  if (ws.rename === "t:" + t.tab_id) {
    return el("div", { className: "wtab" }, inlineEdit(t.label, (v) => { ws.rename = null; if (v) act("tab.rename", { tab_id: t.tab_id, label: v }); renderWorkspace(); }, () => { ws.rename = null; renderWorkspace(); }));
  }
  return el("div", { className: "wtab" + (t.tab_id === ws.tid && !ws.panel ? " sel" : ""), onclick: () => selectTab(t.tab_id), ondblclick: () => { ws.rename = "t:" + t.tab_id; renderWorkspace(); } },
    statusDot(t.agent_status), el("span", {}, t.label), closeButton(() => act("tab.close", { tab_id: t.tab_id }), "Close tab"));
}

function renderTabs() {
  const tabs = ws.snap && ws.wid ? tabsOf(ws.wid) : [];
  const strip = el("div", { className: "tab-strip" }, ...tabs.map(tabButton),
    ws.snap && ws.wid ? el("button", { className: "mini icon-button", title: "New tab", "aria-label": "New tab", onclick: async () => { const r = await act("tab.create", { workspace_id: ws.wid, focus: true }); if (r) ws.tid = r.tab.tab_id; } }, "+") : "");
  const shepherd = el("button", { className: "btn small shepherd-toggle" + (ws.panel ? " on" : ""), "aria-pressed": String(ws.panel), onclick: () => { ws.panel = !ws.panel; renderWorkspace(); if (ws.panel) draw(); } }, "Shepherd");
  $("wtabs").replaceChildren(strip, shepherd);
}

// ---- panes ---------------------------------------------------------------------------------
function paneButton(label, title, run) { return el("button", { className: "mini", title, onclick: (e) => { e.stopPropagation(); run(); } }, label); }

function makePane(id) {
  const t = { id, text: null, busy: false, q: [], chain: Promise.resolve(), flush: 0 };
  t.pre = el("pre", { className: "term", tabIndex: 0, spellcheck: false });
  t.head = el("div", { className: "phead" });
  t.body = el("div", { className: "pbody" }, t.pre);
  t.root = el("div", { className: "pane" }, t.head, t.body);
  t.pre.addEventListener("mousedown", () => { if (currentLayout()?.focused_pane_id !== id) srv("pane.focus", { pane_id: id }).then(scheduleRefresh).catch(() => {}); });
  t.pre.addEventListener("keydown", (e) => {
    const item = keyToInput(e); if (!item) return;
    e.preventDefault(); e.stopPropagation(); queueInput(id, item);
  });
  new ResizeObserver(() => fitPane(t)).observe(t.body);
  paneEls.set(id, t);
  return t;
}

function queueInput(id, item) {
  const t = paneEls.get(id); if (!t) return;
  t.q.push(item);
  if (!t.flush) t.flush = setTimeout(() => flushInput(t), 15);
}

function flushInput(t) {
  const items = t.q.splice(0); t.flush = 0;
  t.chain = t.chain.then(async () => {
    for (const b of mergeInputs(items)) {
      try { await (b.text !== undefined ? srv("pane.send_text", { pane_id: t.id, text: b.text }) : srv("pane.send_keys", { pane_id: t.id, keys: b.keys })); }
      catch (e) { flash(String(e)); }
    }
    t.fast = 6; // read quickly after typing so the echo shows up at once
  });
}

// Pasting (Ctrl+Shift+V) goes to the terminal that has the focus.
document.addEventListener("paste", (e) => {
  const t = [...paneEls.values()].find((x) => x.pre === document.activeElement); if (!t) return;
  const text = e.clipboardData?.getData("text"); if (!text) return;
  e.preventDefault(); queueInput(t.id, { text });
});

function fitPane(t) {
  const r = t.body.getBoundingClientRect(); if (!r.width || !t.cols) return;
  t.pre.style.fontSize = fitFontSize(r.width - 12, r.height - 8, t.cols, t.rows) + "px";
}

function renderPanes() {
  const box = $("panes"), s = ws.snap;
  if (!s) { paneEls.clear(); return box.replaceChildren(el("div", { className: "empty big" }, ws.error ? "Not connected to the server. Use “Start server” in the status bar." : "Connecting…")); }
  const layout = currentLayout();
  if (!layout) { paneEls.clear(); return box.replaceChildren(el("div", { className: "empty big" }, s.workspaces.length ? "This tab has no panes." : "No workspaces. Create one with + in the sidebar.")); }
  const area = layout.area;
  const shown = layout.zoomed ? layout.panes.filter((p) => p.pane_id === layout.focused_pane_id) : layout.panes;
  const keep = new Set(shown.map((p) => p.pane_id));
  for (const [id, t] of paneEls) if (!keep.has(id)) { t.root.remove(); paneEls.delete(id); }
  box.querySelector(".empty")?.remove();
  for (const p of shown) {
    const t = paneEls.get(p.pane_id) ?? makePane(p.pane_id);
    const rect = layout.zoomed ? area : p.rect, info = s.panes.find((x) => x.pane_id === p.pane_id), agent = s.agents.find((a) => a.pane_id === p.pane_id);
    Object.assign(t.root.style, { left: ((rect.x - area.x) / area.width) * 100 + "%", top: ((rect.y - area.y) / area.height) * 100 + "%", width: (rect.width / area.width) * 100 + "%", height: (rect.height / area.height) * 100 + "%" });
    t.root.classList.toggle("focused", p.pane_id === layout.focused_pane_id);
    // The layout rect is authoritative; the pane record's viewport_rows lags behind a split.
    t.cols = Math.max(10, rect.width - 2); t.rows = Math.max(4, rect.height - 2);
    t.head.replaceChildren(statusDot(agent?.agent_status ?? info?.agent_status), el("span", { className: "ptitle" }, agent ? (agent.name || agent.display_agent || agent.agent) : "Terminal"),
      el("span", { className: "pcwd" }, baseName(info?.cwd)), el("span", { className: "grow" }),
      paneButton("▥", "Split right", () => act("pane.split", { target_pane_id: p.pane_id, direction: "right", focus: true })),
      paneButton("▤", "Split down", () => act("pane.split", { target_pane_id: p.pane_id, direction: "down", focus: true })),
      paneButton("⤢", layout.zoomed ? "Exit zoom" : "Zoom", () => act("pane.zoom", { pane_id: p.pane_id })),
      closeButton(() => closePane(p.pane_id), "Close pane"));
    if (!t.root.parentNode) box.append(t.root);
    fitPane(t);
  }
  // Keyboard focus follows the server's focused pane, but never steals it from a text field.
  const focused = paneEls.get(layout.focused_pane_id), typing = document.activeElement?.matches?.("input,textarea,select");
  if (focused && !typing && ws.lastFocused !== layout.focused_pane_id) focused.pre.focus({ preventScroll: true });
  if (!typing) ws.lastFocused = layout.focused_pane_id;
}

// ---- live terminals --------------------------------------------------------------------------
function paintTerminal(pre, text) {
  const frag = document.createDocumentFragment(), lines = parseAnsiLines(text);
  lines.forEach((runs, i) => {
    for (const r of runs) {
      const css = styleToCss(r.style);
      if (css) { const span = el("span", {}, r.text); span.style.cssText = css; frag.append(span); } else frag.append(r.text);
    }
    if (i < lines.length - 1) frag.append("\n");
  });
  pre.replaceChildren(frag);
}

// Focused pane ~8 times a second, the others about once a second.
async function tickTerminals() {
  if (ws.panel || !ws.snap) return;
  tickN++;
  const layout = currentLayout(); if (!layout) return;
  for (const [id, t] of paneEls) {
    if (t.busy) continue;
    const focused = id === layout.focused_pane_id;
    if (!focused && t.text !== null && tickN % 8 && !t.fast) continue;
    if (t.fast) t.fast--;
    t.busy = true;
    srv("pane.read", { pane_id: id, source: "visible", format: "ansi" })
      .then((r) => { const text = r.read.text; if (text !== t.text) { t.text = text; paintTerminal(t.pre, text); } })
      .catch(() => {})
      .finally(() => { t.busy = false; });
  }
}

function initWorkspace() {
  if (inMonitorWindow()) ws.panel = true; // the monitor window shows the panel and nothing else
  $("space-add").onclick = () => { ws.forms.space ??= newSpaceForm(); renderWorkspace(); };
  $("agent-add").onclick = () => { ws.forms.agent ??= openSpawnForm(); renderWorkspace(); };
  const listen = window.__TAURI__?.event?.listen;
  if (listen) { listen("shepherd-event", () => { scheduleRefresh(); pollNow(); }); listen("shepherd-connection", scheduleRefresh); listen("shepherd-state", pollNow); }
  setInterval(tickTerminals, 120);
  refreshSnapshot();
}
