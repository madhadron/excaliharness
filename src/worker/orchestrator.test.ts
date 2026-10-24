import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Orchestrator } from "./orchestrator";
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
    expect(text.match(/edited by hand, but review is set by the orchestrator; left as is/g)).toHaveLength(1);
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
