// Run with: node crates/shepherd-desktop/ui/tests/projects.test.js
const assert = require("node:assert/strict");
const { checkoutFor, workspaceRootOf, agentsOfTask, taskPrompt, taskOfRun, isRunAgent, ensureTaskPrefix, buildMonitorTree, agentIdsOf } = require("../projects.js");

// --- checkoutFor: the worktree that contains the terminal's folder, matched on path boundaries
const wts = ["/home/u/app", "/home/u/app-wt/feature", "/home/u/app-wt/fix"];
assert.equal(checkoutFor("/home/u/app", wts), "/home/u/app");
assert.equal(checkoutFor("/home/u/app/src/deep", wts), "/home/u/app");
assert.equal(checkoutFor("/home/u/app-wt/feature/crates", wts), "/home/u/app-wt/feature");
assert.equal(checkoutFor("/home/u/app-wt/feature-x", wts), null); // "feature" is not a prefix of "feature-x" as a folder
assert.equal(checkoutFor("/home/u/application", wts), null); // "/home/u/app" is not a folder prefix of "/home/u/application"
assert.equal(checkoutFor("/home/u/app/nested", ["/home/u/app", "/home/u/app/nested"]), "/home/u/app/nested"); // longest wins
assert.equal(checkoutFor("/elsewhere", wts), null);
assert.equal(checkoutFor("", wts), null);
assert.equal(checkoutFor("/a/b", ["/a/b/"]), "/a/b/"); // a trailing slash still matches

// --- workspaceRootOf
assert.equal(workspaceRootOf({ worktree: { checkout_path: "/r/wt" } }, "/r/wt/src"), "/r/wt");
assert.equal(workspaceRootOf({}, "/r/plain"), "/r/plain");
assert.equal(workspaceRootOf(undefined, "/r/plain"), "/r/plain");
assert.equal(workspaceRootOf({}, ""), null);
assert.equal(workspaceRootOf(null, null), null);

// --- agentsOfTask: the registry keeps task_id as text; ids compare as text; no task means no match
const reg = [{ id: "a-1", task_id: "3" }, { id: "a-2", task_id: "13" }, { id: "a-3" }, { id: "a-4", task_id: "" }, { id: "a-5", task_id: "3" }];
assert.deepEqual(agentsOfTask(reg, 3).map((a) => a.id), ["a-1", "a-5"]);
assert.deepEqual(agentsOfTask(reg, "3").map((a) => a.id), ["a-1", "a-5"]);
assert.deepEqual(agentsOfTask(reg, 1).map((a) => a.id), []); // "13" does not match 1
assert.deepEqual(agentsOfTask([], 3), []);

// --- taskPrompt
assert.equal(taskPrompt({ id: 7, title: "Login", description: "  Añadir login  ", criteria: ["- [ ] funciona", "- [x] con tests", "* otro", ""] }),
  "Task #7: Login\n\nAñadir login\n\nAcceptance criteria:\n- funciona\n- con tests\n- otro");
assert.equal(taskPrompt({ id: 1, title: "Solo título" }), "Task #1: Solo título");
assert.equal(taskPrompt({ id: 2, title: "T", description: "", criteria: [] }), "Task #2: T");

// --- runs belong to tasks through their objective
assert.equal(taskOfRun({ task: "Tarea #7: Login\n\ncuerpo" }), 7);
assert.equal(taskOfRun({ task: "Tarea #12: x" }), 12);
assert.equal(taskOfRun({ task: "investigar el README" }), null);
assert.equal(taskOfRun({ task: "mira la Tarea #3: no al principio" }), null);
assert.equal(taskOfRun({}), null);
assert.equal(isRunAgent({ task_id: "run-fake-2831" }), true);
assert.equal(isRunAgent({ task_id: "3" }), false);
assert.equal(isRunAgent({}), false);
const task7 = { id: 7, title: "Login" };
assert.equal(ensureTaskPrefix("Task #7: Login\n\nmás texto", task7), "Task #7: Login\n\nmás texto"); // already linked: untouched
assert.equal(ensureTaskPrefix("  solo mi objetivo  ", task7), "Tarea #7: Login\n\nsolo mi objetivo"); // prefix added
assert.equal(ensureTaskPrefix("", task7), "Task #7: Login");
assert.equal(taskOfRun({ task: ensureTaskPrefix("lo que sea", task7) }), 7); // what we write is what we parse

// --- the monitor tree
const tasks = [{ id: 1, title: "Login" }, { id: 2, title: "Pagos" }];
const run = (id, task, agents, at) => ({ id, pattern: "fake", task, created_at: at, agents: agents.map((a) => ({ id: a, role: "tester", state: "starting" })) });
const runs = [run("run-a", "Tarea #1: Login", ["t-1", "t-2"], "2026-01-01"), run("run-b", "Tarea #1: Login\n\notra vez", ["t-3"], "2026-02-01"), run("run-c", "sin tarea", ["t-4"], "2026-03-01"), run("run-d", "Tarea #99: ajena", ["t-5"], "2026-03-02")];
const registry = [
  { id: "t-1", task_id: "run-a", state: "working", pane: "w1:p1" }, { id: "t-2", task_id: "run-a", state: "exited" },
  { id: "t-3", task_id: "run-b" }, { id: "t-4", task_id: "run-c" }, { id: "t-5", task_id: "run-d" },
  { id: "loose-1", task_id: "1", state: "working" }, { id: "loose-2", task_id: "" }, { id: "loose-3", task_id: "55" },
];
const tree = buildMonitorTree(tasks, runs, registry);
assert.deepEqual(tree.map((g) => g.kind), ["task", "task", "none"]);
assert.deepEqual(tree[0].direct.map((a) => a.id), ["loose-1"]); // run agents are never "direct"
assert.deepEqual(tree[0].runs.map((r) => r.run.id), ["run-b", "run-a"]); // newest run first
assert.equal(tree[0].runs[1].agents[0].state, "working"); // the registry's live state wins over the run's snapshot
assert.equal(tree[0].runs[1].agents[0].pane, "w1:p1");
assert.equal(tree[0].runs[0].agents[0].role, "tester"); // an agent missing from the registry still shows (from the run)
assert.deepEqual(tree[1], { kind: "task", task: tasks[1], direct: [], runs: [] }); // a task with nothing is still listed
assert.deepEqual(tree[2].direct.map((a) => a.id), ["loose-2", "loose-3"]); // no task, or a task that is not in this project
assert.deepEqual(tree[2].runs.map((r) => r.run.id), ["run-d", "run-c"]); // runs with no (known) task
assert.deepEqual(agentIdsOf(tree[0]).sort(), ["loose-1", "t-1", "t-2", "t-3"]);
assert.deepEqual(agentIdsOf({ direct: [], runs: [] }), []);
assert.deepEqual(buildMonitorTree([], [], []), []); // nothing at all: no empty "no task" group
assert.deepEqual(buildMonitorTree(tasks, [], []).map((g) => g.kind), ["task", "task"]);

console.log("projects.js: all checks passed");
