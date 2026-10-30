// The round loop (D-072, D-080, D-083) with its Docker and agent steps
// scripted: what runs in which order, when the task is clean, needs the
// human or asks, and when an image may be built with the network on.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Task } from "../tasks/model";
import type { AgentOutcome } from "./session";
import { run } from "./exec";
import type { Finding, GateFailure } from "./findings";
import { Rounds, type RoundState } from "./rounds";
import { TaskRunner, type RunContext, type RunnerDeps, type RunOutcome } from "./runner";

let root: string;
let state: string;
const images = new Set<string>();
const git = (args: string[], cwd = root) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  images.clear();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "loop-state-"));
  git(["init", "-q", "-b", "main"]);
  fs.mkdirSync(path.join(root, "agents"));
  fs.writeFileSync(path.join(root, "agents", "implementer.md"), "---\ntools: Read, Edit\n---\nImplement.\n");
  fs.writeFileSync(path.join(root, "agents", "reviewer.md"), "---\ntools: Read\n---\nReview.\n");
  fs.writeFileSync(path.join(root, "TASKS.md"), "# Tasks\n\n## Pipelines\n* default\n    * implement: [[agents/implementer]]\n    * review: [[agents/reviewer]]\n\n## Index\n");
  fs.writeFileSync(path.join(root, "Dockerfile"), "FROM x\nCOPY . .\n");
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

const task = (statusEntries: Task["statusEntries"] = []): Task =>
  ({ id: "T-1", title: "t", status: "in-implementation", statusLine: 2, dependsOn: [], metadata: [], sections: [], questions: [], statusEntries }) as unknown as Task;

function deps(): RunnerDeps {
  return {
    root,
    stateDir: state,
    socket: "/nonexistent",
    docker: { version: () => Promise.resolve("27.0.0"), inspectImage: (id: string) => Promise.resolve(images.has(id) ? { Id: id } : undefined), ping: () => Promise.resolve() } as never,
    run,
    baseImage: { ensure: () => Promise.resolve(`sha256:${"b".repeat(64)}`) } as never,
    proxyImage: { ensure: () => Promise.resolve(`sha256:${"p".repeat(64)}`) } as never,
    token: () => Promise.resolve("sk-ant-oat01-test"),
    tokenRejected: () => {},
    log: () => {},
  };
}

interface Script {
  implementer: (round: number) => AgentOutcome;
  gates: (round: number) => GateFailure[];
  review: (round: number) => { findings: Finding[] } | { question: string; asker: string };
}

// Docker and agents scripted; the loop, git and the saved state are real.
class Scripted extends TaskRunner {
  readonly calls: string[] = [];
  readonly answered: boolean[] = [];
  constructor(private readonly script: Script) {
    super(deps());
  }
  // A real (unused) environment, so the loop's instanceof check passes.
  protected override projectEnv(): Promise<never> {
    const self = this as unknown as { baseEnv(d: unknown): unknown };
    return Promise.resolve(self.baseEnv({ name: "p", dir: state, mounts: {}, proxyImage: "p", baseImage: "b" }) as never);
  }
  protected override implementerTurn(o: { state: RoundState; answered: boolean }): Promise<AgentOutcome> {
    this.calls.push(`implement ${o.state.round}`);
    this.answered.push(o.answered);
    const outcome = this.script.implementer(o.state.round);
    if (!outcome.question) fs.appendFileSync(path.join(this.worktreePath("T-1"), "a.txt"), `round ${o.state.round}\n`);
    return Promise.resolve(outcome);
  }
  protected override gates(_env: unknown, _id: string, round: number): Promise<GateFailure[]> {
    this.calls.push(`gates ${round}`);
    return Promise.resolve(this.script.gates(round));
  }
  protected override review(_env: unknown, _task: Task, _text: string, s: RoundState): Promise<{ findings: Finding[] } | { question: string; asker: string }> {
    this.calls.push(`review ${s.round}`);
    return Promise.resolve(this.script.review(s.round));
  }
}

const finding: Finding = { severity: "nit", summary: "rename x", reviewer: "agents/reviewer" };
const failure: GateFailure = { label: "Run tests", commands: ["make test"], code: 1, timedOut: false, output: "fail" };
const context = (fromNeedsHuman = false) => {
  const notes: string[] = [];
  const ctx: RunContext = { fromNeedsHuman, note: (line) => Promise.resolve(void notes.push(line)) };
  return { ctx, notes };
};
const go = (runner: TaskRunner, ctx: RunContext, t = task()): Promise<RunOutcome> => runner.run(t, "# T-1: t\n", new AbortController(), ctx);

