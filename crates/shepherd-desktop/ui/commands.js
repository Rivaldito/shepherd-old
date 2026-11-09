// Command dock: a panel docked in the window (not a pop-up) to search commands, run the shepherd CLI
// ("> workspace list") and call API methods ("@pane.list"). Every command here is also reachable from
// the visible UI; Ctrl+Shift+P and the status-bar button only open the dock.
let cm = { open: false, sel: 0, items: [], ask: null, armed: null, history: [], h: -1, out: [] };

const dockInput = () => $("cmd-input");
const focusedPaneId = () => currentLayout()?.focused_pane_id ?? null;
const workspaceName = (w) => w.label || `Workspace ${w.number}`;

function openPanelTab(key) {
  ws.panel = true; renderWorkspace();
  if (leave("tab:" + key, msgBox())) { tab = key; sel = null; pe = null; draw(); }
}

async function newTabHere() {
  const r = await act("tab.create", { workspace_id: ws.wid, focus: true });
  if (r) ws.tid = r.tab.tab_id;
}

// The commands available right now. Dynamic entries (workspaces, tabs, agents) come from the snapshot.
function buildCommands() {
  const s = ws.snap, list = [];
  const add = (group, title, run, o = {}) => list.push({ group, title, run, ...o });
  add("Server", "Start server", startServer);
  add("Server", "Refresh status", () => { scheduleRefresh(); refreshStatus(); });
  for (const [key, label] of TABS) add("Shepherd panel", `Open ${label}`, () => openPanelTab(key));
  if (!s) return list;
  const pane = focusedPaneId();
  add("Workspaces", "New workspace…", () => askFor("Workspace name (press Enter to leave blank)", async (name) => {
    const params = { focus: true }; if (name) params.label = name; if (activeCwd()) params.cwd = activeCwd();
    const r = await act("workspace.create", params);
    if (r) { ws.wid = r.workspace.workspace_id; ws.tid = r.tab.tab_id; ws.panel = false; renderWorkspace(); }
  }));
  if (ws.wid) {
    add("Workspaces", "Rename active workspace…", () => askFor("New workspace name", (label) => label && act("workspace.rename", { workspace_id: ws.wid, label })));
    add("Workspaces", "Close active workspace", () => act("workspace.close", { workspace_id: ws.wid }), { danger: true });
    add("Tabs", "New tab", newTabHere);
  }
  if (ws.tid) {
    add("Tabs", "Rename active tab…", () => askFor("New tab name", (label) => label && act("tab.rename", { tab_id: ws.tid, label })));
    add("Tabs", "Close active tab", () => act("tab.close", { tab_id: ws.tid }), { danger: true });
  }
  if (pane) {
    add("Panes", "Split right", () => act("pane.split", { target_pane_id: pane, direction: "right", focus: true }));
    add("Panes", "Split down", () => act("pane.split", { target_pane_id: pane, direction: "down", focus: true }));
    add("Panes", "Zoom pane", () => act("pane.zoom", { pane_id: pane }));
    add("Panes", "Close focused pane", () => act("pane.close", { pane_id: pane }), { danger: true });
    for (const [dir, title] of [["left", "Focus pane left"], ["right", "Focus pane right"], ["up", "Focus pane up"], ["down", "Focus pane down"]])
      add("Panes", title, () => act("pane.focus_direction", { direction: dir }));
    add("Worktrees", "New worktree…", () => askFor("Worktree branch", (branch) => branch && act("worktree.create", { branch, workspace_id: ws.wid, focus: true })));
  }
  add("Agents", "Launch agent…", () => { ws.panel = false; ws.forms.agent ??= openSpawnForm(); renderWorkspace(); });
  add("Agents", "Open agent monitor in a new window", () => openMonitorWindow(null));
  add("Cleanup", "Clear completed runs and inactive agents", cleanRuns, { danger: true });
  add("Cleanup", "Clear message bus (messages and topics)", cleanBus, { danger: true });
  add("Cleanup", "Archive completed tasks", archiveDoneTasks, { danger: true });
  add("Agents", "Resume agents", () => act("shepherd.agent.resume", {}), { danger: true });
  for (const d of dc.detected) if (d.known && d.path) add("Agents", `Start agent: ${d.command}`, () => quickStartAgent({ kind: d.command }));
  add("Agents", "Rescan installed agents", async () => { await loadDiscovery(true); flash("Detected agents: " + dc.detected.filter((d) => d.known && d.path).map((d) => d.command).join(", ")); });
  add("Tasks", "New task…", () => askFor("Task title", async (title) => {
    if (!title) return;
    // in the project of the active workspace, at its root (where `.shepherd/` is)
    const root = await invoke("resolved_root", { root: projectRoot() });
    await act("shepherd.task.create", { title, root });
  }));
  add("Patterns", "Run pattern…", () => askFor("Pattern name", (pattern) => pattern && askFor("Run objective", async (task) => {
    // agents of the run land in the active workspace: link it to its checkout first
    const target = ws.wid ? await rootForWorkspace(ws.wid).catch(() => null) : null;
    const params = { pattern };
    if (task) params.task = task;
    if (target?.root) params.root = target.root;
    await act("shepherd.pattern.run.start", params);
  })));
  for (const w of s.workspaces) add("Navigate", `Go to workspace: ${workspaceName(w)}`, () => selectWorkspace(w.workspace_id));
  for (const t of ws.wid ? tabsOf(ws.wid) : []) add("Navigate", `Ir a tab: ${t.label}`, () => selectTab(t.tab_id));
  for (const r of agentRows(s, ws.sagents)) if (r.pane) add("Navigate", `Ir al agent: ${r.title}`, () => focusPane(r.pane));
  return list;
}

