// Run with: node crates/shepherd-desktop/ui/tests/cmdline.test.js
const assert = require("node:assert/strict");
const { splitArgs, matchCommands, parseApiLine, stepHistory } = require("../cmdline.js");

// --- splitArgs
assert.deepEqual(splitArgs("workspace list"), { args: ["workspace", "list"] });
assert.deepEqual(splitArgs("  pane   read  w1:p1 "), { args: ["pane", "read", "w1:p1"] });
assert.deepEqual(splitArgs(`workspace rename w1 "mi space"`), { args: ["workspace", "rename", "w1", "mi space"] });
assert.deepEqual(splitArgs(`a 'b "c" d' e`), { args: ["a", `b "c" d`, "e"] });
assert.deepEqual(splitArgs(String.raw`say "he said \"hi\" \\ ok"`), { args: ["say", String.raw`he said "hi" \ ok`] });
assert.deepEqual(splitArgs(String.raw`a\ b c`), { args: ["a b", "c"] });
assert.deepEqual(splitArgs(`x "" y`), { args: ["x", "", "y"] }); // an empty quoted argument is kept
assert.deepEqual(splitArgs("a; touch pwned"), { args: ["a;", "touch", "pwned"] }); // no shell syntax: just words
assert.deepEqual(splitArgs(""), { args: [] });
assert.deepEqual(splitArgs(`a "b`), { error: "Unclosed quote" });
assert.deepEqual(splitArgs(`ñandú "ü ö"`), { args: ["ñandú", "ü ö"] });

// --- matchCommands
const items = [
  { group: "Workspaces", title: "New workspace…" }, { group: "Tabs", title: "New tab" },
  { group: "Panes", title: "Split right" }, { group: "Panes", title: "Close focused pane" },
  { group: "Navigate", title: "Go to tab: logs" }, { group: "Agents", title: "Launch agent…" },
];
const titles = (q) => matchCommands(q, items).map((i) => i.title);
assert.equal(titles("").length, 6);
assert.deepEqual(titles("tab"), ["New tab", "Go to tab: logs"]); // accent-insensitive, startsWith ranks first
assert.deepEqual(titles("PANE"), ["Close focused pane", "Split right"]); // title hit first, then the group-only hit
assert.deepEqual(titles("panes split"), ["Split right"]); // words may match the group too
assert.deepEqual(titles("new workspace"), ["New workspace…"]);
assert.deepEqual(titles("zzz"), []);
assert.deepEqual(titles("a"), titles("a")); // stable

// --- parseApiLine
assert.deepEqual(parseApiLine("pane.list"), { method: "pane.list", params: {} });
assert.deepEqual(parseApiLine(`pane.read {"pane_id":"w1:p1","source":"visible"}`), { method: "pane.read", params: { pane_id: "w1:p1", source: "visible" } });
assert.deepEqual(parseApiLine(`  shepherd.agent.list  `), { method: "shepherd.agent.list", params: {} });
assert.match(parseApiLine("pane.read {oops").error, /Invalid JSON/);
assert.match(parseApiLine("pane.read [1]").error, /objeto/);
assert.match(parseApiLine("").error, /formato/);
assert.match(parseApiLine("123").error, /formato/);

// --- stepHistory: up walks back, down walks forward and ends at "not browsing"
assert.equal(stepHistory(-1, 3, "older"), 0);
assert.equal(stepHistory(0, 3, "older"), 1);
assert.equal(stepHistory(2, 3, "older"), 2); // clamped at the oldest
assert.equal(stepHistory(1, 3, "newer"), 0);
assert.equal(stepHistory(0, 3, "newer"), -1);
assert.equal(stepHistory(-1, 3, "newer"), -1);
assert.equal(stepHistory(-1, 0, "older"), -1); // empty history

console.log("cmdline.js: all checks passed");
