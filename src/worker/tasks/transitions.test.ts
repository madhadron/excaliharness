import { describe, expect, it } from "vitest";
import type { Status, Task } from "./model";
import { allowedHumanStatuses, decide, findCycles, isAllowedHumanChange, recordedStatus } from "./transitions";

function task(id: string, status: Status, extra: Partial<Task> = {}, recorded?: Status): Task {
  return {
    id,
    title: id,
    status,
    statusLine: 1,
    dependsOn: [],
    metadata: [{ key: "status", value: status, line: 1 }],
    sections: [],
    questions: [],
    statusEntries: [{ from: "draft", to: recorded ?? status, line: 10 }],
    ...extra,
  };
}

const map = (...tasks: Task[]) => new Map(tasks.map((t) => [t.id, t]));

describe("human changes", () => {
  it.each<[Status, Status, boolean]>([
    ["draft", "ready", true],
    ["needs-human", "ready", true],
    ["review", "done", true],
    ["needs-human", "done", true],
    ["in-implementation", "ready", false],
    ["ready", "done", false],
    ["draft", "review", false],
  ])("%s → %s allowed: %s", (from, to, allowed) => {
    expect(isAllowedHumanChange(from, to)).toBe(allowed);
  });

  it("lists what can be set from each status", () => {
    expect(allowedHumanStatuses("draft")).toEqual(["ready"]);
    expect(allowedHumanStatuses("needs-human")).toEqual(["ready", "done"]);
    expect(allowedHumanStatuses("in-implementation")).toEqual([]);
  });

  it("treats a task with no recorded change as coming from draft", () => {
    expect(recordedStatus(task("T-1", "draft", { statusEntries: [] }))).toBe("draft");
  });

  it("notes a hand edit once, as allowed or not", () => {
    const { changes } = decide(map(task("T-1", "ready", {}, "draft"), task("T-2", "review", {}, "in-implementation")));
    expect(changes).toEqual([
      { id: "T-1", type: "hand-edit", from: "draft", to: "ready", allowed: true },
      { id: "T-2", type: "hand-edit", from: "in-implementation", to: "review", allowed: false, reason: "review is set by the orchestrator" },
    ]);
  });

  it("uses an accepted baseline instead of the recorded one", () => {
    const { changes } = decide(map(task("T-1", "review", {}, "draft")), new Map<string, Status>([["T-1", "review"]]));
    expect(changes).toEqual([]);
  });
});

describe("dependencies", () => {
  it("moves ready to waiting while a dependency isn't done, and back once it is", () => {
    const waiting = decide(map(task("T-1", "in-implementation"), task("T-2", "ready", { dependsOn: ["T-1"] })));
    expect(waiting.changes).toEqual([{ id: "T-2", type: "transition", from: "ready", to: "waiting-for-dependencies", reason: "waiting on [[T-1]]" }]);
    const done = decide(map(task("T-1", "done"), task("T-2", "waiting-for-dependencies", { dependsOn: ["T-1"] })));
    expect(done.changes).toEqual([{ id: "T-2", type: "transition", from: "waiting-for-dependencies", to: "ready", reason: "dependencies are done" }]);
  });

  it("makes every other task wait on infrastructure tasks, but not infrastructure on itself", () => {
    const { changes } = decide(map(task("T-1", "ready", { kind: "infrastructure" }), task("T-2", "ready"), task("T-3", "ready", { kind: "infrastructure" })));
    expect(changes).toEqual([{ id: "T-2", type: "transition", from: "ready", to: "waiting-for-dependencies", reason: "waiting on [[T-1]], [[T-3]]" }]);
  });

  it("never changes a draft", () => {
    expect(decide(map(task("T-1", "draft", { dependsOn: ["T-2"] }), task("T-2", "in-implementation"))).changes).toEqual([]);
  });

  it("reports an unknown dependency and keeps waiting", () => {
    const t = task("T-2", "ready", { dependsOn: ["T-9"], metadata: [{ key: "depends_on", value: "[[T-9]]", line: 3 }] });
    const { changes, diagnostics } = decide(map(t));
    expect(changes[0]).toMatchObject({ to: "waiting-for-dependencies" });
    expect(diagnostics.get("T-2")).toEqual([{ line: 3, severity: "error", message: "Unknown task [[T-9]]." }]);
  });

  it("reports cycles and never treats their members as unblocked", () => {
    const tasks = map(task("T-1", "waiting-for-dependencies", { dependsOn: ["T-2"] }), task("T-2", "done", { dependsOn: ["T-1"] }));
    expect(findCycles(tasks).get("T-1")).toEqual(["T-1", "T-2", "T-1"]);
    const { changes, diagnostics } = decide(tasks);
    expect(changes).toEqual([]);
    expect(diagnostics.get("T-1")?.[0]?.message).toMatch(/Dependency cycle/);
  });
});