// ---- dock state ------------------------------------------------------------------------------
const dockMode = () => (cm.ask ? "ask" : dockInput().value.startsWith(">") ? "cli" : dockInput().value.startsWith("@") ? "api" : "cmd");

function echo(cmd, text, bad = false) {
  cm.out.push({ cmd, text, bad }); cm.out = cm.out.slice(-40);
  renderDock();
}

function askFor(label, cb) { cm.ask = { label, cb }; dockInput().value = ""; renderDock(); dockInput().focus(); }

function runCommand(c) {
  if (c.danger && cm.armed !== c.title) { cm.armed = c.title; echo(c.title, "This is a destructive action. Press Enter again to confirm.", true); return; }
  cm.armed = null;
  c.run();
  if (!cm.ask) closeDock();
}

async function runCli(line) {
  const { args, error } = splitArgs(line);
  if (error) return echo("shepherd " + line, error, true);
  if (!args.length) return;
  try {
    const r = await invoke("cli_run", { args });
    const text = [r.stdout.trimEnd(), r.stderr.trim() && `[stderr]\n${r.stderr.trimEnd()}`, r.timed_out ? "[timed out]" : `[exit code ${r.code ?? "?"}]`].filter(Boolean).join("\n");
    echo("shepherd " + line, text, r.code !== 0 || r.timed_out);
  } catch (e) { echo("shepherd " + line, String(e), true); }
  scheduleRefresh();
}

async function runApi(line) {
  const parsed = parseApiLine(line);
  if (parsed.error) return echo("@" + line, parsed.error, true);
  try {
    const result = await invoke("api_call", { method: parsed.method, params: parsed.params });
    const text = JSON.stringify(result, null, 2);
    echo(`@${parsed.method} ${JSON.stringify(parsed.params)}`, text.length > 20000 ? text.slice(0, 20000) + "\n… (recortado)" : text);
  } catch (e) { echo(`@${parsed.method}`, String(e), true); }
  scheduleRefresh();
}

