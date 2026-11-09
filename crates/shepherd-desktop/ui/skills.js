// Skills tab, like the TUI: "By Agent" (which skills an agent has active) and "Discover". Read-only.
let sk = { mode: 0, catalog: null, agents: [], agent: null, active: [], problems: [], sel: null };

const SCOPE = { default: "dim", user: "acc", repo: "ok" };
const scopeBadge = (s) => el("span", { className: "badge " + (SCOPE[s] ?? "dim") }, `[${s}]`);

async function drawSkills() {
  try {
    sk.catalog = await invokeP("skill_catalog");
    sk.agents = await invoke("agent_list");
    if (!sk.agents.some((a) => a.id === sk.agent)) sk.agent = sk.agents[0]?.id ?? null;
    await loadAgentSkills();
  } catch (e) { return $("list").replaceChildren(el("div", { className: "empty" }, String(e))); }
  renderSkills();
}

async function loadAgentSkills() {
  sk.active = []; sk.problems = [];
  if (sk.mode !== 0 || !sk.agent) return;
  const r = await invokeP("skill_agent", { agentId: sk.agent });
  sk.active = r.active; sk.problems = r.problems;
}

function skillRows() {
  const byName = new Map(sk.catalog.skills.map((s) => [s.name, s]));
  if (sk.mode === 1) return sk.catalog.skills.map((s) => ({ skill: s, title: s.name, meta: s.global ? "global" : "" }));
  const on = new Map(sk.active.map((a) => [a.name, a.level]));
  const rows = sk.catalog.skills.map((s) => ({ skill: s, active: on.has(s.name), level: on.get(s.name), title: `${on.has(s.name) ? "[✓]" : "[ ]"} ${s.name}` }));
  for (const [name, level] of on) if (!byName.has(name)) // recorded as installed but no longer in the catalog
    rows.push({ skill: { name, scope: "default", description: "Installed on agent but missing from catalog.", problems: [] }, active: true, level, title: `[✓] ${name}`, meta: "not found" });
  return rows;
}

function renderSkills() {
  const modes = el("div", { className: "filters" }, ...["By Agent", "Discover"].map((m, i) =>
    el("button", { className: i === sk.mode ? "sel" : "", onclick: async () => { sk.mode = i; sk.sel = null; await loadAgentSkills(); renderSkills(); } }, m)));
  const head = [modes];
  if (sk.mode === 0 && sk.agents.length) {
    const pick = el("select", { className: "agentpick", onchange: async () => { sk.agent = pick.value; await loadAgentSkills(); renderSkills(); } },
      ...sk.agents.map((a) => el("option", { value: a.id, selected: a.id === sk.agent }, `${a.role} (${a.id})`)));
    head.push(pick);
  }
  const rows = sk.mode === 0 && !sk.agents.length ? [] : skillRows();
  if (!rows.some((r) => r.skill.name === sk.sel)) sk.sel = rows[0]?.skill.name ?? null;
  const items = el("div", { id: "items" });
  for (const r of rows)
    items.append(el("button", { className: "item" + (r.skill.name === sk.sel ? " sel" : "") + (sk.mode === 0 && !r.active ? " off" : ""), onclick: () => { sk.sel = r.skill.name; renderSkills(); } },
      el("span", {}, r.title + " ", scopeBadge(r.skill.scope)), el("small", {}, r.meta ?? "")));
  $("list").replaceChildren(...head, items, el("button", { id: "new", onclick: drawSkills }, "Refresh"));

  const row = rows.find((r) => r.skill.name === sk.sel);
  if (!row) return $("detail").replaceChildren(el("div", { className: "empty" }, sk.mode === 0 && !sk.agents.length
    ? "No agents in the registry. Open Discover to browse available skills." : "No skills."));
  const s = row.skill, block = (t, body) => el("div", { className: "block" }, el("h4", {}, t), el("pre", {}, body));
  const detail = el("div", { className: "blocks" });
  const badges = [scopeBadge(s.scope)];
  let meta;
  if (sk.mode === 0) {
    badges.push(el("span", { className: "badge " + (row.active ? "ok" : "dim") }, row.active ? "[active]" : "[inactive]"));
    meta = `Agent: ${sk.agent} | Scope: ${s.scope} | Level: ${row.level ?? "—"}`;
    detail.append(block("DESCRIPTION:", s.description));
    detail.append(el("div", { className: "info" }, "APPLYING CHANGES:\n• Adding or removing skills takes effect after restarting the agent.\n• Skill text edits take effect immediately."));
    if (sk.problems.length) detail.append(el("div", { className: "notice" }, "Problems resolving skills:\n" + sk.problems.join("\n")));
  } else {
    if (s.global) badges.push(el("span", { className: "badge acc" }, "[global]"));
    if (!s.enabled) badges.push(el("span", { className: "badge bad" }, "[con errores]"));
    meta = `Scope: ${s.scope} | Global: ${s.global ? "Yes" : "No"} | Enabled: ${s.enabled ? "Yes" : "No"} | ${s.dir}`;
    detail.append(block("DESCRIPTION:", s.description));
    if ((s.problems ?? []).length) detail.append(el("div", { className: "notice" }, "Problemas detectados:\n" + s.problems.join("\n")));
    detail.append(block("SKILL.md:", s.body));
  }
  $("detail").replaceChildren(el("div", { className: "head" }, `SKILL: ${s.name}`, ...badges, el("span", { className: "state" })),
    el("div", { className: "meta" }, meta), detail);
}
