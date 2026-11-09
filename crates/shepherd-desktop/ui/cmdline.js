// Pure helpers for the command dock: shell-like splitting, command search, API line parsing.

// "workspace rename w1 'my space'" -> { args: [...] }, or { error } for an unclosed quote.
// Single quotes are literal, double quotes allow \" and \\, a backslash outside quotes escapes one char.
function splitArgs(line) {
  const args = []; let cur = "", has = false, quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; }
    else if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && (line[i + 1] === '"' || line[i + 1] === "\\")) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') { quote = c; has = true; }
    else if (c === "\\" && i + 1 < line.length) { cur += line[++i]; has = true; }
    else if (/\s/.test(c)) { if (cur || has) args.push(cur); cur = ""; has = false; }
    else { cur += c; has = true; }
  }
  if (quote) return { error: "Unclosed quote" };
  if (cur || has) args.push(cur);
  return { args };
}

const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Every word of the query must appear in "group title" (accents and case ignored);
// titles that start with the first word come first, then word-boundary hits, then the rest.
function matchCommands(query, items) {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return items.slice();
  const ranked = [];
  items.forEach((item, i) => {
    const title = norm(item.title), all = norm(item.group + " " + item.title);
    if (!words.every((w) => all.includes(w))) return;
    const rank = title.startsWith(words[0]) ? 0 : title.includes(" " + words[0]) ? 1 : 2;
    ranked.push([rank, i, item]);
  });
  return ranked.sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((r) => r[2]);
}

// "pane.read {"pane_id":"w1:p1"}" -> { method, params } | { error }
function parseApiLine(line) {
  const m = line.trim().match(/^([a-z_]+(?:\.[a-z_]+)*)\s*([\s\S]*)$/);
  if (!m) return { error: "Format: method {json} (for example: pane.list)" };
  if (!m[2]) return { method: m[1], params: {} };
  try {
    const params = JSON.parse(m[2]);
    if (params === null || typeof params !== "object" || Array.isArray(params)) return { error: "Parameters must be a JSON object." };
    return { method: m[1], params };
  } catch (e) { return { error: "Invalid JSON: " + e.message }; }
}

// History cursor: -1 = not browsing, n = n entries back from the newest (clamped to the list).
function stepHistory(h, len, dir) {
  if (!len) return -1;
  return dir === "older" ? Math.min(h + 1, len - 1) : Math.max(h - 1, -1);
}

if (typeof module !== "undefined") module.exports = { splitArgs, matchCommands, parseApiLine, stepHistory, norm };
