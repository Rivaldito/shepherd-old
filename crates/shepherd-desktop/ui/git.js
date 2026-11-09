// Git tab, like the TUI: worktrees with dirty/ahead/behind, linked agent and PR. Read-only.
// No polling: git/gh can be slow (and gh hits the network), so it loads on open and on "Refresh".
let gt = { status: null, agents: [], sel: null, loading: false };

async function drawGit() {
  $("list").replaceChildren(el("div", { className: "empty" }, "Loading worktrees…"));
  $("detail").replaceChildren();
  gt.loading = true;
  try {
    [gt.status, gt.agents] = await Promise.all([invokeP("git_status"), invoke("agent_list")]);
  } catch (e) { gt.status = null; gt.loading = false; return $("list").replaceChildren(el("div", { className: "empty" }, String(e))); }
  gt.loading = false;
  if (tab === "git") renderGit(); // the user may have moved to another tab while git was running
}

function renderGit() {
  const st = gt.status, rows = st.worktrees;
  if (!rows.some((w) => w.path === gt.sel)) gt.sel = rows[0]?.path ?? null;
  const items = el("div", { id: "items" });
  for (const w of rows) {
    const badge = w.is_clean ? el("span", { className: "badge ok" }, "[clean]") : el("span", { className: "badge warn" }, `[dirty ${w.dirty_count}]`);
    const meta = w.ahead || w.behind ? `+${w.ahead} -${w.behind}` : w.is_main ? "main" : "";
    items.append(el("button", { className: "item" + (w.path === gt.sel ? " sel" : ""), onclick: () => { gt.sel = w.path; renderGit(); } },
      el("span", {}, (w.branch || "(no branch)") + " ", badge), el("small", {}, meta)));
  }
  const list = [items];
  if (st.gh_note || (!st.gh_available && rows.length)) list.push(el("div", { className: "dim-note" }, st.gh_note || "`gh` is unavailable, so pull requests are hidden."));
  list.push(el("button", { id: "new", onclick: drawGit }, "Refresh"));
  $("list").replaceChildren(...list);

  const w = rows.find((x) => x.path === gt.sel);
  if (!w) return $("detail").replaceChildren(el("div", { className: "empty" }, st.error
    ? `Could not read git status at ${st.root}: ${st.error}` : `No worktrees in ${st.root}.`));

  const block = (t, body) => el("div", { className: "block" }, el("h4", {}, t), el("pre", {}, body));
  const detail = el("div", { className: "blocks" });
  detail.append(block("WORKTREE STATUS:", `Directory: ${w.path}\nActive branch: ${w.branch || "(no branch)"}\nUpstream: ${w.upstream ?? "none configured"}`));
  if (w.pr) detail.append(el("div", { className: "info" }, `LINKED PULL REQUEST:\n#${w.pr.number} ${w.pr.state}${w.pr.is_draft ? " [draft]" : ""} ${w.pr.title} (${w.pr.url || "no URL"})`));
  if (w.agent_id) detail.append(el("div", { className: "info" }, `LINKED AGENT:\nAgent '${w.agent_id}' is assigned to this worktree.`));
  const a = gt.agents.find((x) => x.id === w.agent_id);
  detail.append(block("SNAPSHOTS:", a ? (a.snapshots ? `Agent ${a.id}: ${a.snapshots} snapshot(s); latest ${a.last_snapshot}.` : `Agent ${a.id}: no snapshots yet.`) : "No active agent here."));
  const badges = [];
  if (w.is_main) badges.push(el("span", { className: "badge acc" }, "[main]"));
  badges.push(w.is_clean ? el("span", { className: "badge ok" }, "[clean]") : el("span", { className: "badge warn" }, `[dirty ${w.dirty_count}]`));
  $("detail").replaceChildren(el("div", { className: "head" }, `WORKTREE: ${w.path}`, ...badges, el("span", { className: "state" })),
    el("div", { className: "meta" }, `Branch: ${w.branch || "(no branch)"} | Ahead: ${w.ahead} | Behind: ${w.behind} | Agent: ${w.agent_id ?? "none"}`), detail);
}
