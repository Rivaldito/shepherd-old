// Runs tab: persisted pattern runs, same list + detail layout as the TUI. Can launch a pattern and
// pause / resume / stop a run, like `shepherd pattern run|pause|resume|stop`.
let rn = { list: [], sel: null, raw: "", patterns: [], launching: false, form: null, confirmStop: null, busy: false }; // sel: run id

const runBadge = (s) => ({ running: ["[RUNNING]", "ok"], paused: ["[PAUSED]", "warn"], stalled: ["[STALLED]", "warn"],
  degraded: ["[DEGRADED]", "warn"], failed: ["[FAILED]", "bad"], done: ["[DONE]", "dim"], stopped: ["[STOPPED]", "dim"] }[s] ?? [`[${String(s).toUpperCase()}]`, "dim"]);

function applyRuns(raw) {
  rn.raw = raw; rn.list = JSON.parse(raw);
  if (!rn.list.some((r) => r.id === rn.sel)) rn.sel = rn.list[0]?.id ?? null;
  renderRuns();
}

async function drawRuns() {
  poll("runs", refreshRuns); // runs live in a file
  rn.patterns = await invokeP("pattern_list").catch(() => []);
  try { applyRuns(JSON.stringify(await invokeP("run_list"))); }
  catch (e) { $("list").replaceChildren(el("div", { className: "empty" }, String(e))); $("detail").replaceChildren(); }
}

async function refreshRuns() {
  try { const raw = JSON.stringify(await invokeP("run_list")); if (raw !== rn.raw) applyRuns(raw); } catch (_) { /* keep last view */ }
}

// Built once (launcher.js) so a refresh never wipes the objective being typed.
function runLauncher() {
  return patternRunForm({ onCancel: () => { rn.launching = false; renderRuns(); },
    onStarted: async ({ run }) => { rn.launching = false; rn.sel = run.id; await refreshRuns(); } });
}

// pause / resume / stop; stopping asks for a second click on the same button (no pop-ups).
async function controlRun(r, action) {
  if (action === "stop" && rn.confirmStop !== r.id) { rn.confirmStop = r.id; return renderRuns(); }
  rn.confirmStop = null; rn.busy = true; renderRuns();
  const root = projectRoot() || undefined;
  const res = action === "pause" ? await act("shepherd.pattern.run.pause", { id: r.id, root })
    : action === "resume" ? await act("shepherd.pattern.run.resume", { id: r.id, root })
    : await act("shepherd.pattern.run.stop", { id: r.id, root, confirm: true });
  rn.busy = false;
  if (!res) flash(`Could not ${{ pause: "pause", resume: "resume", stop: "stop" }[action]}: ${ws.lastError || "unknown error"}`);
  await refreshRuns(); renderRuns();
}

function runControls(r) {
  const live = ["running", "stalled", "degraded"].includes(r.state);
  const btn = (label, action, title) => el("button", { className: "btn small", disabled: rn.busy, title, onclick: () => controlRun(r, action) }, label);
  return [
    live ? btn("Pause", "pause", "Agents stop receiving bus messages") : "",
    r.state === "paused" ? btn("Resume", "resume", "Resume delivery of pending messages") : "",
    live || r.state === "paused" ? btn(rn.confirmStop === r.id ? "Confirm: stop and close agents" : "Stop", "stop", "Close the agents in this run") : "",
  ];
}

function renderRuns() {
  const items = el("div", { id: "items" });
  for (const r of rn.list) {
    const [txt, cls] = runBadge(r.state);
    items.append(el("button", { className: "item" + (r.id === rn.sel ? " sel" : ""), onclick: () => { rn.sel = r.id; renderRuns(); } },
      el("span", {}, `${r.pattern} (${r.id}) `, el("span", { className: "badge " + cls }, txt)),
      el("small", {}, `${r.live_agents}/${(r.agents ?? []).length} agents`)));
  }
  $("list").replaceChildren(items, el("div", { className: "panel-actions" },
    el("button", { className: "btn small", onclick: () => { rn.launching = true; rn.form ??= runLauncher(); renderRuns(); } }, "+ Run pattern"),
    cleanButton("Clear", cleanRuns, renderRuns, "Remove completed runs and agents that no longer exist"),
    el("button", { className: "btn small", onclick: refreshRuns }, "Refresh")));
  if (rn.launching) {
    rn.form.fill(rn.patterns);
    return $("detail").replaceChildren(el("div", { className: "head" }, "RUN PATTERN", el("span", { className: "state" })), el("div", { className: "blocks" }, rn.form.el));
  }
  const r = rn.list.find((x) => x.id === rn.sel);
  if (!r) return $("detail").replaceChildren(el("div", { className: "empty" },
    "No pattern runs yet. Start one with “+ Run pattern” (the same as `shepherd pattern run`)."));

  const [txt, cls] = runBadge(r.state);
  const block = (title, body) => el("div", { className: "block" }, el("h4", {}, title), el("pre", {}, body));
  const detail = el("div", { className: "blocks" });
  if (r.stalled_reason) detail.append(el("div", { className: "notice" }, "RUN STALLED:\n" + r.stalled_reason));
  detail.append(block("OBJECTIVE:", r.task || "No objective."));
  if (r.error) detail.append(block("ERROR:", r.error));
  detail.append(block("AGENTS:", (r.agents ?? []).map((a) =>
    `${a.start ? "▶ " : "  "}${a.id} (${a.role}) [${a.state}]${[a.vendor, a.model].filter(Boolean).length ? " " + [a.vendor, a.model].filter(Boolean).join("/") : ""}`).join("\n") || "None."));
  detail.append(block("TOPICS:", (r.topics ?? []).join(", ") || "None."));
  if (r.quiesced) detail.append(block("NOTE:", "Paused due to inactivity; a new message on one of its topics will reopen it."));
  const meta = [`Topology: ${r.kind}`, `Created: ${r.created_at}`, `Updated: ${r.updated_at}`, r.finished_at && `Finished: ${r.finished_at}`, r.worktree && `Worktree: ${r.worktree}`].filter(Boolean);
  $("detail").replaceChildren(
    el("div", { className: "head" }, `RUN: ${r.pattern} (ID: ${r.id})`, el("span", { className: "badge " + cls }, txt), el("span", { className: "state" }),
      ...runControls(r),
      el("button", { className: "btn small", onclick: () => showMonitorTab(`run:${r.id}`) }, "View messages"),
      el("button", { className: "btn small", onclick: () => openMonitorWindow(`run:${r.id}`) }, "Open in new window")),
    el("div", { className: "meta" }, meta.join(" | ")), detail);
}
