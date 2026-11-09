// Agent actions over the server API: launch (role + task), kill, clean, resume, prompt.

const TERMINAL_STATES = ["done", "exited", "killed", "failed"];

// Model field shared by both launch modes: a text input with a datalist of suggestions, and the
// optional button that saves the detected models into the vendor's config.
function modelPicker() {
  const input = el("input", { type: "text", className: "inline", placeholder: "Model (optional)" });
  const list = el("datalist", { id: "models-" + Math.random().toString(36).slice(2) });
  input.setAttribute("list", list.id);
  const hint = el("div", { className: "dim small" });
  const saveBtn = el("button", { className: "btn small", hidden: true }, "");
  let ctx = null, confirming = false;

  async function show(kind, vendorName, refresh = false) {
    ctx = { kind, vendorName }; confirming = false; saveBtn.hidden = true;
    if (!kind) { list.replaceChildren(); hint.textContent = ""; return; }
    hint.textContent = "Searching for models…";
    const info = await invoke("agent_models", { kind, refresh }).catch((e) => ({ live: [], live_error: String(e), agent_default: null }));
    if (ctx.kind !== kind) return; // the selection moved on while we waited
    const vendor = dc.vendors[vendorName ?? vendorForKind(kind)] ?? null;
    const configured = vendor?.models ?? [];
    list.replaceChildren(...mergeModels({ live: info.live, configured, agentDefault: info.agent_default }).map((o) => el("option", { value: o.id }, o.label)));
    input.placeholder = `Model (optional)${vendor?.default_model || info.agent_default ? " · default: " + (vendor?.default_model || info.agent_default) : ""}`;
    const parts = [];
    if (info.live.length) parts.push(`${info.live.length} detectados`);
    if (configured.length) parts.push(`${configured.length} configured`);
    if (info.live_error) parts.push(`no se pudieron listar: ${info.live_error}`);
    else if (!info.live.length && !configured.length) parts.push("This agent does not list models. Enter a model name.");
    hint.textContent = parts.join(" · ");
    const fresh = vendor ? newModelIds(info.live, configured) : [];
    ctx.save = fresh.length ? { name: vendorName ?? vendorForKind(kind), vendor, models: [...configured, ...fresh] } : null;
    saveBtn.hidden = !ctx.save;
    saveBtn.textContent = ctx.save ? `Save ${fresh.length} detected model(s) to configuration` : "";
    saveBtn.classList.remove("danger");
  }

  saveBtn.onclick = async () => {
    const save = ctx?.save; if (!save) return;
    if (!confirming) { confirming = true; saveBtn.classList.add("danger"); saveBtn.textContent = "Write to config.yaml? Comments will be lost; a .bak copy will be kept."; return; }
    confirming = false;
    try {
      await invoke("save_vendor", { name: save.name, vendor: { ...save.vendor, models: save.models } });
      flash(`Saved models for “${save.name}” to configuration`);
      await loadDiscovery(); await show(ctx.kind, ctx.vendorName);
    } catch (e) { flash(String(e)); }
  };
  return { input, list, hint, saveBtn, show };
}

const optionFor = (value, text, disabled = false) => el("option", { value, disabled }, text);

// Where a workspace's terminal is (its focused pane, else any of its panes).
const cwdOfWorkspace = (wid) => {
  const panes = ws.snap?.panes.filter((p) => p.workspace_id === wid) ?? [];
  return (panes.find((p) => p.focused) ?? panes[0])?.cwd ?? "";
};
const spaceName2 = (w) => w.label || `Workspace ${w.number}`;

