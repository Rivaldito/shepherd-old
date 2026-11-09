// Visual pattern editor. Agents and topics are nodes; `publishes` (agent→topic) and
// `consumes` (topic→agent) are edges. Node positions live only in memory (the YAML has no layout).
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, ...kids) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  e.append(...kids); return e;
};
const KINDS = ["orchestrator-worker", "hierarchical", "blackboard", "market"];
const NW = 160, NH = 48;
let pe = null; // {pat, source, isNew, pos, sel, problems, cfg, path}

const blankPattern = () => ({ name: "", kind: "orchestrator-worker", description: "", topics: [], agents: [] });
const agentKey = (a) => "a:" + a.id, topicKey = (t) => "t:" + t.name;

function edgesOf(pat) {
  const out = [];
  for (const a of pat.agents) {
    for (const t of a.publishes) out.push({ from: agentKey(a), to: "t:" + t, agent: a.id, topic: t, list: "publishes" });
    for (const t of a.consumes) out.push({ from: "t:" + t, to: agentKey(a), agent: a.id, topic: t, list: "consumes" });
  }
  return out;
}

// Layered left→right layout: depth = BFS distance from agents that consume nothing.
function autoLayout(pat) {
  const edges = edgesOf(pat), depth = new Map();
  const roots = pat.agents.filter((a) => !a.consumes.length).map(agentKey);
  const queue = (roots.length ? roots : pat.agents.slice(0, 1).map(agentKey)).map((k) => (depth.set(k, 0), k));
  while (queue.length) {
    const k = queue.shift();
    for (const e of edges) if (e.from === k && !depth.has(e.to)) { depth.set(e.to, depth.get(k) + 1); queue.push(e.to); }
  }
  const all = [...pat.agents.map(agentKey), ...pat.topics.map(topicKey)];
  const last = Math.max(0, ...depth.values()) + 1, rows = {}, pos = {};
  for (const k of all) {
    const d = depth.get(k) ?? last;
    pos[k] = { x: 30 + d * 230, y: 30 + (rows[d] = (rows[d] ?? -1) + 1) * 80 };
  }
  return pos;
}

// Rust omits defaulted fields when serializing; the canvas expects them present.
function normalize(pat) {
  for (const a of pat.agents) {
    a.publishes ??= []; a.consumes ??= []; a.count ??= 1; a.start ??= false;
    for (const k of ["vendor", "model", "prompt", "level", "group"]) a[k] ??= null;
  }
  for (const t of pat.topics) { t.partitions ??= 1; t.key ??= null; t.filter ??= null; }
  return pat;
}

function setPattern(pat, source, isNew, path = null) {
  normalize(pat);
  pe = { pat, source, isNew, path, pos: autoLayout(pat), sel: null, problems: [], cfg: pe?.cfg };
}

async function drawPatterns() {
  if (!dc.loaded) loadDiscovery().then(() => { if (pe?.sel?.type === "agent") renderInspector(); });
  const [list, cfg] = await Promise.all([invokeP("pattern_list"), invokeP("get_models").catch(() => null)]);
  const items = el("div", { id: "items" });
  for (const p of list)
    items.append(listItem({ title: p.name, meta: `${p.kind} · ${p.agents_count}a${p.shadowed ? " · tapado" : ""}`, off: p.shadowed,
      active: !!pe && !pe.isNew && pe.pat.name === p.name, onclick: () => openPattern(p.name) }));
  if (pe?.isNew) items.append(listItem({ title: "(new)", active: true, onclick: () => {} }));
  $("list").replaceChildren(items, el("button", { id: "new", onclick: () => newPattern() }, "+ New"));
  if (!pe) return $("detail").replaceChildren(el("div", { className: "empty" }, "Select a pattern or create a new one."));
  pe.cfg = cfg;
  drawEditor();
}

async function openPattern(name) {
  if (!leave("pat:" + name, msgBox())) return;
  try {
    const r = await invokeP("pattern_load", { name });
    setPattern(r.pattern, r.source, false, r.path); pe.problems = r.problems;
  } catch (e) { return setMsg(msgBox(), String(e), "bad"); }
  drawPatterns();
}

