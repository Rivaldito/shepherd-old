// Agents tab, laid out like the TUI: list (role (id), state badge, vendor / NEEDS YOU) + detail.
// Live from the server's registry when it runs (so actions and state agree), else the saved file.
// Actions: launch, go to terminal, kill / clean (two clicks), resume.
let ag = { list: [], tasks: [], sel: null, raw: "", live: false, creating: false, form: null }; // sel: agent id

const needsYou = (a) => ["blocked", "needs-human"].includes(a.state) || !!(a.notice ?? "").trim();
const stateBadge = (s) => {
  if (["working", "running", "starting"].includes(s)) return ["[WORKING]", "ok"];
  if (["blocked", "needs-human"].includes(s)) return ["[BLOCKED]", "warn"];
  if (["done", "completed"].includes(s)) return ["[DONE]", "dim"];
  if (s === "failed") return ["[FAILED]", "bad"];
  if (s === "killed") return ["[KILLED]", "bad"];
  if (s === "exited") return ["[EXITED]", "dim"];
  return ["[IDLE]", "dim"];
};

async function fetchAgents() {
  const tasks = await invokeP("task_list").catch(() => []); // the project's tasks, to assign agents to
  if (sb.status?.running) {
    try { return { live: true, tasks, list: (await invoke("api_call", { method: "shepherd.agent.list", params: {} })).agents }; }
    catch (_) { /* orchestration layer off or server gone: fall back to the file */ }
  }
  return { live: false, tasks, list: await invoke("agent_list") };
}

function applyAgents({ live, list, tasks }) {
  const raw = JSON.stringify([live, list, tasks]);
  if (raw === ag.raw) return;
  ag.raw = raw; ag.live = live; ag.list = list; ag.tasks = tasks;
  if (!ag.list.some((a) => a.id === ag.sel)) ag.sel = ag.list[0]?.id ?? null;
  renderAgents();
}

async function drawAgents() {
  poll("agents", refreshAgents);
  ag.raw = "";
  try { applyAgents(await fetchAgents()); }
  catch (e) { $("list").replaceChildren(el("div", { className: "empty" }, String(e))); }
}

async function refreshAgents() {
  try { applyAgents(await fetchAgents()); } catch (_) { /* keep the last good view */ }
}

// Runs an action, then re-reads the list.
async function agentAction(method, params) {
  await act(method, params);
  ag.raw = ""; refreshAgents();
}

async function closeAndRemoveAgent(a) {
  if (!TERMINAL_STATES.includes(a.state) && !await act("shepherd.agent.kill", { id: a.id })) return;
  await act("shepherd.agent.clean", { ids: [a.id] });
  ag.raw = ""; refreshAgents();
}

function actionButton(label, run, extra = "") {
  return el("button", { className: "btn small" + extra, onclick: run }, label);
}

function listFooter() {
  const live = ag.live;
  const buttons = [el("button", { className: "btn small", disabled: !live, title: live ? "" : "Requires the server to be running", onclick: () => {
    ag.creating = true; ag.form ??= spawnForm({ root: typeof activeCwd === "function" ? activeCwd() : "", onDone: (agent) => { ag.creating = false; ag.form = null; ag.sel = agent.id ?? ag.sel; ag.raw = ""; refreshAgents(); }, onCancel: () => { ag.creating = false; ag.form = null; renderAgents(); } });
    renderAgents();
  } }, "+ New")];
  if (live) buttons.push(actionButton("Resume", () => agentAction("shepherd.agent.resume", {})));
  buttons.push(el("button", { className: "btn small", onclick: () => { ag.raw = ""; refreshAgents(); } }, "Refresh"));
  return el("div", { className: "panel-actions" }, ...buttons, el("span", { className: "dim" }, live ? "live" : "saved snapshot"));
}

