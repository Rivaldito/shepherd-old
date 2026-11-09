// Tasks tab, like the TUI: filter (Todas / Abiertas / Completadas) + list + detail, for the project of
// the active workspace. Tasks can be created here, and agents are launched for a task and listed under it
// (the registry keeps `task_id` on each agent: that is what "assigned" means).
let tk = { list: [], agents: [], patterns: [], runs: [], runEls: {}, sel: null, raw: "", filter: 0, dir: "", creating: false, newForm: null, spawning: null, spawnEl: null }; // sel: task id

const TASK_FILTERS = ["All", "Open", "Completed"];
const isDoneTask = (t) => ["done", "completed", "archived"].includes(t.state.toLowerCase());
const isOpen = (t) => !isDoneTask(t); // "new" tasks are open too
const taskShown = (t) => tk.filter === 1 ? isOpen(t) : tk.filter === 2 ? isDoneTask(t) : true;
const taskBadge = (s) => {
  const k = s.toLowerCase();
  return [`[${s.toUpperCase()}]`, ["open", "active"].includes(k) ? "ok" : ["done", "completed"].includes(k) ? "dim" : k === "blocked" ? "bad" : "warn"];
};

async function fetchTasks() {
  const [list, dir] = await Promise.all([invokeP("task_list"), invokeP("task_dir")]);
  let agents = [];
  if (sb.status?.running) {
    try { agents = (await invoke("api_call", { method: "shepherd.agent.list", params: {} })).agents; } catch (_) { /* layer off or server gone */ }
  }
  const [patterns, runs] = await Promise.all([invokeP("pattern_list").catch(() => []), invokeP("run_list").catch(() => [])]);
  return { list, dir, agents, patterns, runs };
}

function applyTasks(data) {
  const raw = JSON.stringify([data.list, data.agents, data.dir, data.patterns, data.runs]);
  if (raw === tk.raw) return;
  tk.raw = raw; tk.list = data.list; tk.agents = data.agents; tk.dir = data.dir; tk.patterns = data.patterns; tk.runs = data.runs;
  renderTasks();
}

async function drawTasks() {
  poll("tasks", refreshTasks); // tasks are files under .shepherd/tasks; the registry is polled with them
  tk.raw = "";
  try { applyTasks(await fetchTasks()); }
  catch (e) { $("list").replaceChildren(el("div", { className: "empty" }, String(e))); $("detail").replaceChildren(); }
}

async function refreshTasks() {
  try { applyTasks(await fetchTasks()); } catch (_) { /* keep last view */ }
}

// "+ New task": the same fields the TUI asks for (title, description, criteria one per line).
function newTaskForm() {
  const title = el("input", { type: "text", className: "inline", placeholder: "Task title" });
  const desc = el("textarea", { className: "inline", rows: 4, placeholder: "Description / specification" });
  const crit = el("textarea", { className: "inline", rows: 3, placeholder: "Acceptance criteria (one per line)" });
  const msg = el("div", { className: "dim" });
  const cancel = () => { tk.creating = false; tk.newForm = null; renderTasks(); };
  const create = async () => {
    if (shepherdOff()) { msg.textContent = "Enable Shepherd first (see the notice below the panes)."; return; }
    if (!title.value.trim()) { msg.textContent = "Enter a title."; return; }
    const params = { title: title.value.trim() };
    if (desc.value.trim()) params.description = desc.value.trim();
    const criteria = crit.value.split("\n").map((s) => s.trim()).filter(Boolean);
    if (criteria.length) params.criteria = criteria;
    // the project root (where `.shepherd/` is), not the terminal's subfolder
    params.root = await invoke("resolved_root", { root: projectRoot() });
    msg.textContent = "Creando…";
    const r = await act("shepherd.task.create", params);
    if (!r) { msg.textContent = `Could not create: ${ws.lastError || "unknown error"}`; return; }
    tk.creating = false; tk.newForm = null; tk.sel = r.task.status.id; tk.filter = 0; tk.raw = "";
    flash(`Task #${r.task.status.id} creada`); refreshTasks();
  };
  const form = el("div", { className: "aform" }, el("label", {}, "Title"), title, el("label", {}, "Description"), desc, el("label", {}, "Criteria"), crit, msg,
    el("div", { className: "row" }, el("button", { className: "btn small", onclick: create }, "Create task"), el("button", { className: "mini", onclick: cancel }, "Cancel")));
  form.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") cancel(); });
  setTimeout(() => title.focus(), 0);
  return form;
}