function newPattern(from = null) {
  if (!from && !leave("pat:new", msgBox())) return;
  const pat = from ? { ...structuredClone(from), name: "" } : blankPattern();
  const pos = pe?.pos; setPattern(pat, "global", true); if (from && pos) pe.pos = pos;
  dirty = true; drawPatterns();
}

let validateTimer = 0;
function changed() {
  dirty = true;
  const s = $("pstate"); if (s) s.textContent = "● unsaved";
  renderCanvas();
  clearTimeout(validateTimer);
  validateTimer = setTimeout(async () => {
    try { pe.problems = await invokeP("pattern_validate", { pattern: pe.pat }); renderProblems(); }
    catch (e) { setMsg(msgBox(), String(e), "bad"); }
  }, 250);
}

function renderProblems(prefix = "") {
  const lines = pe.problems.map((p) => `[${p.severity}] ${p.path}: ${p.message}`);
  const bad = pe.problems.some((p) => p.severity === "error");
  setMsg(msgBox(), [prefix, ...lines].filter(Boolean).join("\n") || "No issues.", bad ? "bad" : "ok");
}

function drawEditor() {
  const st = el("span", { className: "state", id: "pstate" }, dirty ? "● unsaved" : "");
  const builtin = pe.source === "builtin" && !pe.isNew;
  const save = el("button", { className: "btn primary", disabled: builtin, title: builtin ? "Built in template: use Duplicate" : "", onclick: savePattern }, "Save");
  const head = el("div", { className: "head" }, `PATTERN: ${pe.pat.name || "new"} (${pe.isNew ? "new" : pe.source})`, st, save,
    el("button", { className: "btn", onclick: () => newPattern(pe.pat) }, "Duplicar"));
  // Running needs a saved pattern: the server reads it from disk, not from this editor.
  const runnable = !pe.isNew && !dirty;
  head.append(el("button", { className: "btn", disabled: !runnable, title: runnable ? "Launch pattern agents in the active workspace" : "Save the pattern before running it",
    onclick: () => { pe.runOpen = !pe.runOpen; pe.runForm ??= runPatternForm(); drawEditor(); } }, "Run"));
  if (!pe.isNew && !builtin) {
    const del = el("button", { className: "btn danger", onclick: async () => {
      try { await invokeP("pattern_delete", { name: pe.pat.name }); pe = null; dirty = false; drawPatterns(); }
      catch (e) { setMsg(msgBox(), String(e), "bad"); }
    } }, "Delete");
    head.append(del);
  }
  const tools = el("div", { className: "tools" },
    el("button", { className: "btn", onclick: addAgent }, "+ Agent"),
    el("button", { className: "btn", onclick: addTopic }, "+ Topic"),
    el("button", { className: "btn", onclick: () => { pe.pos = autoLayout(pe.pat); renderCanvas(); } }, "Ordenar"),
    el("span", { className: "hint" }, "Drag a node’s ● handle to another node to connect them. Delete removes the selection."));
  const canvas = el("div", { id: "canvas" });
  $("detail").replaceChildren(head, ...(pe.runOpen && pe.runForm ? [pe.runForm] : []), tools, el("div", { id: "work" }, canvas, el("div", { id: "insp", className: "insp" })), el("pre", { id: "msgs" }));
  renderCanvas(); renderInspector();
  if (pe.problems.length || !pe.isNew) renderProblems(); else setMsg(msgBox(), pe.path ?? "");
}

// "Run": the shared launcher (launcher.js) with this pattern fixed.
function runPatternForm() {
  const f = patternRunForm({ pattern: pe.pat.name, onCancel: () => { pe.runOpen = false; drawEditor(); },
    onStarted: () => { pe.runOpen = false; pe.runForm = null; openPanelTab("runs"); } });
  f.fill([{ name: pe.pat.name, kind: pe.pat.kind, agents_count: (pe.pat.agents ?? []).length }]);
  return f.el;
}

async function savePattern() {
  clearTimeout(validateTimer); // a pending live validation must not overwrite the save message
  try {
    const r = await invokeP("pattern_save", { pattern: pe.pat, source: pe.source, isNew: pe.isNew });
    pe.problems = r.problems; pe.isNew = false; pe.source = r.source; pe.path = r.path; dirty = false;
    await drawPatterns(); renderProblems("Guardado en " + r.path);
  } catch (e) { setMsg(msgBox(), String(e), "bad"); }
}