describe("the round loop", () => {
  it("implements, gates and reviews, and is clean when nothing is left", async () => {
    const runner = new Scripted({ implementer: () => ({ answered: true, summary: "Did it." }), gates: () => [], review: () => ({ findings: [] }) });
    const { ctx, notes } = context();
    expect(await go(runner, ctx)).toEqual({ kind: "clean", summary: "Did it.", notes: [] });
    expect(runner.calls).toEqual(["implement 1", "gates 1", "review 1"]);
    expect(notes).toEqual(["round 1: gates passed; no findings"]);
    expect(git(["log", "-1", "--format=%s", "task/T-1"])).toBe("T-1: Did it.");
  });

  it("runs another round for any failure or finding, nits included, and stops after three (D-083)", async () => {
    const runner = new Scripted({ implementer: () => ({ answered: true, summary: "Tried." }), gates: (r) => (r === 1 ? [failure] : []), review: () => ({ findings: [finding] }) });
    const { ctx, notes } = context();
    const outcome = await go(runner, ctx);
    expect(outcome).toMatchObject({ kind: "needs-human", reason: "still open after 3 rounds" });
    expect(outcome.notes).toEqual(["nit - rename x (agents/reviewer)"]);
    expect(runner.calls).toEqual(["implement 1", "gates 1", "review 1", "implement 2", "gates 2", "review 2", "implement 3", "gates 3", "review 3"]);
    expect(notes[0]).toBe("round 1: `make test` failed; 1 finding (0 blocking)");
    // Until the human marks it ready, it stays out of rounds.
    const again = new Scripted({ implementer: () => ({ answered: true }), gates: () => [], review: () => ({ findings: [] }) });
    expect(await go(again, context().ctx)).toMatchObject({ kind: "needs-human" });
    expect(again.calls).toEqual([]);
    // Marked ready: three more rounds, starting with the implementer.
    expect(await go(again, context(true).ctx)).toMatchObject({ kind: "clean" });
    expect(again.calls).toEqual(["implement 1", "gates 1", "review 1"]);
  });

  it("pauses for a question and resumes in the same round (D-083)", async () => {
    let asked = false;
    const runner = new Scripted({
      implementer: () => (asked ? { answered: true, summary: "With the answer." } : ((asked = true), { answered: true, question: "Which?" })),
      gates: () => [],
      review: () => ({ findings: [] }),
    });
    expect(await go(runner, context().ctx)).toMatchObject({ kind: "question", question: "Which?", asker: "agents/implementer" });
    expect(new Rounds(path.join(state, "rounds")).load("T-1")).toMatchObject({ round: 1, phase: "implement", paused: "implementer" });
    const answered = task([{ from: "in-implementation", to: "needs-decision", line: 9 }, { from: "needs-decision", to: "in-implementation", line: 10 }]);
    expect(await go(runner, context().ctx, answered)).toMatchObject({ kind: "clean", summary: "With the answer." });
    expect(runner.calls).toEqual(["implement 1", "implement 1", "gates 1", "review 1"]);
    expect(runner.answered).toEqual([false, true]);
  });

  it("resumes a reviewer's question in review, without implementing or gating again", async () => {
    let asked = false;
    const runner = new Scripted({
      implementer: () => ({ answered: true, summary: "Did it." }),
      gates: () => [],
      review: () => (asked ? { findings: [] } : ((asked = true), { question: "Is X intended?", asker: "agents/reviewer" })),
    });
    expect(await go(runner, context().ctx)).toMatchObject({ kind: "question", asker: "agents/reviewer" });
    const answered = task([{ from: "in-implementation", to: "needs-decision", line: 9 }, { from: "needs-decision", to: "in-implementation", line: 10 }]);
    expect(await go(runner, context().ctx, answered)).toMatchObject({ kind: "clean" });
    expect(runner.calls).toEqual(["implement 1", "gates 1", "review 1", "review 1"]);
  });

  it("keeps a clean result until the orchestrator has recorded it", async () => {
    const runner = new Scripted({ implementer: () => ({ answered: true, summary: "Done." }), gates: () => [], review: () => ({ findings: [] }) });
    await go(runner, context().ctx);
    // A crash before the status was written: the next run reports it again
    // without running anything.
    const after = new Scripted({ implementer: () => ({ answered: true }), gates: () => [], review: () => ({ findings: [] }) });
    expect(await go(after, context().ctx)).toMatchObject({ kind: "clean", summary: "Done." });
    expect(after.calls).toEqual([]);
    after.finished("T-1");
    expect(new Rounds(path.join(state, "rounds")).load("T-1").phase).toBe("implement");
  });

  it("looks at a task afresh when it is started again after a clean result", async () => {
    const runner = new Scripted({ implementer: () => ({ answered: true, summary: "Done." }), gates: () => [], review: () => ({ findings: [] }) });
    await go(runner, context().ctx);
    // The status write was missed, then the human set it ready again.
    const restarted = new Scripted({ implementer: () => ({ answered: true, summary: "Again." }), gates: () => [], review: () => ({ findings: [] }) });
    expect(await go(restarted, { ...context().ctx, started: true })).toMatchObject({ kind: "clean", summary: "Again." });
    expect(restarted.calls).toEqual(["implement 1", "gates 1", "review 1"]);
  });
});