// Launch an agent for this task: the task text is prefilled and the agent is created in the active workspace.
function spawnForTask(t) {
  const close = () => { tk.spawning = null; tk.spawnEl = null; tk.raw = ""; refreshTasks(); };
  tk.spawning = t.id;
  tk.spawnEl = spawnForm({ taskId: t.id, taskText: taskPrompt(t), onDone: (agent) => { close(); if (agent.pane) focusPane(agent.pane); }, onCancel: () => { tk.spawning = null; tk.spawnEl = null; renderTasks(); } });
  renderTasks();
}

function assignedBlock(t) {
  const mine = agentsOfTask(tk.agents, t.id);
  const rows = mine.map((a) => {
    const [txt, cls] = stateBadge(a.state);
    return el("div", { className: "arow" }, el("span", {}, `${a.role} (${a.id}) `, el("span", { className: "badge " + cls }, txt)),
      el("span", { className: "dim" }, a.workspace ? `workspace ${a.workspace}` : ""), el("span", { className: "grow" }),
      a.pane && !TERMINAL_STATES.includes(a.state) ? el("button", { className: "mini", onclick: () => focusPane(a.pane) }, "Go to terminal") : "",
      el("button", { className: "mini", title: "Remove from this task", onclick: async () => { if (await assignAgent(a.id, null)) { tk.raw = ""; refreshTasks(); } } }, "Remove"));
  });
  const running = !!sb.status?.running;
  // Existing agents: anyone not already on this task (the label says which task they are on now).
  const others = tk.agents.filter((a) => String(a.task_id ?? "") !== String(t.id) && !isRunAgent(a)); // a run's agents stay with their run
  const pick = el("select", {}, ...(others.length ? others.map((a) => el("option", { value: a.id }, `${a.role} (${a.id})${a.task_id ? ` · currently on task #${a.task_id}` : ""}`)) : [el("option", { value: "" }, "No other agents")]));
  const assign = el("div", { className: "assign" }, pick, el("button", { className: "btn small", disabled: !others.length, onclick: async () => {
    if (pick.value && await assignAgent(pick.value, t.id)) { flash(`Agent ${pick.value} asignado a la task #${t.id}`); tk.raw = ""; refreshTasks(); }
  } }, "Asignar existente"));
  return el("div", { className: "block" }, el("h4", {}, "ASSIGNED AGENTS:"),
    ...(rows.length ? rows : [el("div", { className: "dim" }, "Nothing yet.")]), assign,
    el("button", { className: "btn small", disabled: !running, title: running ? "" : "Requires the server to be running", style: "margin-top:8px", onclick: () => spawnForTask(t) }, "+ Launch agent for this task"));
}

// Runs a pattern FOR this task: the server creates the pattern's agents in the active workspace, and the run is
// tied to the task through its objective ("Task #N: …"), which the monitor and this list read back.
function patternLauncher(t) {
  return patternRunForm({ task: t, onStarted: () => { tk.raw = ""; refreshTasks(); } });
}

function patternsBlock(t) {
  const mine = tk.runs.filter((r) => taskOfRun(r) === t.id);
  const rows = mine.map((r) => {
    const [txt, cls] = runBadge(r.state);
    return el("div", { className: "arow" }, el("span", {}, `${r.pattern} `, el("span", { className: "badge " + cls }, txt)),
      el("span", { className: "dim" }, `${(r.agents ?? []).length} agent(s) · ${r.id}`), el("span", { className: "grow" }),
      el("button", { className: "mini", onclick: () => showMonitorTab(`run:${r.id}`) }, "View messages"),
      el("button", { className: "mini", onclick: () => openMonitorWindow(`run:${r.id}`) }, "Open in new window"));
  });
  const L = (tk.runEls[t.id] ??= patternLauncher(t)); // built once: a refresh must not wipe an edited objective
  L.fill(tk.patterns);
  return el("div", { className: "block" }, el("h4", {}, "TASK PATTERNS:"), ...(rows.length ? rows : [el("div", { className: "dim" }, "Nothing yet.")]), L.el);
}

function renderTasks() {
  const shown = tk.list.filter(taskShown);
  if (!shown.some((t) => t.id === tk.sel)) tk.sel = shown[0]?.id ?? null;
  const filters = el("div", { className: "filters" }, ...TASK_FILTERS.map((f, i) =>
    el("button", { className: i === tk.filter ? "sel" : "", onclick: () => { tk.filter = i; renderTasks(); } }, f)));
  const items = el("div", { id: "items" });
  for (const t of shown) {
    const [txt, cls] = taskBadge(t.state);
    const n = agentsOfTask(tk.agents, t.id).length;
    items.append(el("button", { className: "item" + (t.id === tk.sel && !tk.creating ? " sel" : ""), onclick: () => { tk.sel = t.id; tk.creating = false; renderTasks(); } },
      el("span", {}, `#${String(t.id).padStart(2, "0")} ${t.title} `, el("span", { className: "badge " + cls }, txt)), el("small", {}, n ? `${n} agent(s)` : "")));
  }
  $("list").replaceChildren(filters, items, el("div", { className: "panel-actions" },
    el("button", { className: "btn small", onclick: () => { tk.creating = true; tk.newForm ??= newTaskForm(); renderTasks(); } }, "+ New task"),
    cleanButton("Archive completed", archiveDoneTasks, renderTasks, "Archive completed tasks"),
    el("button", { className: "btn small", onclick: () => { tk.raw = ""; refreshTasks(); } }, "Refresh")));
  if (tk.creating) return $("detail").replaceChildren(el("div", { className: "head" }, "NEW TASK", el("span", { className: "state" })), el("div", { className: "blocks" }, tk.newForm),
    el("div", { className: "meta" }, `Will be saved to ${tk.dir}`));
  const t = tk.list.find((x) => x.id === tk.sel);
  if (!t) return $("detail").replaceChildren(el("div", { className: "empty" },
    `No tasks match this filter in this project (${tk.dir}). Create one with “+ New task”.`));

  const [txt, cls] = taskBadge(t.state);
  const block = (title, ...body) => el("div", { className: "block" }, el("h4", {}, title), ...body);
  const text = (s) => el("pre", {}, s);
  const detail = el("div", { className: "blocks" });
  if (tk.spawning === t.id && tk.spawnEl) detail.append(tk.spawnEl); // built once: a refresh must not wipe what is typed
  if (t.waiting) detail.append(el("div", { className: "notice" }, `WAITING: ${t.waiting}`));
  if (t.description) detail.append(block("SPECIFICATION:", text(t.description)));
  if (t.criteria.length) detail.append(block("ACCEPTANCE CRITERIA:", text(t.criteria.map((c) => {
    const done = /^- \[[xX]\]/.test(c);
    return `${done ? "☑" : "☐"} ${c.replace(/^([-*] \[[ xX]\]|[-*])\s*/, "")}`;
  }).join("\n"))));
  detail.append(assignedBlock(t));
  detail.append(patternsBlock(t));
  if ((t.subtasks ?? []).length) detail.append(block("SUBTASKS:", text(t.subtasks.map((s) =>
    `${s.n}. ${s.title} [${s.state}]${s.branch ? " " + s.branch : ""}${s.pr ? " PR " + s.pr : ""}${s.note ? "\n     " + s.note : ""}`).join("\n"))));
  if (t.links.length) detail.append(block("LINKS:", text(t.links.join("\n"))));
  if (t.note) detail.append(block("NOTE:", text(t.note)));
  if (t.plan) detail.append(block("PLAN:", text(t.plan)));
  $("detail").replaceChildren(
    el("div", { className: "head" }, `TASK #${t.id}: ${t.title}`, el("span", { className: "badge " + cls }, txt), el("span", { className: "state" })),
    el("div", { className: "meta" }, `State: ${t.state} | Branch: ${t.branch || "none"} | PR: #${t.pr ?? 0} | Project: ${tk.dir.replace(/\/\.shepherd\/tasks$/, "")}`), detail);
}