// ---- model edits -------------------------------------------------------------------------
function uniq(base, taken) { let i = 1; while (taken.includes(base + i)) i++; return base + i; }
function addAgent() {
  const id = uniq("agent", pe.pat.agents.map((a) => a.id));
  const role = pe.cfg ? Object.keys(pe.cfg.roles)[0] ?? "" : "";
  pe.pat.agents.push({ id, role, vendor: null, model: null, prompt: null, count: 1, level: null, publishes: [], consumes: [], group: null, start: false });
  pe.pos["a:" + id] = freeSpot(); select({ type: "agent", id }); changed();
}
function addTopic() {
  const name = uniq("topic", pe.pat.topics.map((t) => t.name));
  pe.pat.topics.push({ name, partitions: 1, key: null, filter: null });
  pe.pos["t:" + name] = freeSpot(); select({ type: "topic", name }); changed();
}
const freeSpot = () => ({ x: 30 + (Object.keys(pe.pos).length % 5) * 40, y: 30 + (Object.keys(pe.pos).length % 7) * 30 });

function connect(fromKey, toKey) {
  const [ft, fn] = [fromKey[0], fromKey.slice(2)], [tt, tn] = [toKey[0], toKey.slice(2)];
  if (ft === tt) return setMsg(msgBox(), "Connect an agent to a topic (not two of the same type).", "bad");
  const agent = pe.pat.agents.find((a) => a.id === (ft === "a" ? fn : tn)), topic = ft === "a" ? tn : fn;
  const list = ft === "a" ? agent.publishes : agent.consumes;
  if (!list.includes(topic)) { list.push(topic); changed(); }
}
function removeSel() {
  const s = pe.sel; if (!s) return;
  if (s.type === "agent") { pe.pat.agents = pe.pat.agents.filter((a) => a.id !== s.id); delete pe.pos["a:" + s.id]; }
  else if (s.type === "topic") {
    pe.pat.topics = pe.pat.topics.filter((t) => t.name !== s.name); delete pe.pos["t:" + s.name];
    for (const a of pe.pat.agents) { a.publishes = a.publishes.filter((t) => t !== s.name); a.consumes = a.consumes.filter((t) => t !== s.name); }
  } else {
    const a = pe.pat.agents.find((x) => x.id === s.agent); a[s.list] = a[s.list].filter((t) => t !== s.topic);
  }
  pe.sel = null; renderInspector(); changed();
}
function select(sel) { pe.sel = sel; renderInspector(); renderCanvas(); }

// ---- canvas ------------------------------------------------------------------------------
function renderCanvas() {
  const box = $("canvas"); if (!box) return;
  const nodes = [...pe.pat.agents.map((a) => ({ key: agentKey(a), type: "agent", a })), ...pe.pat.topics.map((t) => ({ key: topicKey(t), type: "topic", t }))];
  for (const n of nodes) pe.pos[n.key] ??= freeSpot();
  const maxX = Math.max(600, ...nodes.map((n) => pe.pos[n.key].x + NW + 60)), maxY = Math.max(400, ...nodes.map((n) => pe.pos[n.key].y + NH + 60));
  const svg = svgEl("svg", { width: maxX, height: maxY });
  svg.append(svgEl("defs", {}, svgEl("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" },
    svgEl("path", { d: "M0 0L10 5L0 10z", fill: "#7c7c8a" }))));
  svg.addEventListener("pointerdown", (e) => { if (e.target === svg) select(null); });

  const at = (k, right) => ({ x: pe.pos[k].x + (right ? NW : 0), y: pe.pos[k].y + NH / 2 });
  for (const e of edgesOf(pe.pat)) {
    if (!pe.pos[e.from] || !pe.pos[e.to]) continue;
    const a = at(e.from, true), b = at(e.to, false), dx = Math.max(40, Math.abs(b.x - a.x) / 2);
    const d = `M${a.x} ${a.y}C${a.x + dx} ${a.y} ${b.x - dx} ${b.y} ${b.x} ${b.y}`;
    const on = pe.sel?.type === "edge" && pe.sel.agent === e.agent && pe.sel.topic === e.topic && pe.sel.list === e.list;
    const g = svgEl("g", { class: "edge" + (on ? " sel" : "") }, svgEl("path", { d, class: "vis", "marker-end": "url(#arrow)" }), svgEl("path", { d, class: "hit" }));
    g.addEventListener("pointerdown", (ev) => { ev.stopPropagation(); select({ type: "edge", ...e }); });
    svg.append(g);
  }
  for (const n of nodes) {
    const p = pe.pos[n.key], isA = n.type === "agent";
    const on = isA ? pe.sel?.type === "agent" && pe.sel.id === n.a.id : pe.sel?.type === "topic" && pe.sel.name === n.t.name;
    const title = isA ? `${n.a.start ? "▶ " : ""}${n.a.id}${n.a.count > 1 ? " ×" + n.a.count : ""}` : n.t.name;
    const sub = isA ? [n.a.role, [n.a.vendor, n.a.model].filter(Boolean).join("/")].filter(Boolean).join(" · ") : `partitions ${n.t.partitions}`;
    const g = svgEl("g", { class: `node ${n.type}${on ? " sel" : ""}`, transform: `translate(${p.x} ${p.y})`, "data-node": n.key },
      svgEl("rect", { width: NW, height: NH, rx: isA ? 6 : 24 }),
      svgEl("text", { x: NW / 2, y: 20, class: "t" }, title.slice(0, 20)),
      svgEl("text", { x: NW / 2, y: 36, class: "s" }, sub.slice(0, 24)),
      svgEl("circle", { cx: NW, cy: NH / 2, r: 6, class: "handle", "data-handle": n.key }));
    g.addEventListener("pointerdown", (ev) => startPointer(ev, n));
    svg.append(g);
  }
  box.replaceChildren(svg);
}

