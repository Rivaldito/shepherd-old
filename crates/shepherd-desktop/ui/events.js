// Events tab (topics view of the TUI): bus topics, consumer groups and messages. Read-only.
// Pattern executions, the TUI's second sub-view, are the "Runs" tab here.
let ev = { topics: [], sel: null, raw: "", offset: "", agent: "", paused: false, ui: null };

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

async function drawEvents() {
  poll("events", refreshEvents);
  ev.ui = null;
  try { await loadTopics(); } catch (e) { return $("list").replaceChildren(el("div", { className: "empty" }, String(e))); }
  renderEventList(); renderEventDetail(); await loadMessages();
}

async function loadTopics() {
  const raw = JSON.stringify(await invoke("topic_list"));
  const changed = raw !== ev.raw;
  ev.raw = raw; ev.topics = JSON.parse(raw);
  if (!ev.topics.some((t) => t.name === ev.sel)) { ev.sel = ev.topics[0]?.name ?? null; ev.ui = null; }
  return changed;
}

async function loadMessages() {
  if (!ev.sel || !ev.ui) return;
  const off = ev.offset.trim();
  try {
    const msgs = await invoke("topic_messages", { topic: ev.sel, fromOffset: off === "" ? null : Number(off), agent: ev.agent.trim() || null, limit: 200 });
    fillMessages(msgs);
  } catch (e) { ev.ui.msgs.replaceChildren(el("div", { className: "empty" }, String(e))); }
}

// Polling never rebuilds the controls (that would steal focus while typing): only list, header and messages.
async function refreshEvents() {
  if (ev.paused) return;
  try {
    const changed = await loadTopics();
    if (changed) { renderEventList(); if (ev.ui) fillTopicInfo(); else renderEventDetail(); }
    await loadMessages();
  } catch (_) { /* keep last view */ }
}

function renderEventList() {
  const items = el("div", { id: "items" });
  for (const t of ev.topics)
    items.append(el("button", { className: "item" + (t.name === ev.sel ? " sel" : ""), onclick: () => { ev.sel = t.name; ev.ui = null; renderEventList(); renderEventDetail(); loadMessages(); } },
      el("span", {}, t.name + " ", t.paused ? el("span", { className: "badge warn" }, "[PAUSED]") : ""),
      el("small", {}, `${t.messages_count} msg · ${t.partitions}p`)));
  $("list").replaceChildren(items, el("button", { id: "new", onclick: refreshEvents }, "Refresh"));
}

function renderEventDetail() {
  const t = ev.topics.find((x) => x.name === ev.sel);
  if (!t) return $("detail").replaceChildren(el("div", { className: "empty" },
    "No topics on the bus yet. Topics are created when a message is published or a pattern is launched."));
  const ui = { head: el("div", { className: "head" }), meta: el("div", { className: "meta" }), groups: el("pre", {}), msgs: el("div", { className: "msgs" }) };
  const offset = el("input", { type: "number", min: 0, placeholder: "offset (blank = latest)", value: ev.offset, onchange: () => { ev.offset = offset.value; loadMessages(); } });
  const agent = el("input", { type: "text", placeholder: "Filter by agent", value: ev.agent, onchange: () => { ev.agent = agent.value; loadMessages(); } });
  const pause = el("button", { className: "btn", onclick: () => { ev.paused = !ev.paused; pause.textContent = ev.paused ? "Resume feed" : "Pause feed"; } }, ev.paused ? "Resume feed" : "Pause feed");
  ui.body = el("div", { className: "blocks" },
    el("div", { className: "block" }, el("h4", {}, "GRUPOS DE CONSUMO:"), ui.groups),
    el("div", { className: "block" }, el("h4", {}, "MESSAGES:"), el("div", { className: "tools" }, offset, agent, pause), ui.msgs));
  ev.ui = ui;
  fillTopicInfo();
  $("detail").replaceChildren(ui.head, ui.meta, ui.body);
}

function fillTopicInfo() {
  const t = ev.topics.find((x) => x.name === ev.sel), ui = ev.ui;
  ui.head.replaceChildren(`TOPIC: ${t.name}`, t.paused ? el("span", { className: "badge warn" }, "[PAUSED]") : "", el("span", { className: "state" }));
  ui.meta.textContent = `Particiones: ${t.partitions} | Mensajes: ${t.messages_count} | Grupos: ${t.groups.length}`;
  ui.groups.textContent = t.groups.map((g) => {
    const lag = Object.entries(g.lag_by_partition ?? {}).map(([p, n]) => `p${p}:${n}`).join(" ") || "0";
    const committed = Object.entries(g.committed_offsets ?? {}).map(([p, o]) => `p${p}:${o}`).join(" ") || "—";
    return `${g.group}  miembros: ${g.members.join(", ") || "—"}\n  offsets confirmados: ${committed}  |  pendientes: ${lag}`;
  }).join("\n") || "No subscribed groups.";
}

function fillMessages(msgs) {
  if (!msgs.length) return ev.ui.msgs.replaceChildren(el("div", { className: "empty" }, "No messages match this filter."));
  ev.ui.msgs.replaceChildren(...msgs.map((m) => el("div", { className: "msg" },
    el("span", { className: "dim" }, `#${m.offset ?? "—"} p${m.partition ?? 0}`), el("span", { className: "dim" }, (m.ts ?? "").replace("T", " ").slice(0, 19)),
    el("span", {}, m.from), el("span", { className: "dim" }, m.kind), el("span", { title: m.content }, clip(m.content, 300)))));
}