// The folder to launch an agent with so the server puts it in THIS workspace. The server places an agent
// in the workspace that has its `root` checkout open, so a plain workspace inside a git repo is linked to
// its checkout first (`worktree.open`, which keeps the workspace and its name). Outside git there is
// nothing to link: the server then opens a new workspace for the folder.
async function rootForWorkspace(wid) {
  const w = ws.snap?.workspaces.find((x) => x.workspace_id === wid);
  const cwd = cwdOfWorkspace(wid);
  if (w?.worktree?.checkout_path) return { root: w.worktree.checkout_path, linked: true };
  try {
    const l = await srv("worktree.list", { workspace_id: wid });
    const path = checkoutFor(cwd, l.worktrees.map((x) => x.path)) ?? l.source.source_checkout_path;
    await srv("worktree.open", { workspace_id: wid, path });
    await refreshSnapshot();
    return { root: path, linked: true };
  } catch (e) {
    if (!String(e).includes("not_git_worktree")) throw e;
    return { root: cwd || null, linked: false, note: "This workspace is not a git repository. Agents will use their directory without a worktree." };
  }
}

// Launch form with two modes: an agent with a Shepherd role and task, or a plain agent of any
// installed kind. `root` is the folder to work in; `onDone({ id?, pane })` runs after a launch.
function spawnForm({ root = "", workspaceId = ws.wid, taskId = null, taskText = "", onDone, onCancel }) {
  let mode = "role";
  const msg = el("div", { className: "dim" });
  const body = el("div", { className: "aform-body" });
  const seg = el("div", { className: "seg" });
  const picker = modelPicker();

  // --- role mode
  const role = el("select", { className: "inline" }, optionFor("", "cargando roles…"));
  const task = el("textarea", { className: "inline", rows: 3, placeholder: "Agent task", value: taskText });
  const dir = el("input", { type: "text", className: "inline", placeholder: "Project folder", value: root });
  // The workspace the agent is created in; "another folder" is for projects with no workspace yet.
  const space = el("select", { className: "inline" });
  const spaceHint = el("div", { className: "dim small" });
  const workspaces = () => ws.snap?.workspaces ?? [];
  const fillWorkspaces = () => {
    space.replaceChildren(...workspaces().map((w) => optionFor(w.workspace_id, spaceName2(w))), optionFor("", "Other folder…"));
    space.value = workspaces().some((w) => w.workspace_id === workspaceId) ? workspaceId : (workspaces()[0]?.workspace_id ?? "");
    showSpace();
  };
  const showSpace = () => {
    const w = workspaces().find((x) => x.workspace_id === space.value);
    spaceHint.textContent = w ? `Folder: ${workspaceRootOf(w, cwdOfWorkspace(w.workspace_id)) ?? "(unknown)"}` : "Enter the project folder.";
    dir.hidden = !!w;
  };
  space.onchange = showSpace;
  const vendor = el("select", { className: "inline" }, optionFor("", "(role vendor)"));
  const worktree = el("input", { type: "checkbox" });
  // --- plain mode
  const kind = el("select", { className: "inline" });
  const nick = el("input", { type: "text", className: "inline", placeholder: "Name (a-z, 0-9, - and _; max 32 chars)" });

  const fillVendors = () => {
    vendor.replaceChildren(optionFor("", "(role vendor)"), ...Object.entries(dc.vendors).sort(([, a], [, b]) => Number(!!pathOf(b.command)) - Number(!!pathOf(a.command))).map(([name, v]) =>
      optionFor(name, `${name} · ${v.command}${pathOf(v.command) ? " ✓" : " — no instalado"}`)));
  };
  const fillKinds = () => {
    kind.replaceChildren(...kindChoices().map((d) => optionFor(d.command, d.path ? `${d.command} ✓` : `${d.command} — no instalado`, !d.path)));
    if (!kind.options.length || kind.selectedOptions[0]?.disabled) kind.value = "";
  };
  const roleVendor = () => dc.roles[role.value]?.vendor || null;
  const refreshModels = () => {
    if (mode === "plain") return picker.show(kind.value || null, vendorForKind(kind.value));
    const name = vendor.value || roleVendor();
    return picker.show(name && dc.vendors[name] ? kindOfVendor(dc.vendors[name]) : null, name);
  };
  role.onchange = refreshModels; vendor.onchange = refreshModels; kind.onchange = refreshModels;

  const submit = el("button", { className: "btn small", onclick: launch }, "Launch");

  function render() {
    seg.replaceChildren(...[["role", taskId ? `Agent for task #${taskId}` : "Shepherd role"], ...(taskId ? [] : [["plain", "Standalone agent"]])].map(([m, label]) =>
      el("button", { className: "mini" + (m === mode ? " on" : ""), onclick: () => { mode = m; msg.textContent = ""; render(); refreshModels(); } }, label)));
    submit.textContent = mode === "role" ? "Launch" : "Start";
    const refresh = el("button", { className: "mini", title: "Rescan installed agents and their models", onclick: async () => { msg.textContent = "Searching…"; await loadDiscovery(true); fillVendors(); fillKinds(); fillRoles(); await refreshModels(); msg.textContent = ""; } }, "Rescan");
    body.replaceChildren(...(mode === "role"
      ? [el("label", {}, "Role"), role, el("label", {}, "Task"), task, el("label", {}, "Workspace"), space, spaceHint, dir, el("label", {}, "Vendor"), vendor,
        el("label", {}, "Model"), picker.input, picker.list, picker.hint, picker.saveBtn, el("label", { className: "check" }, worktree, " in its own worktree")]
      : [el("label", {}, "Agent"), kind, el("label", {}, "Workspace"), space, spaceHint, el("label", {}, "Name"), nick, el("label", {}, "Model"), picker.input, picker.list, picker.hint, picker.saveBtn]), refresh);
  }

  const fillRoles = () => {
    const names = Object.keys(dc.roles);
    role.replaceChildren(...(names.length ? names.map((n) => optionFor(n, n)) : [optionFor("", "No roles")]));
    if (!names.length) msg.textContent = "No roles configured. Create them in the Models tab of the Shepherd panel.";
  };

  async function launch() {
    const model = picker.input.value.trim();
    if (mode === "plain") {
      if (!kind.value) { msg.textContent = "Choose an installed agent."; return; }
      submit.disabled = true; msg.textContent = "Starting…";
      const typed = nick.value.trim(), name = sanitizeAgentName(typed);
      if (typed && !name) { msg.textContent = "Name must start with a letter; use only letters, numbers, - and _."; return; }
      if (typed && name !== typed) { nick.value = name; flash(`Name updated to “${name}”`); }
      const started = await quickStartAgent({ kind: kind.value, name, model, workspaceId: space.value || undefined });
      submit.disabled = false;
      if (!started) { msg.textContent = `Could not start: ${ws.lastError || "unknown error"}`; return; }
      flash(`Started ${kind.value} agent`); onDone?.(started); return;
    }
    if (shepherdOff()) { msg.textContent = "Enable Shepherd first (see the notice below the panes)."; return; }
    if (!role.value || !task.value.trim()) { msg.textContent = "Choose a role and enter a task."; return; }
    const params = { role: role.value, task: task.value.trim(), worktree: worktree.checked };
    if (taskId !== null) params.task_id = String(taskId);
    submit.disabled = true; msg.textContent = space.value ? "Preparing workspace…" : "Launching…";
    let note = "";
    if (space.value) {
      try { const target = await rootForWorkspace(space.value); if (target.root) params.root = target.root; params.workspace_id = space.value; note = target.note ?? ""; }
      catch (e) { submit.disabled = false; msg.textContent = `Could not prepare workspace: ${e}`; return; }
    } else if (dir.value.trim()) params.root = dir.value.trim();
    if (vendor.value) params.vendor = vendor.value;
    if (model) params.model = model;
    msg.textContent = "Launching…";
    // `shepherd.call` carries `workspace_id`, which the typed `shepherd.agent.spawn` (frozen shape) cannot.
    const out = await act("shepherd.call", { op: "spawn", args: params });
    const r = out && { agent: out.data };
    submit.disabled = false;
    if (!r) { msg.textContent = `Could not launch: ${ws.lastError || "unknown error"}`; return; }
    flash(note ? `Launched agent ${r.agent.id}. ${note}` : `Launched agent ${r.agent.id}`);
    onDone?.(r.agent);
  }

  const form = el("div", { className: "aform" }, seg, body, msg, el("div", { className: "row" }, submit, el("button", { className: "mini", onclick: () => onCancel?.() }, "Cancel")));
  form.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") onCancel?.(); });
  fillWorkspaces();
  render();
  loadDiscovery().then(() => { fillVendors(); fillKinds(); fillRoles(); fillWorkspaces(); render(); refreshModels(); });
  return form;
}