function startPointer(ev, n) {
  ev.stopPropagation(); ev.preventDefault();
  document.activeElement?.blur(); // commits a pending rename before the selection changes
  const rect = () => $("canvas").querySelector("svg").getBoundingClientRect(), key = n.key;
  const sel = n.type === "agent" ? { type: "agent", id: n.a.id } : { type: "topic", name: n.t.name };
  const linking = ev.target.dataset.handle === key;
  if (!linking) select(sel);
  const off = { x: ev.clientX - rect().left - pe.pos[key].x, y: ev.clientY - rect().top - pe.pos[key].y };
  let rubber = null;
  const move = (e) => {
    const x = e.clientX - rect().left, y = e.clientY - rect().top;
    if (linking) {
      const live = $("canvas").querySelector("svg"); rubber?.remove();
      const a = { x: pe.pos[key].x + NW, y: pe.pos[key].y + NH / 2 };
      rubber = svgEl("line", { x1: a.x, y1: a.y, x2: x, y2: y, class: "rubber" }); live.append(rubber);
    } else { pe.pos[key] = { x: Math.max(0, x - off.x), y: Math.max(0, y - off.y) }; renderCanvas(); }
  };
  const up = (e) => {
    removeEventListener("pointermove", move); removeEventListener("pointerup", up);
    if (linking) {
      const target = document.elementFromPoint(e.clientX, e.clientY)?.closest("[data-node]")?.dataset.node;
      if (target && target !== key) connect(key, target);
      renderCanvas();
    }
  };
  addEventListener("pointermove", move); addEventListener("pointerup", up);
}

// ---- inspector ---------------------------------------------------------------------------
// bind(obj, key, opts): text/number/checkbox/textarea input writing straight into the pattern.
function bind(obj, key, { kind = "text", nullable = false, list = null, disabled = false, onCommit = null } = {}) {
  const v = obj[key];
  const input = kind === "area" ? el("textarea", { rows: 5, value: v ?? "" })
    : kind === "bool" ? el("input", { type: "checkbox", checked: !!v })
    : el("input", { type: kind === "number" ? "number" : "text", value: v ?? "", disabled });
  if (list) input.setAttribute("list", list);
  const read = () => kind === "bool" ? input.checked : kind === "number" ? (input.value === "" ? (nullable ? null : 1) : Number(input.value))
    : nullable && input.value === "" ? null : input.value;
  // Names commit on `change` (blur) so a rename never leaves half-typed references behind.
  input.addEventListener(onCommit ? "change" : "input", () => { const nv = read(); if (onCommit) onCommit(nv); else obj[key] = nv; changed(); });
  return input;
}
const row = (label, input) => [el("label", {}, label), input];