// "Task": which task of the project this agent works for, with a way to change or clear it.
function taskAssignBlock(a) {
  // A run's agents carry the run id; giving them a task would cut them off from the run.
  if (isRunAgent(a)) return el("div", { className: "block" }, el("h4", {}, "PROJECT TASK:"),
    el("div", { className: "dim" }, `Belongs to run ${a.task_id}; its task is the run task (see the Monitor tab).`));
  const current = ag.tasks.find((t) => String(t.id) === String(a.task_id ?? ""));
  const pick = el("select", {}, el("option", { value: "" }, "(none)"),
    ...ag.tasks.map((t) => el("option", { value: String(t.id), selected: current?.id === t.id }, `#${t.id} ${t.title}`)));
  const save = el("button", { className: "btn small", disabled: !ag.tasks.length, onclick: async () => {
    if (await assignAgent(a.id, pick.value ? Number(pick.value) : null)) { flash(pick.value ? `Agent ${a.id} assigned to task #${pick.value}` : `Agent ${a.id} unassigned`); ag.raw = ""; refreshAgents(); }
  } }, "Save");
  return el("div", { className: "block" }, el("h4", {}, "PROJECT TASK:"),
    el("div", { className: "dim" }, current ? `Assigned to #${current.id} ${current.title}` : a.task_id ? `Assigned to task #${a.task_id}, which is not in this project` : "No task assigned"),
    el("div", { className: "assign" }, pick, save), ag.tasks.length ? "" : el("div", { className: "dim small" }, "This project has no tasks. Create one in the Tasks tab."));
}

function renderAgents() {
  const items = el("div", { id: "items" });
  for (const a of ag.list) {
    const [txt, cls] = stateBadge(a.state);
    items.append(el("button", { className: "item" + (a.id === ag.sel && !ag.creating ? " sel" : ""), onclick: () => { ag.sel = a.id; ag.creating = false; renderAgents(); } },
      el("span", {}, `${a.role} (${a.id}) `, el("span", { className: "badge " + cls }, txt)),
      el("small", {}, needsYou(a) ? "⚠ NEEDS YOU" : a.vendor)));
  }
  $("list").replaceChildren(items, listFooter());
  if (ag.creating) return $("detail").replaceChildren(el("div", { className: "head" }, "LAUNCH AGENT", el("span", { className: "state" })), el("div", { className: "blocks" }, ag.form));
  const a = ag.list.find((x) => x.id === ag.sel);
  if (!a) return $("detail").replaceChildren(el("div", { className: "empty" },
    "No agents in the registry. Launch one with “+ New” (the server must be running)."));

  const [txt, cls] = stateBadge(a.state);
  const block = (title, body) => el("div", { className: "block" }, el("h4", {}, title), el("pre", {}, body));
  const detail = el("div", { className: "blocks" });
  if (needsYou(a)) detail.append(el("div", { className: "notice" }, "NEEDS YOUR ATTENTION:\nWaiting for human input: " +
    ((a.notice ?? "").trim() || "Action required in the native terminal (dialog, login, or confirmation).")));
  detail.append(block("ASSIGNED TASK:", a.task_text || "No assigned task description."));
  detail.append(taskAssignBlock(a));
  const info = [["Worktree", a.worktree], ["Branch", a.branch], ["Parent", a.parent_id], ["Root", a.root], ["Task", a.task_id],
    ["Active skills", (a.active_skills ?? []).join(", ")], ["Started", a.started], ["Updated", a.updated]].filter(([, v]) => v);
  if (info.length) detail.append(block("DETAILS:", info.map(([k, v]) => `${k}: ${v}`).join("\n")));
  if (a.result) detail.append(block("RESULT:", a.result));
  if (a.error) detail.append(block("ERROR:", a.error));
  detail.append(block("SNAPSHOTS:", a.snapshots ? `${a.snapshots} snapshot(s); latest: ${a.last_snapshot}.` : "No snapshots yet."));

  const actions = [];
  if (ag.live && a.pane) actions.push(el("button", { className: "btn small", onclick: () => focusPane(a.pane) }, "Go to terminal"));
  if (ag.live) actions.push(actionButton("Close", () => closeAndRemoveAgent(a)));
  $("detail").replaceChildren(
    el("div", { className: "head" }, `AGENT: ${a.role} (ID: ${a.id})`, el("span", { className: "badge " + cls }, txt), el("span", { className: "state" }), ...actions),
    el("div", { className: "meta" }, `Vendor: ${a.vendor} | Model: ${a.model || "default"} | Terminal pane: ${a.pane || "none"}`),
    detail);
}
