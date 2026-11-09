// What the launch forms offer: which agents are installed and which models they have.
// Installed-ness comes from the user's login shell (see discover.rs); models are merged from the agent
// itself (`agy models`), Shepherd's config (vendors.<name>.models) and the agent's own default.
const dc = { detected: [], vendors: {}, roles: {}, loaded: false };

// Used when no vendor in the config defines `model_flag` for the agent.
const MODEL_FLAGS = { claude: "--model", codex: "-m", agy: "--model", gemini: "--model" };

const basenameOf = (p) => (p ?? "").split("/").filter(Boolean).pop() ?? "";
// The agent kind a Shepherd vendor runs: its declared agent, else its command's name.
const kindOfVendor = (v) => v.shepherd_agent || basenameOf(v.command);
const vendorForKind = (kind) => Object.entries(dc.vendors).find(([, v]) => kindOfVendor(v) === kind)?.[0] ?? null;
const pathOf = (command) => dc.detected.find((d) => d.command === command)?.path ?? null;
const isInstalledKind = (kind) => !!pathOf(kind);
const modelFlagFor = (kind) => dc.vendors[vendorForKind(kind)]?.model_flag || MODEL_FLAGS[kind] || null;

async function loadDiscovery(refresh = false) {
  const m = await invokeP("get_models").catch(() => ({ vendors: {}, roles: {} }));
  dc.vendors = m.vendors; dc.roles = m.roles;
  const extra = Object.values(m.vendors).map((v) => v.command).filter(Boolean);
  try { dc.detected = await invoke("agents_detected", { extra, refresh }); } catch (_) { /* keep the previous answer */ }
  dc.loaded = true;
}

// Known kinds, installed ones first (in the server's order), the rest after.
function kindChoices() {
  const known = dc.detected.filter((d) => d.known);
  return [...known.filter((d) => d.path), ...known.filter((d) => !d.path)];
}

// One list for the model field: detected > configured > the agent's own default; ids are unique.
function mergeModels({ live = [], configured = [], agentDefault = null }) {
  const seen = new Set(), out = [];
  const add = (id, label, source) => { if (id && !seen.has(id)) { seen.add(id); out.push({ id, label: label && label !== id ? `${id} — ${label}` : id, source }); } };
  for (const m of live) add(m.id, m.label, "detectado");
  for (const id of configured) add(id, null, "configuration");
  add(agentDefault, null, "agent default");
  return out;
}

// The server accepts 1-32 characters: lowercase letters, digits, "-" and "_", starting with a letter.
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;
const agentNameOk = (name) => AGENT_NAME.test(name);

// "Mi Agénte 2" -> "mi-agente-2": lowercase, accents dropped, anything else becomes "-", at most 32 characters.
// Returns "" when nothing usable is left (the caller then falls back to a default name).
function sanitizeAgentName(raw) {
  return raw.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-").replace(/^[^a-z]+/, "").slice(0, 32).replace(/-+$/, "");
}

// Agent names are unique on the server: "pi", then "pi-2", "pi-3"… (the suffix always fits in 32 characters).
function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`, name = base.slice(0, 32 - suffix.length) + suffix;
    if (!taken.has(name)) return name;
  }
}

// Which detected models are not in the vendor's configured list yet (what the save button would add).
const newModelIds = (live, configured) => live.map((m) => m.id).filter((id) => !configured.includes(id));

if (typeof module !== "undefined") module.exports = { dc, agentNameOk, sanitizeAgentName, uniqueName, mergeModels, newModelIds, kindOfVendor, vendorForKind, modelFlagFor, kindChoices, isInstalledKind };
