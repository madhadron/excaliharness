// Status rules (D-037, D-042, D-047) as pure functions over parsed tasks.
import { isStatus, type Diagnostic, type Status, type Task } from "./model";

export type HumanStatus = "ready" | "done";

const HUMAN_FROM: Record<HumanStatus, readonly Status[]> = {
  ready: ["draft", "needs-human"],
  done: ["review", "needs-human"],
};

export function isAllowedHumanChange(from: Status, to: Status): boolean {
  return (to === "ready" || to === "done") && HUMAN_FROM[to].includes(from);
}

export function allowedHumanStatuses(status: Status): HumanStatus[] {
  return (["ready", "done"] as const).filter((to) => HUMAN_FROM[to].includes(status));
}

export function humanChangeRefusal(from: Status, to: Status): string {
  if (to === "ready" || to === "done") {
    return `a task can be marked ${to} only from ${HUMAN_FROM[to].join(" or ")}, and it was ${from}`;
  }
  return `${to} is set by the orchestrator`;
}

// The status the task last recorded in ## Updates. A task with no recorded
// change counts as coming from draft (D-047).
export function recordedStatus(task: Task): Status {
  const last = [...task.statusEntries].reverse().find((e) => isStatus(e.to));
  return last && isStatus(last.to) ? last.to : "draft";
}

export type Change =
  // The status line differs from the recorded status: someone edited it.
  | { id: string; type: "hand-edit"; from: Status; to: Status; allowed: boolean; reason?: string }
  | { id: string; type: "transition"; from: Status; to: Status; reason: string };

export interface Decisions {
  changes: Change[];
  diagnostics: Map<string, Diagnostic[]>;
}

const link = (id: string) => `[[${id}]]`;

// Works out one step of changes for every task. The caller writes them and
// calls again until nothing changes, so chains (a dependency finishing, then a
// waiting task becoming ready) settle over a few rounds.
//
// `accepted` overrides the recorded status for tasks whose status changed
// without a hand edit, e.g. after a git checkout.
//
// `broken` holds ids of task files that exist but don't parse.
export function decide(
  tasks: ReadonlyMap<string, Task>,
  accepted: ReadonlyMap<string, Status> = new Map(),
  broken: ReadonlySet<string> = new Set(),
): Decisions {
  const changes: Change[] = [];
  const diagnostics = new Map<string, Diagnostic[]>();
  const report = (task: Task, d: Diagnostic) => {
    const list = diagnostics.get(task.id) ?? [];
    list.push(d);
    diagnostics.set(task.id, list);
  };

  const depsLine = (task: Task) => task.metadata.find((m) => m.key === "depends_on")?.line ?? task.statusLine;
  const cycles = findCycles(tasks);
  for (const [id, cycle] of cycles) {
    const task = tasks.get(id);
    if (task) report(task, { line: depsLine(task), severity: "error", message: `Dependency cycle: ${cycle.join(" → ")}.` });
  }
  const infrastructure = [...tasks.values()].filter((t) => t.kind === "infrastructure");

  // Tasks this task is still waiting on, as links; unknown ones are reported.
  const unmet = (task: Task): string[] => {
    const waiting: string[] = [];
    for (const dep of task.dependsOn) {
      const other = tasks.get(dep);
      if (!other) {
        const message = broken.has(dep) ? `${link(dep)} doesn't parse, so it can't count as done.` : `Unknown task ${link(dep)}.`;
        report(task, { line: depsLine(task), severity: "error", message });
        waiting.push(link(dep));
      } else if (task.kind === "infrastructure" && other.kind !== "infrastructure") {
        // Every other task waits on infrastructure, so this would deadlock.
        report(task, { line: depsLine(task), severity: "error", message: `An infrastructure task can only depend on other infrastructure tasks, not ${link(dep)}.` });
        waiting.push(link(dep));
      } else if (other.status !== "done") waiting.push(link(dep));
    }
    if (task.kind !== "infrastructure") {
      for (const infra of infrastructure) {
        if (infra.status !== "done" && !task.dependsOn.includes(infra.id)) waiting.push(link(infra.id));
      }
    }
    if (cycles.has(task.id)) waiting.push("a dependency cycle");
    return waiting;
  };

  for (const task of tasks.values()) {
    const baseline = accepted.get(task.id) ?? recordedStatus(task);
    if (task.status !== baseline) {
      const allowed = isAllowedHumanChange(baseline, task.status);
      const change: Change = { id: task.id, type: "hand-edit", from: baseline, to: task.status, allowed };
      if (!allowed) change.reason = humanChangeRefusal(baseline, task.status);
      changes.push(change);
      // Don't act on a status that was set against the rules in the same
      // step that notes it.
      if (!allowed) continue;
    }

    const current = task.status;
    if (current === "ready" || current === "waiting-for-dependencies") {
      const waiting = unmet(task);
      if (current === "ready" && waiting.length > 0) {
        changes.push({ id: task.id, type: "transition", from: current, to: "waiting-for-dependencies", reason: `waiting on ${waiting.join(", ")}` });
      } else if (current === "waiting-for-dependencies" && waiting.length === 0) {
        changes.push({ id: task.id, type: "transition", from: current, to: "ready", reason: "dependencies are done" });
      }
    } else if (current === "needs-decision" && task.questions.length === 0) {
      report(task, { line: task.statusLine, severity: "warning", message: "This task needs a decision but has no questions under ## Questions." });
    } else if (current === "needs-decision" && task.questions.every((q) => q.checked)) {
      const entered = [...task.statusEntries].reverse().find((e) => e.to === "needs-decision");
      const previous = entered?.from;
      if (previous && isStatus(previous) && previous !== "needs-decision") {
        changes.push({ id: task.id, type: "transition", from: current, to: previous, reason: "all questions are answered" });
      } else {
        report(task, {
          line: task.statusLine,
          severity: "warning",
          message: "All questions are answered, but Updates has no record of the status before needs-decision; set the status by hand.",
        });
      }
    }
  }
  return { changes, diagnostics };
}

// Returns, for each task on a dependency cycle, one cycle through it.
export function findCycles(tasks: ReadonlyMap<string, Task>): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (id: string) => {
    state.set(id, "visiting");
    stack.push(id);
    for (const dep of tasks.get(id)?.dependsOn ?? []) {
      if (!tasks.has(dep)) continue;
      const s = state.get(dep);
      if (s === "visiting") {
        const cycle = [...stack.slice(stack.indexOf(dep)), dep];
        for (const member of cycle) if (!result.has(member)) result.set(member, cycle);
      } else if (s === undefined) visit(dep);
    }
    stack.pop();
    state.set(id, "done");
  };
  for (const id of [...tasks.keys()].sort()) if (!state.has(id)) visit(id);
  return result;
}