describe("more rules", () => {
  it("rejects an infrastructure task depending on a normal one, which would deadlock", () => {
    const t = task("T-1", "ready", { kind: "infrastructure", dependsOn: ["T-2"] });
    const { diagnostics } = decide(map(t, task("T-2", "done")));
    expect(diagnostics.get("T-1")?.[0]?.message).toMatch(/can only depend on other infrastructure tasks/);
  });

  it("says a dependency doesn't parse instead of calling it unknown", () => {
    const { diagnostics } = decide(map(task("T-2", "ready", { dependsOn: ["T-3"] })), new Map(), new Set(["T-3"]));
    expect(diagnostics.get("T-2")?.[0]?.message).toBe("[[T-3]] doesn't parse, so it can't count as done.");
  });

  it("doesn't act on a disallowed hand edit in the step that notes it", () => {
    const { changes } = decide(map(task("T-1", "waiting-for-dependencies", {}, "draft")));
    expect(changes).toEqual([
      expect.objectContaining({ type: "hand-edit", from: "draft", to: "waiting-for-dependencies", allowed: false }),
    ]);
  });

  it("uses the last valid recorded status", () => {
    const t = task("T-1", "ready", {
      statusEntries: [
        { from: "draft", to: "ready", line: 8 },
        { from: "ready", to: "bogus", line: 9 },
      ],
    });
    expect(recordedStatus(t)).toBe("ready");
  });

  it("warns about needs-decision with no questions", () => {
    const { diagnostics } = decide(map(task("T-1", "needs-decision")));
    expect(diagnostics.get("T-1")?.[0]?.message).toMatch(/no questions/);
  });
});

describe("needs-decision", () => {
  const entries = [
    { from: "draft", to: "ready", line: 8 },
    { from: "in-implementation", to: "needs-decision", line: 9 },
  ];

  it("returns to the status it came from once every question is checked", () => {
    const t = task("T-1", "needs-decision", { statusEntries: entries, questions: [{ checked: true, question: "q", answer: "a", line: 5 }] });
    expect(decide(map(t)).changes).toEqual([
      { id: "T-1", type: "transition", from: "needs-decision", to: "in-implementation", reason: "all questions are answered" },
    ]);
  });

  it("waits while a question is unchecked", () => {
    const t = task("T-1", "needs-decision", {
      statusEntries: entries,
      questions: [
        { checked: true, question: "q", answer: "a", line: 5 },
        { checked: false, question: "q2", answer: "", line: 6 },
      ],
    });
    expect(decide(map(t)).changes).toEqual([]);
  });

  it("stays and warns when Updates doesn't say where it came from", () => {
    const t = task("T-1", "needs-decision", {
      statusEntries: [{ from: "", to: "needs-decision", line: 9 }],
      questions: [{ checked: true, question: "q", answer: "a", line: 5 }],
    });
    const { changes, diagnostics } = decide(map(t));
    expect(changes).toEqual([]);
    expect(diagnostics.get("T-1")?.[0]?.severity).toBe("warning");
  });
});
