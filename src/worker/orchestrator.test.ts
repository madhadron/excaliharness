import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator";
import { TaskBlocked, TokenRejected, type RunContext, type RunOutcome } from "./runner/runner";
import { hashOf, TEMP_PREFIX } from "./store";
import type { DiagnosticsSnapshot, Notification, TasksSnapshot } from "./protocol";

let root: string;
const running: Orchestrator[] = [];
const fixedNow = () => new Date(2026, 9, 23, 14, 2);

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "orch-"));
  fs.mkdirSync(path.join(root, "tasks"));
  fs.writeFileSync(path.join(root, "TASKS.md"), "# Tasks\n\n## Index\n");
});

afterEach(() => {
  for (const o of running.splice(0)) o.stop();
  fs.rmSync(root, { recursive: true, force: true });
});

function writeTask(id: string, status: string, extra: string[] = [], updates: string[] = []) {
  const lines = [`# ${id}: Task ${id}`, "", `* status: ${status}`, ...extra, "", "## Updates", ...updates, ""];
  fs.writeFileSync(path.join(root, "tasks", `${id}.md`), lines.join("\n"));
}

const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const recorded = (from: string, to: string) => `* 2026-10-23 14:00 · orchestrator · status: ${from} → ${to}`;

async function start(): Promise<{ orchestrator: Orchestrator; notes: Notification[] }> {
  const notes: Notification[] = [];
  const orchestrator = new Orchestrator(root, { notify: (n) => notes.push(n), log: () => {}, now: fixedNow, watch: false, lockRetryMs: 20 });
  running.push(orchestrator);
  await orchestrator.start();
  return { orchestrator, notes };
}

const lastSnapshot = (notes: Notification[]) =>
  notes.filter((n) => n.method === "tasks/changed").at(-1)?.params as TasksSnapshot;
const lastDiagnostics = (notes: Notification[]) =>
  notes.filter((n) => n.method === "tasks/diagnostics").at(-1)?.params as DiagnosticsSnapshot;

