// Status rules (D-037, D-042, D-047) as pure functions over parsed tasks.
import { isStatus, type Diagnostic, type Status, type Task } from "./model";

export type HumanStatus = "ready" | "done" | "draft";

const HUMAN_FROM: Record<"ready" | "done", readonly Status[]> = {
  ready: ["draft", "needs-human"],
  done: ["review", "needs-human"],
};

// What the human may set. A parked task (D-076) may also go back to draft,
// to ready, or, if it was parked in review, to done.
export function allowedHumanStatuses(status: Status, parked = false): HumanStatus[] {
  if (parked) return status === "review" ? ["ready", "done", "draft"] : ["ready", "draft"];
  return (["ready", "done"] as const).filter((to) => HUMAN_FROM[to].includes(status));
}

export function isAllowedHumanChange(from: Status, to: Status, parked = false): boolean {
  return (allowedHumanStatuses(from, parked) as Status[]).includes(to);
}

export function humanChangeRefusal(from: Status, to: Status): string {
  if (to === "ready" || to === "done") {
    return `a task can be marked ${to} only from ${HUMAN_FROM[to].join(" or ")}, and it was ${from}`;
  }
  if (to === "draft") return "a task can be moved back to draft only while it is parked";
  return `${to} is set by the orchestrator`;
}

// The status a task is parked in, if it is: its last recorded change parked
// it and the status line still says so.
export function parkedStatus(task: Task): Status | undefined {
  const last = [...task.statusEntries].reverse().find((e) => isStatus(e.to));
  return last?.parked && last.to === task.status && isStatus(last.to) ? last.to : undefined;
}

// Parked as the rules see it: a status accepted from a git checkout (see
// decide's `accepted`) is never parked.
export function isParked(task: Task, accepted: ReadonlyMap<string, Status> = new Map()): boolean {
  return !accepted.has(task.id) && parkedStatus(task) !== undefined;
}

// D-076's message. Any disallowed hand edit parks (D-079): one into a status
// the human may set says where it came from instead.
// Whether the task's last recorded change parked it, so a hand edit from
// there may go back to draft (D-076). Statuses from a git checkout never are.
export function wasParked(task: Task, accepted: ReadonlyMap<string, Status> = new Map()): boolean {
  return !accepted.has(task.id) && [...task.statusEntries].reverse().find((e) => isStatus(e.to))?.parked === true;
}

export function parkedMessage(task: Task, status: Status): string {
  const ways = allowedHumanStatuses(status, true).join(", ").replace(/, ([^,]*)$/, " or $1");
  const from = [...task.statusEntries].reverse().find((e) => e.parked && e.to === status)?.from;
  const human = status === "ready" || status === "done" || status === "draft";
  const why = human ? `which isn't allowed from ${from && isStatus(from) ? from : "its previous status"}` : "which only the orchestrator sets";
  return `${task.id} is parked: its status was set by hand to ${status}, ${why}. Mark it ${ways} to continue.`;
}

// The status the task last recorded in ## Updates. A task with no recorded
// change counts as coming from draft (D-047).
export function recordedStatus(task: Task): Status {
  const last = [...task.statusEntries].reverse().find((e) => isStatus(e.to));
  return last && isStatus(last.to) ? last.to : "draft";
}

export type Change =
  // The status line differs from the recorded status: someone edited it. A
  // disallowed edit parks the task (D-076).
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
  // Done counts only when the rules allow it: not a parked done, and not a
  // hand edit into done that this step refuses (D-079).
  const isDone = (t: Task) => {
    if (t.status !== "done" || isParked(t, accepted)) return false;
    const baseline = accepted.get(t.id) ?? recordedStatus(t);
    return baseline === "done" || isAllowedHumanChange(baseline, "done", wasParked(t, accepted));
  };

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
      } else if (!isDone(other)) waiting.push(link(dep));
    }
    if (task.kind !== "infrastructure") {
      for (const infra of infrastructure) {
        if (!isDone(infra) && !task.dependsOn.includes(infra.id)) waiting.push(link(infra.id));
      }
    }
    if (cycles.has(task.id)) waiting.push("a dependency cycle");
    return waiting;
  };

  for (const task of tasks.values()) {
    const override = accepted.get(task.id);
    const baseline = override ?? recordedStatus(task);
    // A git checkout's statuses aren't hand edits, so they can't be parked.
    const parked = task.status === baseline && isParked(task, accepted) ? parkedStatus(task) : undefined;
    if (parked) {
      report(task, { line: task.statusLine, severity: "error", message: parkedMessage(task, parked) });
      continue;
    }
    if (task.status !== baseline) {
      const allowed = isAllowedHumanChange(baseline, task.status, wasParked(task, accepted));
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