function renderDock() {
  const input = dockInput(), v = input.value, mode = dockMode();
  input.placeholder = cm.ask ? cm.ask.label : "Search commands…   > CLI   @ API";
  $("cmd-hint").textContent = mode === "ask" ? "Enter confirms · Esc cancels"
    : mode === "cli" ? "CLI: Enter runs `shepherd " + v.slice(1).trim() + "” · ↑↓ history"
    : mode === "api" ? "API: @method {json}, e.g. @pane.list · ↑↓ history"
    : "↑↓ select · Enter runs · > CLI command · @method {json} for the API";
  const list = $("cmd-list");
  if (mode === "cmd") {
    cm.items = matchCommands(v, buildCommands());
    cm.sel = Math.max(0, Math.min(cm.sel, cm.items.length - 1));
    list.replaceChildren(...(cm.items.length ? cm.items.map((c, i) => el("div", { className: "cmd" + (i === cm.sel ? " sel" : "") + (c.danger ? " danger" : ""), onclick: () => { cm.sel = i; runCommand(c); } },
      el("span", { className: "cg" }, c.group), el("span", {}, c.title), c.danger ? el("small", {}, "requires confirmation") : "")) : [el("div", { className: "dim pad" }, "No matching commands.")]));
    list.querySelector(".cmd.sel")?.scrollIntoView({ block: "nearest" });
  } else list.replaceChildren(el("div", { className: "dim pad" }, cm.ask ? cm.ask.label : mode === "cli" ? "Allowed commands: workspace, tab, pane, agent, worktree, notification, api, status." : "Any runtime method: workspace.*, tab.*, pane.*, agent.*, worktree.*, layout.*, shepherd.*"));
  const out = $("cmd-out");
  out.replaceChildren(...cm.out.map((e) => el("div", { className: "oe" }, el("div", { className: "dim" }, "$ " + e.cmd), el("div", { className: e.bad ? "bad" : "" }, e.text))));
  out.scrollTop = out.scrollHeight;
}

function openDock() {
  if (!dc.loaded) loadDiscovery().then(() => cm.open && renderDock()); // so "Start agent: …" can list what is installed
  cm.open = true; $("cmdbar").hidden = false; dockInput().value = ""; cm.sel = 0; cm.armed = null; cm.ask = null;
  renderDock(); dockInput().focus();
}

function closeDock() {
  cm.open = false; cm.ask = null; cm.armed = null; $("cmdbar").hidden = true;
  paneEls.get(focusedPaneId())?.pre.focus({ preventScroll: true });
}

function toggleDock() { if (cm.open && document.activeElement === dockInput()) closeDock(); else openDock(); }

function submitDock() {
  const input = dockInput(), mode = dockMode(), v = input.value;
  if (mode === "ask") { const { cb } = cm.ask; cm.ask = null; input.value = ""; cb(v.trim()); if (!cm.ask) closeDock(); else renderDock(); return; }
  if (mode === "cli" || mode === "api") {
    const line = v.slice(1).trim(); if (!line) return;
    if (cm.history[cm.history.length - 1] !== v) cm.history.push(v);
    cm.h = -1; input.value = v[0];
    return mode === "cli" ? runCli(line) : runApi(line);
  }
  const c = cm.items[cm.sel]; if (c) runCommand(c);
}

function initCommands() {
  const input = dockInput();
  input.addEventListener("input", () => { cm.sel = 0; cm.armed = null; cm.h = -1; renderDock(); });
  input.addEventListener("keydown", (e) => {
    e.stopPropagation(); // the dock owns the keyboard while it has focus
    const mode = dockMode();
    if (e.key === "Escape") { e.preventDefault(); if (cm.ask) { cm.ask = null; input.value = ""; renderDock(); } else closeDock(); }
    else if (e.key === "Enter") { e.preventDefault(); submitDock(); }
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault(); const d = e.key === "ArrowDown" ? 1 : -1;
      if (mode === "cmd") { cm.sel = Math.max(0, Math.min(cm.sel + d, cm.items.length - 1)); renderDock(); }
      else if ((mode === "cli" || mode === "api") && cm.history.length) {
        cm.h = stepHistory(cm.h, cm.history.length, d < 0 ? "older" : "newer");
        input.value = cm.h === -1 ? input.value[0] : cm.history[cm.history.length - 1 - cm.h]; renderDock();
      }
    }
  });
  $("cmd-close").onclick = closeDock;
  $("cmd-clear").onclick = () => { cm.out = []; renderDock(); };
  // Capture phase: terminals stop propagation of the keys they handle.
  window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "p") { e.preventDefault(); e.stopPropagation(); toggleDock(); }
  }, true);
}