describe("Orchestrator passes", () => {
  it("moves a ready task with unfinished dependencies to waiting, records why, and builds the index", async () => {
    writeTask("T-1", "in-implementation", ["* kind: infrastructure"], [recorded("ready", "in-implementation")]);
    writeTask("T-2", "ready", ["* depends_on: [[T-1]]"], [recorded("draft", "ready")]);
    const { notes } = await start();

    expect(read("tasks/T-2.md")).toContain("* status: waiting-for-dependencies");
    expect(read("tasks/T-2.md")).toContain("· orchestrator · status: ready → waiting-for-dependencies · waiting on [[T-1]]");
    expect(read("TASKS.md")).toBe("# Tasks\n\n## Index\n* [[T-1]] Task T-1 · in-implementation\n* [[T-2]] Task T-2 · waiting-for-dependencies\n");
    expect(lastSnapshot(notes).tasks.map((t) => [t.id, t.status, t.allowed])).toEqual([
      ["T-1", "in-implementation", []],
      ["T-2", "waiting-for-dependencies", []],
    ]);
  });

  it("settles a chain in one pass and is idempotent afterwards", async () => {
    writeTask("T-1", "done", [], [recorded("review", "done")]);
    writeTask("T-2", "waiting-for-dependencies", ["* depends_on: [[T-1]]"], [recorded("ready", "waiting-for-dependencies")]);
    const { orchestrator } = await start();
    expect(read("tasks/T-2.md")).toContain("* status: ready");
    const after = read("tasks/T-2.md");
    await orchestrator.runPass();
    await orchestrator.runPass();
    expect(read("tasks/T-2.md")).toBe(after);
  });

  it("notes a hand edit that isn't allowed exactly once and leaves it", async () => {
    writeTask("T-1", "review", [], [recorded("ready", "in-implementation")]);
    const { orchestrator } = await start();
    await orchestrator.runPass();
    const text = read("tasks/T-1.md");
    expect(text).toContain("* status: review");
    expect(text.match(/edited by hand, but review is set by the orchestrator; parked/g)).toHaveLength(1);
  });

  it("records an allowed hand edit as the human's", async () => {
    writeTask("T-1", "ready");
    await start();
    expect(read("tasks/T-1.md")).toContain("· human · status: draft → ready");
  });

  it("never writes a file that doesn't parse, and reports it", async () => {
    fs.writeFileSync(path.join(root, "tasks", "T-3.md"), "no title\n* status: ready\n");
    const { notes } = await start();
    expect(read("tasks/T-3.md")).toBe("no title\n* status: ready\n");
    expect(read("TASKS.md")).toContain("* [[T-3]] · does not parse");
    expect(lastDiagnostics(notes).files).toEqual([
      { path: "tasks/T-3.md", diagnostics: [{ line: 0, severity: "error", message: 'The first line must be "# T-3: Title".' }] },
    ]);
  });

  it("removes temp files left by a crash and doesn't treat them as tasks", async () => {
    fs.writeFileSync(path.join(root, "tasks", `${TEMP_PREFIX}dead.tmp`), "# T-9: partial");
    const { notes } = await start();
    expect(fs.readdirSync(path.join(root, "tasks"))).toEqual([]);
    expect(lastSnapshot(notes).tasks).toEqual([]);
  });

  it("pauses writes during a git operation", async () => {
    fs.mkdirSync(path.join(root, ".git"));
    fs.writeFileSync(path.join(root, ".git", "MERGE_HEAD"), "abc\n");
    writeTask("T-1", "ready");
    const before = read("tasks/T-1.md");
    await start();
    expect(read("tasks/T-1.md")).toBe(before);
  });

  function gitCommit(sha: string) {
    fs.mkdirSync(path.join(root, ".git", "refs", "heads"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.writeFileSync(path.join(root, ".git", "refs", "heads", "main"), `${sha}\n`);
  }

  it("accepts statuses changed by a pull on the same branch instead of noting them as hand edits", async () => {
    gitCommit("a".repeat(40));
    writeTask("T-1", "draft");
    const { orchestrator } = await start();
    // The pull brings a version where the status line moved but Updates didn't.
    writeTask("T-1", "review", [], [recorded("draft", "in-implementation")]);
    gitCommit("b".repeat(40));
    await orchestrator.runPass();
    expect(read("tasks/T-1.md")).not.toContain("edited by hand");
  });

  it("after a restart, notes edits made while it was down when git didn't move", async () => {
    gitCommit("a".repeat(40));
    writeTask("T-1", "draft");
    const first = await start();
    first.orchestrator.stop();
    writeTask("T-1", "review", [], [recorded("draft", "in-implementation")]);
    await start();
    expect(read("tasks/T-1.md")).toContain("edited by hand");
  });

  it("reports a file it can't use instead of crashing", async () => {
    fs.mkdirSync(path.join(root, "tasks", "T-4.md"));
    writeTask("T-1", "draft");
    const { notes } = await start();
    expect(lastDiagnostics(notes).files.find((f) => f.path === "tasks/T-4.md")?.diagnostics[0]?.message).toMatch(/can't use this file/);
    expect(read("TASKS.md")).toContain("* [[T-4]] · does not parse");
  });

  it("refuses a symlinked tasks/ directory", async () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    fs.writeFileSync(path.join(elsewhere, "T-1.md"), "# T-1: x\n* status: ready\n");
    fs.rmSync(path.join(root, "tasks"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(root, "tasks"));
    const { notes } = await start();
    expect(fs.readFileSync(path.join(elsewhere, "T-1.md"), "utf8")).toBe("# T-1: x\n* status: ready\n");
    expect(lastSnapshot(notes).tasks).toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("switches to read-only when its heartbeat finds the lock taken over", async () => {
    writeTask("T-1", "draft");
    const notes: Notification[] = [];
    const orchestrator = new Orchestrator(root, { notify: (n) => notes.push(n), log: () => {}, now: fixedNow, watch: false, heartbeatMs: 20, lockRetryMs: 60_000 });
    running.push(orchestrator);
    await orchestrator.start();
    expect(orchestrator.isReadOnly).toBe(false);
    fs.writeFileSync(path.join(root, ".excaliharness", "orchestrator.lock"), JSON.stringify({ pid: 1, host: "elsewhere", startedAt: "", script: "x", root }));
    const until = Date.now() + 2_000;
    while (!orchestrator.isReadOnly && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(orchestrator.isReadOnly).toBe(true);
  });

  it("stops writing as soon as its lock file is gone", async () => {
    writeTask("T-1", "draft");
    const { orchestrator } = await start();
    fs.rmSync(path.join(root, ".excaliharness", "orchestrator.lock"));
    writeTask("T-1", "ready");
    // Another worker could take the lock now; this one must not write first.
    fs.writeFileSync(path.join(root, ".excaliharness", "orchestrator.lock"), JSON.stringify({ pid: 1, host: "elsewhere", startedAt: "", script: "x", root }));
    const before = read("tasks/T-1.md");
    await orchestrator.runPass();
    expect(read("tasks/T-1.md")).toBe(before);
    expect(orchestrator.isReadOnly).toBe(true);
  });
});

describe("setStatus", () => {
  const params = (status: string) => {
    const text = read("tasks/T-1.md");
    return { id: "T-1", to: "ready" as const, expectedStatus: status as "draft", expectedHash: hashOf(text) };
  };

  it("marks a draft ready, recording it, and publishes before answering", async () => {
    writeTask("T-1", "draft");
    const { orchestrator, notes } = await start();
    const before = notes.length;
    await expect(orchestrator.setStatus(params("draft"))).resolves.toEqual({ ok: true });
    expect(notes.length).toBeGreaterThan(before);
    expect(read("tasks/T-1.md")).toContain("* status: ready");
    expect(read("tasks/T-1.md")).toContain("· human · status: draft → ready");
  });

  it("refuses when the file changed since it was shown, or the status differs", async () => {
    writeTask("T-1", "draft");
    const { orchestrator } = await start();
    await expect(orchestrator.setStatus({ ...params("draft"), expectedHash: "stale" })).rejects.toThrow(/changed since it was shown/);
    await expect(orchestrator.setStatus(params("needs-human"))).rejects.toThrow(/is draft, not needs-human/);
  });

  it("refuses a change the rules don't allow", async () => {
    writeTask("T-1", "in-implementation", [], [recorded("ready", "in-implementation")]);
    const { orchestrator } = await start();
    await expect(orchestrator.setStatus(params("in-implementation"))).rejects.toThrow(/marked ready only from draft or needs-human/);
  });
});

describe("two windows", () => {
  it("runs the second worker read-only until the first stops", async () => {
    writeTask("T-1", "draft");
    const first = await start();
    const second = await start();
    expect(second.orchestrator.isReadOnly).toBe(true);
    expect(lastSnapshot(second.notes).readOnly).toBe(true);
    await expect(second.orchestrator.setStatus({ id: "T-1", to: "ready", expectedStatus: "draft", expectedHash: hashOf(read("tasks/T-1.md")) })).rejects.toThrow(
      /another VS Code window/,
    );
    first.orchestrator.stop();
    const until = Date.now() + 2_000;
    while (second.orchestrator.isReadOnly && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    expect(second.orchestrator.isReadOnly).toBe(false);
  });
});

describe("parked tasks (D-076)", () => {
  it("parks a disallowed hand edit, reports it as an error, and starts nothing", async () => {
    writeTask("T-1", "in-implementation", [], [recorded("draft", "ready")]);
    const { orchestrator, notes } = await start();
    await orchestrator.runPass();
    expect(read("tasks/T-1.md")).toMatch(/status: ready → in-implementation · edited by hand, but .*; parked$/m);
    expect(read("TASKS.md")).toContain("* [[T-1]] Task T-1 · parked (in-implementation)");
    const diag = lastDiagnostics(notes).files.find((f) => f.path === "tasks/T-1.md")?.diagnostics[0];
    expect(diag).toMatchObject({ severity: "error", message: expect.stringMatching(/T-1 is parked/) as unknown });
    expect(lastSnapshot(notes).tasks[0]).toMatchObject({ parked: true, allowed: ["ready", "draft"] });
  });

  it("unparks when the human moves it back to draft", async () => {
    writeTask("T-2", "in-implementation", [], ["* 2026-10-23 14:01 · orchestrator · status: review → in-implementation · edited by hand, but x; parked"]);
    const { orchestrator, notes } = await start();
    const t2 = () => lastSnapshot(notes).tasks.find((t) => t.id === "T-2");
    expect(t2()).toMatchObject({ parked: true, allowed: ["ready", "draft"] });
    await orchestrator.setStatus({ id: "T-2", to: "draft", expectedStatus: "in-implementation", expectedHash: hashOf(read("tasks/T-2.md")) });
    expect(t2()).toMatchObject({ status: "draft", parked: false });
  });
});

describe("running tasks", () => {
  type Round = (task: { id: string }, abort: AbortController, context: RunContext) => Promise<RunOutcome>;
  const clean = (summary: string, notes: string[] = []): Promise<RunOutcome> => Promise.resolve({ kind: "clean", summary, notes });
  async function startWith(round: Round, preflight: () => Promise<void> = () => Promise.resolve(), sweep?: () => Promise<void>) {
    const notes: Notification[] = [];
    const runner = {
      preflight,
      run: (task: Parameters<Round>[0], _text: string, abort: AbortController, context: RunContext) => round(task, abort, context),
      worktreePath: (id: string) => `/state/worktrees/${id}`,
      ...(sweep ? { sweep } : {}),
    };
    const orchestrator = new Orchestrator(root, { notify: (n) => notes.push(n), log: () => {}, now: fixedNow, watch: false, runner });
    running.push(orchestrator);
    await orchestrator.start();
    return { orchestrator, notes };
  }
  const settle = async (o: Orchestrator, check: () => boolean) => {
    const until = Date.now() + 3_000;
    while (!check() && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20));
      await o.runPass();
    }
  };

  it("takes a ready task through in-implementation to review, with the summary and notes", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const { orchestrator, notes } = await startWith(async (_t, _a, context) => {
      await context.note("round 1: gates passed; no findings");
      return clean("Added hello.js\nmore", ["The implementer made no tests."]);
    });
    await settle(orchestrator, () => read("tasks/T-1.md").includes("status: review"));
    const text = read("tasks/T-1.md");
    expect(text).toContain("status: ready → in-implementation · started");
    expect(text).toContain("· orchestrator · round 1: gates passed; no findings");
    expect(text).toContain("status: in-implementation → review · gates passed and reviewers found nothing: Added hello.js");
    expect(text).toContain("· orchestrator · The implementer made no tests.");
    expect(text).toMatch(/^\* status: review\n\* review: \[Open review\]\(vscode:\/\/madhadron\.excaliharness\/review\/T-1\)\n\n## Updates/m);
    expect(notes).toContainEqual({ method: "task/attention", params: { id: "T-1", title: "Task T-1", status: "review", path: "tasks/T-1.md", worktree: "/state/worktrees/T-1" } });
  });

  it("sends a task still open after the last round to needs-human, listing what's open", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const { orchestrator, notes } = await startWith(() => Promise.resolve({ kind: "needs-human", reason: "still open after 3 rounds", notes: ["blocking - crashes on empty input (agents/r)"] }));
    await settle(orchestrator, () => read("tasks/T-1.md").includes("needs-human"));
    const text = read("tasks/T-1.md");
    expect(text).toContain("status: in-implementation → needs-human · still open after 3 rounds");
    expect(text).toContain("· orchestrator · blocking - crashes on empty input (agents/r)");
    expect(notes.some((n) => n.method === "task/attention" && n.params.status === "needs-human")).toBe(true);
  });

  it("writes an agent's question, waits for the answer, then resumes the task", async () => {
    writeTask("T-1", "ready", ["", "## Questions"], [recorded("draft", "ready")]);
    const runs: RunContext[] = [];
    const { orchestrator, notes } = await startWith((_t, _a, context) => {
      runs.push(context);
      return runs.length === 1 ? Promise.resolve({ kind: "question", question: "Which date format?", asker: "agents/implementer", notes: [] }) : clean("done");
    });
    await settle(orchestrator, () => read("tasks/T-1.md").includes("needs-decision"));
    let text = read("tasks/T-1.md");
    expect(text).toContain("status: in-implementation → needs-decision · agents/implementer asked a question");
    expect(text).toContain("* [ ] Q: Which date format?\n  A:");
    const attention = notes.find((n) => n.method === "task/attention");
    expect(attention?.params).toMatchObject({ status: "needs-decision", questionsLine: 4 });
    // The human answers and checks the box: the task carries on.
    fs.writeFileSync(path.join(root, "tasks", "T-1.md"), text.replace("* [ ] Q: Which date format?\n  A:", "* [x] Q: Which date format?\n  A: ISO 8601"));
    await orchestrator.runPass();
    await settle(orchestrator, () => read("tasks/T-1.md").includes("status: review"));
    text = read("tasks/T-1.md");
    expect(text).toContain("status: needs-decision → in-implementation · all questions are answered");
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => !r.fromNeedsHuman)).toBe(true);
  });

  it("tells the runner when the human marked the task ready from needs-human", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready"), recorded("ready", "in-implementation"), recorded("in-implementation", "needs-human"), "* 2026-10-23 15:00 · human · status: needs-human → ready"]);
    const runs: RunContext[] = [];
    const { orchestrator } = await startWith((_t, _a, context) => {
      runs.push(context);
      return clean("x");
    });
    await settle(orchestrator, () => runs.length > 0);
    expect(runs[0]?.fromNeedsHuman).toBe(true);
  });

  it("sends a blocked task to needs-human with the reason", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const { orchestrator } = await startWith(() => Promise.reject(new TaskBlocked("the repository is missing Dockerfile")));
    await settle(orchestrator, () => read("tasks/T-1.md").includes("needs-human"));
    expect(read("tasks/T-1.md")).toContain("status: in-implementation → needs-human · can't run: the repository is missing Dockerfile");
  });

  it("notifies the human however a task reaches needs-human", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const { orchestrator, notes } = await startWith(() => Promise.reject(new Error("docker compose up failed")));
    await settle(orchestrator, () => read("tasks/T-1.md").includes("needs-human"));
    await settle(orchestrator, () => notes.some((n) => n.method === "task/attention"));
    expect(notes.find((n) => n.method === "task/attention")?.params).toMatchObject({ id: "T-1", status: "needs-human" });
  });

  it("leaves the task alone when Docker or the token isn't available", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const before = read("tasks/T-1.md");
    let rounds = 0;
    const { orchestrator } = await startWith(
      () => {
        rounds++;
        return clean("x");
      },
      () => Promise.reject(new Error("Docker isn't running")),
    );
    await orchestrator.runPass();
    await new Promise((r) => setTimeout(r, 50));
    expect(read("tasks/T-1.md")).toBe(before);
    expect(rounds).toBe(0);
  });

  // A round that runs until it is aborted, then cleans up for `cleanupMs`.
  const untilAborted = (started: () => void, cleanupMs = 0): Round => (_task, abort) =>
    new Promise((_resolve, reject) => {
      started();
      abort.signal.addEventListener("abort", () => setTimeout(() => reject(new Error("aborted")), cleanupMs));
    });

  it("stops a running task when the human moves it, and leaves the status they set", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    let started = false;
    const { orchestrator } = await startWith(untilAborted(() => (started = true)));
    await settle(orchestrator, () => started);
    expect(read("tasks/T-1.md")).toContain("* status: in-implementation");
    fs.writeFileSync(path.join(root, "tasks", "T-1.md"), read("tasks/T-1.md").replace("* status: in-implementation", "* status: draft"));
    await orchestrator.runPass();
    await settle(orchestrator, () => read("tasks/T-1.md").includes("parked"));
    await new Promise((r) => setTimeout(r, 50));
    const text = read("tasks/T-1.md");
    expect(text).toContain("* status: draft");
    expect(text).not.toContain("needs-human");
  });

  it("keeps the task in-implementation when Claude rejects the token", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    let rounds = 0;
    const { orchestrator } = await startWith(() => {
      rounds++;
      return Promise.reject(new TokenRejected("Claude rejected the token: 401"));
    });
    await settle(orchestrator, () => rounds > 0);
    await new Promise((r) => setTimeout(r, 50));
    await orchestrator.runPass();
    const text = read("tasks/T-1.md");
    expect(text).toContain("* status: in-implementation");
    expect(text).not.toContain("needs-human");
    expect(rounds).toBe(1);
  });

  it("stops leftover projects before starting any task", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    const order: string[] = [];
    let finishSweep!: () => void;
    const { orchestrator } = await startWith(
      () => {
        order.push("round");
        return clean("x");
      },
      undefined,
      () => {
        order.push("sweep");
        return new Promise<void>((r) => (finishSweep = r));
      },
    );
    await orchestrator.runPass();
    expect(order).toEqual(["sweep"]);
    finishSweep();
    await settle(orchestrator, () => order.includes("round"));
    expect(order).toEqual(["sweep", "round"]);
  });

  it("waits for running tasks to clean up on shutdown, but not forever", async () => {
    writeTask("T-1", "ready", [], [recorded("draft", "ready")]);
    let started = false;
    const { orchestrator } = await startWith(untilAborted(() => (started = true), 100));
    await settle(orchestrator, () => started);
    const before = Date.now();
    await orchestrator.shutdown(5_000);
    const waited = Date.now() - before;
    expect(waited).toBeGreaterThanOrEqual(90);
    expect(waited).toBeLessThan(2_000);
    expect(read("tasks/T-1.md")).toContain("* status: in-implementation");

    writeTask("T-2", "ready", [], [recorded("draft", "ready")]);
    let started2 = false;
    const second = await startWith(untilAborted(() => (started2 = true), 60_000));
    await settle(second.orchestrator, () => started2);
    const t = Date.now();
    await second.orchestrator.shutdown(100);
    expect(Date.now() - t).toBeLessThan(1_000);
  });

  it("never starts a draft or a parked task", async () => {
    writeTask("T-1", "draft");
    writeTask("T-2", "ready", [], ["* 2026-10-23 14:01 · orchestrator · status: draft → ready · edited by hand, but x; parked"]);
    let rounds = 0;
    const { orchestrator } = await startWith(() => {
      rounds++;
      return clean("x");
    });
    await orchestrator.runPass();
    await new Promise((r) => setTimeout(r, 50));
    expect(rounds).toBe(0);
  });
});