// Starts a plain agent (no role) in a new tab of the active space: `agent.start` needs a pane that
// sits at a shell prompt. Returns { pane } or null (the failure is already in the status bar).
async function quickStartAgent({ kind, name, model, workspaceId = ws.wid }) {
  const cwd = (workspaceId ? cwdOfWorkspace(workspaceId) : activeCwd()) || undefined;
  let pane = null;
  if (workspaceId) {
    const r = await act("tab.create", { workspace_id: workspaceId, focus: true, cwd });
    if (r) { ws.wid = workspaceId; ws.tid = r.tab.tab_id; pane = r.root_pane.pane_id; }
  } else {
    const r = await act("workspace.create", { focus: true, cwd });
    if (r) { ws.wid = r.workspace.workspace_id; ws.tid = r.tab.tab_id; pane = r.root_pane.pane_id; }
  }
  if (!pane) return null;
  const flag = modelFlagFor(kind), args = model && flag ? [flag, model] : undefined;
  // Two failures are worth retrying: a fresh pane whose shell is not ready yet (a moment), and a name
  // taken since we looked (the next free one). Anything else is reported as it is.
  const taken = () => new Set(ws.snap?.agents.map((x) => x.name).filter(Boolean));
  let started = null, lastError = "";
  for (let attempt = 0; attempt < 14 && !started; attempt++) {
    const agentName = name || uniqueName(kind, taken());
    try { started = await srv("agent.start", { name: agentName, kind, pane_id: pane, args, timeout_ms: 30000 }); }
    catch (e) {
      lastError = String(e);
      if (lastError.includes("agent_pane_busy")) { await new Promise((r) => setTimeout(r, 300)); continue; }
      if (!name && lastError.includes("agent_name_taken")) { await refreshSnapshot(); continue; }
      break;
    }
  }
  if (!started) { ws.lastError = lastError; flash(lastError); return null; }
  scheduleRefresh();
  return { pane };
}

