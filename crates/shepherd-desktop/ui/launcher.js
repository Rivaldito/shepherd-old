// The one place that launches a pattern run. Runs, Tasks and Patterns all use it, so the form, the
// target space, the task link and the agent-limit handling are identical everywhere.

// Starts a run in `workspace_id` (the space selected in the UI). It goes through `shepherd.call` because the
// typed `shepherd.pattern.run.start` has a frozen shape without a workspace.
// A pattern that needs more agents than `limits.max_concurrent_agents` is a deliberate
// request here, so the server's confirmation is given and the user is told, instead of failing.
async function startPatternRun(params) {
  const { pattern, task, root, workspace_id } = params;
  try {
    const out = await srv("shepherd.call", { op: "pattern_run_start", args: { pattern, task, root, workspace_id } });
    scheduleRefresh(); return { run: { run: out.data }, overLimit: false };
  } catch (e) {
    if (!/confirmation_required: max_concurrent_agents/.test(String(e))) { ws.lastError = String(e); flash(String(e)); return null; }
  }
  try {
    const out = await srv("shepherd.call", { op: "pattern_run_start", args: { pattern, task, root, workspace_id, confirm_over_limit: true } });
    scheduleRefresh(); return { run: { run: out.data }, overLimit: true };
  } catch (e) { ws.lastError = String(e); flash(String(e)); return null; }
}

// Form for launching a pattern in the active space.
//   task: a task object -> the objective starts with its text and the run is linked to it ("Task #N:")
//   pattern: a pattern name -> that one is fixed, no picker
//   onStarted(result, target): after a successful launch   onCancel(): shows a Cancel button
function patternRunForm({ task = null, pattern = null, onStarted, onCancel }) {
  const pick = el("select", {});
  const objective = el("textarea", { className: "inline", rows: task ? 4 : 3, placeholder: "Run objective (optional)", value: task ? taskPrompt(task) : "" });
  const where = el("div", { className: "dim small" });
  const msg = el("div", { className: "dim small" });
  const go = el("button", { className: "btn small", onclick: async () => {
    if (shepherdOff()) { msg.textContent = "Enable Shepherd first (see the notice below the panes)."; return; }
    if (!pick.value) { msg.textContent = "Choose a pattern."; return; }
    if (!ws.wid) { msg.textContent = "No active workspace."; return; }
    go.disabled = true; msg.textContent = "Preparing workspace…";
    let target;
    try { target = await rootForWorkspace(ws.wid); } catch (e) { go.disabled = false; msg.textContent = `Could not prepare workspace: ${e}`; return; }
    const text = task ? ensureTaskPrefix(objective.value, task) : objective.value.trim();
    msg.textContent = "Creating agents…";
    const res = await startPatternRun({ pattern: pick.value, task: text || undefined, root: target.root || undefined, workspace_id: ws.wid });
    go.disabled = false;
    if (!res) { msg.textContent = `Could not run: ${ws.lastError || "unknown error"}`; return; }
    const n = res.run.run.agents.length;
    flash(`Pattern ${pick.value} started${task ? ` for task #${task.id}` : ""}: ${n} agent(s)${res.overLimit ? " (exceeds the concurrent agent limit)" : ""}${target.note ? ". " + target.note : ""}`);
    msg.textContent = ""; objective.value = task ? taskPrompt(task) : "";
    onStarted?.({ ...res, run: res.run.run }, target);
  } }, "Run pattern");
  const refreshWhere = () => {
    const w = ws.snap?.workspaces.find((x) => x.workspace_id === ws.wid);
    where.textContent = w ? `A pattern agent will be created in the active workspace for each pattern agent «${w.label || "Workspace " + w.number}»${task ? " and the run will be linked to this task" : ""}.` : "Create a workspace before running a pattern.";
  };
  // Called on every redraw with the patterns of the project: keeps the choice, never the typed objective.
  const fill = (patterns) => {
    const chosen = pattern ?? pick.value;
    const shown = pattern ? patterns.filter((p) => p.name === pattern) : patterns;
    pick.replaceChildren(...(shown.length ? shown.map((p) => el("option", { value: p.name }, `${p.name} · ${p.kind} · ${p.agents_count} agent(s)`)) : [el("option", { value: "" }, "No patterns in this project")]));
    if (shown.some((p) => p.name === chosen)) pick.value = chosen;
    pick.disabled = !!pattern; go.disabled = !shown.length; refreshWhere();
  };
  const node = el("div", { className: "aform" }, ...(pattern ? [] : [el("label", {}, "Pattern"), pick]),
    el("label", {}, task ? "Objective (start with “Task #N:” to link the run)" : "Objective"), objective, where, msg,
    el("div", { className: "row" }, go, ...(onCancel ? [el("button", { className: "mini", onclick: onCancel }, "Cancel")] : [])));
  node.addEventListener("keydown", (e) => { e.stopPropagation(); if (e.key === "Escape") onCancel?.(); });
  fill([]);
  return { el: node, fill };
}