// Adds the models the agent itself lists (e.g. `agy models`) to the model suggestions of a pattern agent.
async function suggestModels(a, cfg, list) {
  const vendor = cfg?.vendors?.[a.vendor];
  if (!vendor) return;
  const info = await invoke("agent_models", { kind: kindOfVendor(vendor), refresh: false }).catch(() => null);
  if (!info || !list.isConnected) return;
  list.replaceChildren(...mergeModels({ live: info.live, configured: vendor.models ?? [], agentDefault: info.agent_default }).map((o) => el("option", { value: o.id }, o.label)));
}

function renderInspector() {
  const box = $("insp"); if (!box) return;
  const form = el("div", { className: "form" }), s = pe.sel, pat = pe.pat, cfg = pe.cfg;
  const dl = (id, items) => { const d = el("datalist", { id }); d.append(...items.map((v) => el("option", { value: v }))); return d; };
  const title = (t) => el("h3", { className: "ititle" }, t);
  const remove = (label) => el("button", { className: "btn danger", onclick: removeSel }, label);
  if (!s) {
    const kind = el("select", { onchange: () => { pat.kind = kind.value; changed(); } }, ...KINDS.map((k) => el("option", { value: k, selected: k === pat.kind }, k)));
    form.append(title("Pattern"), ...row("name", bind(pat, "name", { disabled: !pe.isNew })), ...row("kind", kind), ...row("description", bind(pat, "description", { kind: "area" })));
  } else if (s.type === "agent") {
    const a = pat.agents.find((x) => x.id === s.id);
    const models = cfg?.vendors?.[a.vendor]?.models ?? [];
    form.append(title("Agent"),
      ...row("id", bind(a, "id", { onCommit: (nv) => { if (nv && !pat.agents.some((x) => x.id === nv)) { pe.pos["a:" + nv] = pe.pos["a:" + a.id]; delete pe.pos["a:" + a.id]; a.id = nv; s.id = nv; } renderInspector(); } })),
      ...row("role", bind(a, "role", { list: "dl-roles" })), ...row("vendor", bind(a, "vendor", { nullable: true, list: "dl-vendors" })),
      ...row("model", bind(a, "model", { nullable: true, list: "dl-models" })), ...row("count", bind(a, "count", { kind: "number" })),
      ...row("level", bind(a, "level", { kind: "number", nullable: true })), ...row("group", bind(a, "group", { nullable: true })),
      ...row("start", bind(a, "start", { kind: "bool" })), ...row("prompt", bind(a, "prompt", { kind: "area", nullable: true })));
    const vendorOptions = Object.entries(cfg?.vendors ?? {}).map(([name, v]) => el("option", { value: name, label: `${name}${dc.loaded ? (pathOf(v.command) ? " ✓" : " (no instalado)") : ""}` }));
    const vendorList = el("datalist", { id: "dl-vendors" }); vendorList.append(...vendorOptions);
    const modelList = dl("dl-models", models);
    form.append(dl("dl-roles", Object.keys(cfg?.roles ?? {})), vendorList, modelList, remove("Remove agent"));
    suggestModels(a, cfg, modelList);
  } else if (s.type === "topic") {
    const t = pat.topics.find((x) => x.name === s.name);
    form.append(title("Topic"),
      ...row("name", bind(t, "name", { onCommit: (nv) => {
        if (!nv || pat.topics.some((x) => x.name === nv)) return;
        for (const a of pat.agents) for (const l of ["publishes", "consumes"]) a[l] = a[l].map((x) => (x === t.name ? nv : x));
        pe.pos["t:" + nv] = pe.pos["t:" + t.name]; delete pe.pos["t:" + t.name]; t.name = nv; s.name = nv; renderInspector();
      } })),
      ...row("partitions", bind(t, "partitions", { kind: "number" })), ...row("key", bind(t, "key", { nullable: true })), ...row("filter", bind(t, "filter", { nullable: true })), remove("Remove topic"));
  } else {
    form.append(title("Connection"), ...row(s.list === "publishes" ? "publishes" : "consumes", el("span", {}, `${s.agent} ${s.list === "publishes" ? "→" : "←"} ${s.topic}`)), remove("Remove connection"));
  }
  box.replaceChildren(form);
}

addEventListener("keydown", (e) => {
  if (e.key === "Delete" && pe?.sel && $("canvas") && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) removeSel();
});