// Rows for the agents list: what the server detected in panes plus Shepherd registry agents
// whose pane shows no recognised program. Used by the sidebar.
const STATE_GROUP = { starting: "working", working: "working", running: "working", blocked: "blocked", "needs-human": "blocked", done: "done", completed: "done" };
const AGENT_STATUSES = ["blocked", "working", "done", "idle"];

function agentRows(snap, registry) {
  const rows = [], seen = new Set();
  for (const a of snap.agents) {
    if (!a.agent && !a.shepherd) continue;
    seen.add(a.pane_id);
    rows.push({
      status: AGENT_STATUSES.includes(a.agent_status) ? a.agent_status : "idle", pane: a.pane_id, sid: a.shepherd?.id, sstate: a.shepherd?.state,
      title: a.shepherd ? `${a.shepherd.role} (${a.shepherd.id})` : a.name || a.display_agent || a.agent,
      sub: a.shepherd?.notice || baseName(a.cwd) || a.terminal_title_stripped || "", canPrompt: !!a.agent,
    });
  }
  for (const r of registry) {
    if (r.pane && seen.has(r.pane)) continue;
    rows.push({ status: STATE_GROUP[r.state] ?? "idle", pane: r.pane || null, sid: r.id, sstate: r.state, title: `${r.role} (${r.id})`, sub: r.error || r.task_text || "", canPrompt: false });
  }
  return rows;
}

// Attaches an existing agent to a task, or detaches it (taskId null). The server has no method for it, so the
// desktop edits the agent registry (see setup.rs). Returns true on success; the failure is shown in the bar.
async function assignAgent(agentId, taskId) {
  try { await invoke("assign_agent_task", { agentId, task: taskId, root: projectRoot() }); return true; }
  catch (e) { ws.lastError = String(e); flash(String(e)); return false; }
}

const isFinished = (row) => !!row.sid && TERMINAL_STATES.includes(row.sstate);
