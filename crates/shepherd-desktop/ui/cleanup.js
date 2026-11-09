// Cleanup of what piles up: finished runs (and their agents), done tasks and the message bus.
// Every button needs a second click on itself (no pop-ups); each is also in the command palette.
const cl = { busForce: false };

function cleanButton(label, run, rerender, title = "") {
  return el("button", { className: "btn small", title, onclick: async () => {
    await run(); rerender();
  } }, label);
}

const cleanRoot = () => projectRoot() || undefined;

// Runs that are over, plus every agent that is already gone (their panes and sessions).
async function cleanRuns() {
  try {
    const runs = (await srv("shepherd.call", { op: "runs_clean", args: { root: cleanRoot() } })).data.removed;
    const agents = (await srv("shepherd.agent.clean", { ids: [] })).cleaned?.length ?? 0;
    flash(`Cleanup: ${runs} completed run(s) and ${agents} removed agent(s)`);
    rn.raw = ""; scheduleRefresh();
  } catch (e) { flash(`Could not clean up: ${e}`); }
}

// Messages, topic events, offsets and subscriptions. With live agents the server asks for confirmation.
async function cleanBus() {
  try {
    const out = (await srv("shepherd.call", { op: "bus_clean", args: { force: cl.busForce } })).data;
    cl.busForce = false; flash(`Message bus cleared: ${out.removed} message(s)`);
    mo.ui = null;
  } catch (e) {
    if (/confirmation_required/.test(String(e))) { cl.busForce = true; flash("Agents are still active. Press again to clear anyway (this will interrupt their communication)."); return; }
    flash(`Could not clear message bus: ${e}`);
  }
}

// Archives the tasks that are done.
async function archiveDoneTasks() {
  const done = tk.list.filter((t) => ["done", "completed"].includes(t.state.toLowerCase()));
  let n = 0;
  for (const t of done) {
    try { await srv("shepherd.task.archive", { id: String(t.id), root: cleanRoot() }); n++; } catch (e) { flash(`Could not archive #${t.id}: ${e}`); }
  }
  flash(`${n} task(s) archived`); tk.raw = ""; refreshTasks();
}