// The image steps, with the build itself recorded instead of run.
class Builds extends TaskRunner {
  readonly built: string[] = [];
  fail = false;
  constructor() {
    super(deps());
  }
  protected override buildSpecs(): Promise<never> {
    return Promise.resolve([{ context: ".", dockerfile: "Dockerfile" }] as never);
  }
  protected override build(_d: unknown, s: RoundState, commit: string): Promise<never> {
    this.built.push(commit);
    if (this.fail) return Promise.resolve({ kind: "build-failed", output: "npm ERR" } as never);
    const id = `sha256:${commit.slice(0, 8).padEnd(64, "0")}`;
    images.add(id);
    s.image = { builtFrom: commit, devImage: "d", derived: id };
    return Promise.resolve(id as never);
  }
  ensure(s: RoundState): Promise<unknown> {
    const d = { task: task(), name: "p", dir: state, mounts: {}, token: "t", baseImage: "b", proxyImage: "p", notes: [], warned: false };
    return this.ensureImage(d as never, s, new AbortController().signal);
  }
}

describe("rebuilds (D-080)", () => {
  it("builds the start commit without asking, and anything else only once approved for that commit", async () => {
    const runner = new Builds();
    const worktree = await (runner as unknown as { worktrees: { ensure(id: string): Promise<string> } }).worktrees.ensure("T-1");
    const start = git(["rev-parse", "HEAD"]);
    const s: RoundState = { round: 1, phase: "implement", failures: [], findings: [] };
    // First build: the human's own commit.
    expect(typeof (await runner.ensure(s))).toBe("string");
    expect(runner.built).toEqual([start]);
    // Source changes need no rebuild.
    fs.writeFileSync(path.join(worktree, "a.txt"), "two\n");
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qam", "source"], worktree);
    expect(await runner.ensure(s)).toBe(s.image?.derived);
    expect(runner.built).toHaveLength(1);
    // A build input changed: the human is asked, for exactly this commit.
    fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
    git(["add", "-A"], worktree);
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "dep"], worktree);
    const head = git(["rev-parse", "HEAD"], worktree);
    expect(await runner.ensure(s)).toMatchObject({ kind: "needs-human", reason: expect.stringMatching(/package\.json.*rebuild it from commit/) as unknown });
    expect(s.approval).toEqual({ commit: head, approved: false });
    // Approved, but the agent committed something else since: asked again.
    s.approval = { commit: head, approved: true };
    fs.writeFileSync(path.join(worktree, "Dockerfile"), "FROM evil\n");
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qam", "more"], worktree);
    expect(await runner.ensure(s)).toMatchObject({ kind: "needs-human" });
    expect(runner.built).toHaveLength(1);
    // Approved for the current commit: built once, and the approval is used.
    const now = git(["rev-parse", "HEAD"], worktree);
    s.approval = { commit: now, approved: true };
    expect(typeof (await runner.ensure(s))).toBe("string");
    expect(runner.built).toEqual([start, now]);
    expect(s.approval).toBeUndefined();
  });

  it("rebuilds a missing image only from the commit it was built from", async () => {
    const runner = new Builds();
    const worktree = await (runner as unknown as { worktrees: { ensure(id: string): Promise<string> } }).worktrees.ensure("T-1");
    const s: RoundState = { round: 1, phase: "implement", failures: [], findings: [] };
    await runner.ensure(s);
    // An approved dependency change becomes the built commit.
    fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
    git(["add", "-A"], worktree);
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "dep"], worktree);
    const approved = git(["rev-parse", "HEAD"], worktree);
    s.approval = { commit: approved, approved: true };
    await runner.ensure(s);
    // Then a source-only change, and the image is pruned.
    fs.writeFileSync(path.join(worktree, "a.txt"), "src\n");
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qam", "src"], worktree);
    images.clear();
    await runner.ensure(s);
    expect(runner.built.slice(1)).toEqual([approved, approved]);
  });

  it("keeps a failed approved build waiting for the human, then retries that commit", async () => {
    const runner = new Builds();
    const worktree = await (runner as unknown as { worktrees: { ensure(id: string): Promise<string> } }).worktrees.ensure("T-1");
    const s: RoundState = { round: 1, phase: "implement", failures: [], findings: [] };
    await runner.ensure(s);
    fs.writeFileSync(path.join(worktree, "package.json"), "{}\n");
    git(["add", "-A"], worktree);
    git(["-c", "core.hooksPath=/dev/null", "commit", "-qm", "dep"], worktree);
    const head = git(["rev-parse", "HEAD"], worktree);
    s.approval = { commit: head, approved: true };
    runner.fail = true;
    expect(await runner.ensure(s)).toEqual({ kind: "build-failed", output: "npm ERR" });
    expect(s.approval).toEqual({ commit: head, approved: false });
    // Restarted before the human answered: the same failure, no new prompt.
    expect(await runner.ensure(s)).toEqual({ kind: "build-failed", output: "npm ERR" });
    // Marked ready (afterHumanReady approves it): tried again.
    s.approval = { commit: head, approved: true };
    runner.fail = false;
    expect(typeof (await runner.ensure(s))).toBe("string");
    expect(s.failedBuild).toBeUndefined();
  });
});
