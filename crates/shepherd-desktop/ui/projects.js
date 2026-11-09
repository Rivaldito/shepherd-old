// Pure helpers about the project a workspace belongs to, and how agents relate to tasks.
// An agent lands in the workspace that has its `root` checkout open (that is how the server places
// it), so "per workspace" means: use that workspace's checkout as the agent's root.

// The checkout (a git worktree path) that contains `cwd`: the longest match, on path boundaries.
function checkoutFor(cwd, paths) {
  if (!cwd) return null;
  const trim = (p) => (p.length > 1 ? p.replace(/\/+$/, "") : p);
  const here = trim(cwd);
  const inside = paths.filter((p) => p && (here === trim(p) || here.startsWith(trim(p) + "/")));
  return inside.sort((a, b) => trim(b).length - trim(a).length)[0] ?? null;
}

// The folder a workspace is about: its linked checkout, else where its terminal is. null = unknown.
function workspaceRootOf(workspace, cwd) {
  return workspace?.worktree?.checkout_path || cwd || null;
}

// Agents of the Shepherd registry that were launched for a task (the registry stores task_id as text).
function agentsOfTask(registry, taskId) {
  return registry.filter((a) => a.task_id !== undefined && a.task_id !== "" && String(a.task_id) === String(taskId));
}

// What an agent is told when launched for a task: the task itself, so nobody retypes it.
function taskPrompt(task) {
  const parts = [`Task #${task.id}: ${task.title}`];
  if (task.description) parts.push(task.description.trim());
  const criteria = (task.criteria ?? []).map((c) => c.replace(/^([-*] \[[ xX]\]|[-*])\s*/, "").trim()).filter(Boolean);
  if (criteria.length) parts.push("Acceptance criteria:\n" + criteria.map((c) => `- ${c}`).join("\n"));
  return parts.join("\n\n");
}

// A pattern run belongs to a task when its objective starts with "Task #N:" (what taskPrompt writes).
// The run's agents cannot carry the task: the registry uses their task_id for the run's own id.
const TASK_REF = /^(?:Task|Tarea) #(\d+):/;
const taskOfRun = (run) => { const m = TASK_REF.exec(run.task ?? ""); return m ? Number(m[1]) : null; };
const isRunAgent = (agent) => String(agent.task_id ?? "").startsWith("run-");

// The objective to run a pattern with for `task`: keeps whatever the user edited, but always starts with the
// reference that links the run to the task.
const ensureTaskPrefix = (text, task) => (TASK_REF.test(text.trim()) ? text.trim() : `Task #${task.id}: ${task.title}\n\n${text.trim()}`.trim());

// What the monitor shows: every task with its direct agents and its pattern runs, then whatever has no task.
// A run's agents come from the run, refreshed with the live registry record when there is one.
function buildMonitorTree(tasks, runs, registry) {
  const byId = new Map(registry.map((a) => [a.id, a]));
  const runNode = (run) => ({ run, agents: (run.agents ?? []).map((ra) => ({ ...ra, ...(byId.get(ra.id) ?? {}) })) });
  const newestFirst = (a, b) => String(b.run.created_at ?? "").localeCompare(String(a.run.created_at ?? ""));
  const inRun = new Set(runs.flatMap((r) => (r.agents ?? []).map((a) => a.id)));
  const known = new Set(tasks.map((t) => t.id));
  const groups = tasks.map((task) => ({
    kind: "task", task,
    direct: agentsOfTask(registry, task.id).filter((a) => !isRunAgent(a)),
    runs: runs.filter((r) => taskOfRun(r) === task.id).map(runNode).sort(newestFirst),
  }));
  const rest = {
    kind: "none",
    direct: registry.filter((a) => !isRunAgent(a) && !inRun.has(a.id) && !known.has(Number(a.task_id))),
    runs: runs.filter((r) => !known.has(taskOfRun(r))).map(runNode).sort(newestFirst),
  };
  return rest.direct.length || rest.runs.length ? [...groups, rest] : groups;
}

// Ids of every agent under a node of the tree (a task, a run or the "no task" group).
const agentIdsOf = (node) => [...new Set([...(node.direct ?? []).map((a) => a.id), ...(node.runs ?? []).flatMap((r) => r.agents.map((a) => a.id))])];

if (typeof module !== "undefined") module.exports = { checkoutFor, workspaceRootOf, agentsOfTask, taskPrompt, taskOfRun, isRunAgent, ensureTaskPrefix, buildMonitorTree, agentIdsOf };
