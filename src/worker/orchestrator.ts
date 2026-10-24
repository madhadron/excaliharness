// Ties the task model to the files: scans, applies the status rules, writes
// status changes, Updates lines and the index, and tells the extension. All
// work runs as jobs on one serial queue, so a setStatus request can never
// interleave with a pass (finding 10 of the robustness review).
import * as fs from "node:fs";
import * as path from "node:path";
import { CACHE_DIR, HEARTBEAT_MS, tryAcquire, type Acquired } from "./lock";
import type { Notification, SetStatusParams, TasksSnapshot, TaskSummary } from "./protocol";
import { hashOf, readFile, removeLeftoverTempFiles, Store } from "./store";
import { editTask, replaceIndex, type TaskEdit } from "./tasks/edit";
import { indexLines, type IndexEntry } from "./tasks/index";
import type { Diagnostic, Status, Task } from "./tasks/model";
import { parseTask, parseTasksIndex } from "./tasks/parse";
import { allowedHumanStatuses, decide, humanChangeRefusal, isAllowedHumanChange, recordedStatus, type Change } from "./tasks/transitions";
import { gitDir, resolveHead } from "./git";
import { TaskWatcher, type WatchOptions } from "./watch";

const TASK_FILE = /^(T-\d+)\.md$/;
const INDEX_FILE = "TASKS.md";
// How long git may look busy before the paused writes are reported.
const GIT_STUCK_MS = 30_000;

export interface OrchestratorOptions {
  notify: (notification: Notification) => void;
  log: (line: string) => void;
  now?: () => Date;
  // false disables watching (tests drive passes directly).
  watch?: WatchOptions | false;
  lockRetryMs?: number;
  heartbeatMs?: number;
  gitRetryMs?: number;
  maxRounds?: number;
}

interface ScannedTask {
  task: Task;
  path: string;
  hash: string;
}

interface Scan {
  tasks: Map<string, ScannedTask>;
  broken: { id: string; path: string }[];
  diagnostics: Map<string, Diagnostic[]>;
  index?: { text: string; ok: boolean };
}

export class Orchestrator {
  private queue: Promise<unknown> = Promise.resolve();
  private passQueued = false;
  private version = 0;
  private readOnly = true;
  private releaseLock: (() => void) | undefined;
  private lockStillHeld: (() => boolean) | undefined;
  private heartbeat: NodeJS.Timeout | undefined;
  private gitBusySince: number | undefined;
  private soonTimer: NodeJS.Timeout | undefined;
  private lastPublished = "";
  private lockTimer: NodeJS.Timeout | undefined;
  private gitTimer: NodeJS.Timeout | undefined;
  private watcher: TaskWatcher | undefined;
  // The commit last seen checked out, persisted so a restarted worker can
  // tell statuses that git changed from hand edits made while it was down.
  private lastHead: string | undefined;
  private stopped = false;
  // Baselines that override the recorded status (after a git checkout).
  private readonly accepted = new Map<string, Status>();
  // Problems found while writing, shown with the next snapshot.
  private readonly writeProblems = new Map<string, Diagnostic[]>();
  private readonly store = new Store();
  private readonly now: () => Date;
  private readonly maxRounds: number;
  private lastSnapshot: TasksSnapshot = { version: 0, readOnly: true, tasks: [] };

  constructor(
    private readonly root: string,
    private readonly options: OrchestratorOptions,
  ) {
    this.now = options.now ?? (() => new Date());
    this.maxRounds = options.maxRounds ?? 5;
  }

  get isReadOnly(): boolean {
    return this.readOnly;
  }

  async start(): Promise<void> {
    this.acquireLock();
    if (this.options.watch !== false) {
      this.watcher = new TaskWatcher(
        this.root,
        {
          onChange: () => this.schedulePass(),
          onError: (message) => this.options.log(message),
        },
        this.options.watch,
      );
      this.watcher.start();
    }
    await this.enqueue(() => this.pass());
  }

  stop(): void {
    this.stopped = true;
    this.watcher?.close();
    if (this.lockTimer) clearInterval(this.lockTimer);
    if (this.gitTimer) clearTimeout(this.gitTimer);
    if (this.soonTimer) clearTimeout(this.soonTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.releaseLock?.();
    this.releaseLock = undefined;
  }

  list(): Promise<TasksSnapshot> {
    return this.enqueue(() => this.lastSnapshot);
  }

  // Runs a pass now (also used by tests and after a git operation finishes).
  runPass(): Promise<void> {
    return this.enqueue(() => this.pass());
  }

  setStatus(params: SetStatusParams): Promise<{ ok: true }> {
    return this.enqueue(() => {
      if (this.readOnly) throw new Error("another VS Code window is orchestrating this repository");
      if (this.gitBusy()) throw new Error("a git operation is in progress; try again when it finishes");
      const file = this.taskPath(params.id);
      const read = readFile(file);
      if (read.status === "missing") throw new Error(`${params.id} doesn't exist`);
      if (read.status === "unusable") throw new Error(`${params.id}.md can't be used: ${read.reason}`);
      const current = read.content;
      if (current.hash !== params.expectedHash) throw new Error(`${params.id}.md changed since it was shown; try again`);
      const parsed = parseTask(current.text, params.id);
      if (!parsed.ok) throw new Error(`${params.id}.md doesn't parse; fix the problems shown for it first`);
      const task = parsed.value;
      if (task.status !== params.expectedStatus) throw new Error(`${params.id} is ${task.status}, not ${params.expectedStatus}`);
      if (!isAllowedHumanChange(task.status, params.to)) throw new Error(humanChangeRefusal(task.status, params.to));

      const updates: string[] = [];
      const baseline = this.accepted.get(task.id) ?? recordedStatus(task);
      if (baseline !== task.status) updates.push(this.handEditLine(baseline, task.status));
      updates.push(this.entry("human", `status: ${task.status} → ${params.to}`));
      let changedUnderneath = false;
      const result = this.store.update(file, (text) => {
        if (hashOf(text) !== params.expectedHash) {
          changedUnderneath = true;
          return undefined;
        }
        return editTask(text, task.statusLine, { status: params.to, updates });
      });
      if (changedUnderneath) throw new Error(`${params.id}.md changed while marking it; try again`);
      if (result.status === "failed") throw new Error(`couldn't write ${params.id}.md: ${result.reason}`);
      this.accepted.delete(task.id);
      // The change is written; a failure in the follow-up pass mustn't turn
      // it into an error for the user.
      try {
        this.pass();
      } catch (error) {
        this.options.log(`pass after setStatus failed: ${String(error)}`);
        this.schedulePassSoon();
      }
      return { ok: true as const };
    });
  }

  private get tasksDir(): string {
    return path.join(this.root, "tasks");
  }

  private taskPath(id: string): string {
    return path.join(this.tasksDir, `${id}.md`);
  }

  private enqueue<T>(job: () => T): Promise<T> {
    const run = this.queue.then(job);
    this.queue = run.catch((error: unknown) => this.options.log(`job failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`));
    return run;
  }

  private schedulePass(): void {
    if (this.passQueued || this.stopped) return;
    this.passQueued = true;
    void this.enqueue(() => {
      this.passQueued = false;
      this.pass();
    });
  }

  // Takes the lock if it can; otherwise stays read-only and keeps trying.
  // Never throws: a lock it can't even attempt (e.g. an unwritable cache
  // directory) also means read-only.
  private acquireLock(): void {
    let result: Acquired;
    try {
      result = tryAcquire(this.root);
    } catch (error) {
      this.options.log(`can't take the orchestrator lock: ${String(error)}`);
      result = { held: false };
    }
    if (result.held) {
      this.readOnly = false;
      this.releaseLock = result.release;
      this.lockStillHeld = result.stillHeld;
      if (this.lockTimer) clearInterval(this.lockTimer);
      this.lockTimer = undefined;
      const touch = result.touch;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.stopped || this.readOnly) return;
        let alive: boolean;
        try {
          alive = touch();
        } catch {
          alive = false;
        }
        if (!alive) {
          this.options.log("lost the orchestrator lock; switching to read-only");
          this.acquireLock();
        }
      }, this.options.heartbeatMs ?? HEARTBEAT_MS);
      this.heartbeat.unref();
      // Only the lock holder cleans up, or it could delete another worker's
      // in-flight temp file.
      removeLeftoverTempFiles(this.tasksDir);
      removeLeftoverTempFiles(this.root);
      return;
    }
    const wasWriting = !this.readOnly;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    this.readOnly = true;
    this.releaseLock = undefined;
    this.lockStillHeld = undefined;
    const who = result.holder ? `pid ${result.holder.pid} on ${result.holder.host}` : "another worker";
    this.options.log(`read-only: ${who} holds the orchestrator lock`);
    this.lockTimer ??= setInterval(() => {
      if (this.stopped) return;
      this.acquireLock();
      if (!this.readOnly) {
        this.options.log("acquired the orchestrator lock; no longer read-only");
        this.schedulePass();
      }
    }, this.options.lockRetryMs ?? 5_000);
    this.lockTimer.unref();
    if (wasWriting) this.schedulePass();
  }

  // Checked before every writing round: if the lock file was deleted or taken
  // over, this worker must stop writing at once.
  private stillHoldsLock(): boolean {
    if (this.readOnly) return false;
    let held: boolean;
    try {
      held = this.lockStillHeld?.() ?? false;
    } catch {
      held = false;
    }
    if (!held) {
      this.options.log("lost the orchestrator lock; switching to read-only");
      this.acquireLock();
    }
    return !this.readOnly;
  }

  // True when the checked-out commit differs from the one last recorded. The
  // first time (no record yet) it only records.
  private checkoutMoved(): boolean {
    const git = gitDir(this.root);
    const head = git ? resolveHead(git) : undefined;
    if (head === undefined) return false;
    const file = path.join(this.root, CACHE_DIR, "head");
    if (this.lastHead === undefined) {
      const saved = readFile(file);
      this.lastHead = saved.status === "ok" ? saved.content.text.trim() : head;
    }
    if (head === this.lastHead) return false;
    this.lastHead = head;
    if (!this.readOnly) {
      try {
        fs.writeFileSync(`${file}.tmp`, `${head}\n`);
        fs.renameSync(`${file}.tmp`, file);
      } catch (error) {
        this.options.log(`couldn't record the checked-out commit: ${String(error)}`);
      }
    }
    return true;
  }

  private gitBusy(): boolean {
    const git = gitDir(this.root);
    if (!git) return false;
    const busy = ["index.lock", "MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "sequencer"].find((name) =>
      fs.existsSync(path.join(git, name)),
    );
    if (!busy) {
      this.gitBusySince = undefined;
      return false;
    }
    this.gitBusySince ??= Date.now();
    if (Date.now() - this.gitBusySince > GIT_STUCK_MS) {
      this.addProblem(INDEX_FILE, {
        line: 0,
        severity: "warning",
        message: `Task updates are paused because git's ${busy} exists, as if a git command were still running. If none is, finish or abort it (or delete a stale index.lock).`,
      });
    }
    return true;
  }

  private scan(): Scan {
    const scan: Scan = { tasks: new Map(), broken: [], diagnostics: new Map() };
    const problem = (rel: string, message: string) =>
      scan.diagnostics.set(rel, [...(scan.diagnostics.get(rel) ?? []), { line: 0, severity: "error", message }]);
    for (const name of this.taskFileNames(problem)) {
      const id = TASK_FILE.exec(name)?.[1];
      if (!id) continue;
      const rel = `tasks/${name}`;
      const read = readFile(path.join(this.tasksDir, name));
      if (read.status === "missing") continue; // Deleted since readdir.
      if (read.status === "unusable") {
        scan.broken.push({ id, path: rel });
        problem(rel, `The orchestrator can't use this file: ${read.reason}.`);
        continue;
      }
      const parsed = parseTask(read.content.text, id);
      if (parsed.ok) {
        scan.tasks.set(id, { task: parsed.value, path: rel, hash: read.content.hash });
        if (parsed.warnings.length) scan.diagnostics.set(rel, [...parsed.warnings]);
      } else {
        scan.broken.push({ id, path: rel });
        scan.diagnostics.set(rel, parsed.errors);
      }
    }
    const index = readFile(path.join(this.root, INDEX_FILE));
    if (index.status === "unusable") problem(INDEX_FILE, `The orchestrator can't use this file: ${index.reason}.`);
    if (index.status === "ok") {
      const parsed = parseTasksIndex(index.content.text);
      scan.index = { text: index.content.text, ok: parsed.ok };
      const diags = parsed.ok ? parsed.warnings : parsed.errors;
      if (diags.length) scan.diagnostics.set(INDEX_FILE, [...(scan.diagnostics.get(INDEX_FILE) ?? []), ...diags]);
    }
    return scan;
  }

  // Names in tasks/, which must be a real directory: a symlinked tasks/
  // would make the worker read and write outside the repository.
  private taskFileNames(problem: (rel: string, message: string) => void): string[] {
    const stat = fs.lstatSync(this.tasksDir, { throwIfNoEntry: false });
    if (!stat) return [];
    if (!stat.isDirectory()) {
      problem(INDEX_FILE, `tasks/ is ${stat.isSymbolicLink() ? "a symbolic link" : "not a directory"}, so no task files are read. It must be a plain directory.`);
      return [];
    }
    try {
      return fs.readdirSync(this.tasksDir);
    } catch (error) {
      problem(INDEX_FILE, `The orchestrator can't list tasks/: ${String(error)}.`);
      return [];
    }
  }

  // Scans and applies changes until nothing more changes (a fixed point), at
  // most maxRounds times, then tells the extension what it found.
  private pass(): void {
    if (this.stopped) return;
    this.writeProblems.clear();
    let scan = this.scan();
    for (let round = 0; ; round++) {
      const tasks = new Map([...scan.tasks].map(([id, s]) => [id, s.task]));
      // While git is mid-operation the files may be half updated: report
      // them, but neither accept nor act on what they say.
      const busy = this.gitBusy();
      if (!busy && this.checkoutMoved()) {
        // A checkout, pull, merge or reset changed statuses without a hand
        // edit: accept them as they are instead of noting them as edits.
        for (const [id, task] of tasks) this.accepted.set(id, task.status);
      }
      // Once Updates agrees with the file again, the override isn't needed.
      for (const id of this.accepted.keys()) {
        const task = tasks.get(id);
        if (!task || recordedStatus(task) === task.status) this.accepted.delete(id);
      }
      const decisions = decide(tasks, this.accepted, new Set(scan.broken.map((b) => b.id)));
      for (const [id, diags] of decisions.diagnostics) {
        const rel = `tasks/${id}.md`;
        scan.diagnostics.set(rel, [...(scan.diagnostics.get(rel) ?? []), ...diags]);
      }

      if (!this.stillHoldsLock()) return this.publish(scan);
      if (busy) {
        this.retryAfterGit();
        return this.publish(scan);
      }
      if (round >= this.maxRounds) {
        this.options.log(`statuses still changing after ${this.maxRounds} rounds; stopping`);
        this.addProblem(INDEX_FILE, {
          line: 0,
          severity: "warning",
          message: `Task statuses kept changing for ${this.maxRounds} rounds, so the orchestrator stopped. Check for edits fighting each other.`,
        });
        return this.publish(scan);
      }

      const wrote = this.applyChanges(scan, decisions.changes) || this.writeIndex(scan);
      if (!wrote) return this.publish(scan);
      scan = this.scan();
    }
  }

  private applyChanges(scan: Scan, changes: Change[]): boolean {
    const edits = new Map<string, TaskEdit>();
    for (const change of changes) {
      const edit = edits.get(change.id) ?? { updates: [] };
      if (change.type === "hand-edit") {
        edit.updates.push(
          change.allowed
            ? this.entry("human", `status: ${change.from} → ${change.to}`)
            : this.handEditLine(change.from, change.to),
        );
        this.accepted.delete(change.id);
      } else {
        edit.status = change.to;
        edit.updates.push(this.entry("orchestrator", `status: ${change.from} → ${change.to} · ${change.reason}`));
      }
      edits.set(change.id, edit);
    }
    let wrote = false;
    for (const [id, edit] of edits) {
      const scanned = scan.tasks.get(id);
      if (!scanned) continue;
      const planned = scanned.task.status;
      const result = this.store.update(this.taskPath(id), (text) => {
        const parsed = parseTask(text, id);
        // Changed since the scan: the next round recomputes from the new state.
        if (!parsed.ok || parsed.value.status !== planned) return undefined;
        return editTask(text, parsed.value.statusLine, edit);
      });
      if (result.status === "written") wrote = true;
      else if (result.status === "failed") this.writeFailed(scanned.path, result.reason);
    }
    return wrote;
  }

  private writeIndex(scan: Scan): boolean {
    if (!scan.index?.ok) return false;
    const entries: IndexEntry[] = [
      ...[...scan.tasks.values()].map(({ task }) => ({ id: task.id, title: task.title, status: task.status })),
      ...scan.broken.map(({ id }) => ({ id })),
    ];
    const lines = indexLines(entries);
    if (replaceIndex(scan.index.text, lines) === scan.index.text) return false;
    const result = this.store.update(path.join(this.root, INDEX_FILE), (text) =>
      parseTasksIndex(text).ok ? replaceIndex(text, lines) : undefined,
    );
    if (result.status === "failed") this.writeFailed(INDEX_FILE, result.reason);
    return result.status === "written";
  }

  private writeFailed(rel: string, reason: string): void {
    this.options.log(`couldn't write ${rel}: ${reason}`);
    this.addProblem(rel, { line: 0, severity: "warning", message: `The orchestrator couldn't update this file: ${reason}. It will try again.` });
    this.schedulePassSoon();
  }

  private addProblem(rel: string, diagnostic: Diagnostic): void {
    this.writeProblems.set(rel, [...(this.writeProblems.get(rel) ?? []), diagnostic]);
  }

  private retryAfterGit(): void {
    if (this.gitTimer) return;
    this.gitTimer = setTimeout(() => {
      this.gitTimer = undefined;
      this.schedulePass();
    }, this.options.gitRetryMs ?? 1_000);
    this.gitTimer.unref();
  }

  private schedulePassSoon(): void {
    if (this.soonTimer) return;
    this.soonTimer = setTimeout(() => {
      this.soonTimer = undefined;
      this.schedulePass();
    }, 2_000);
    this.soonTimer.unref();
  }

  // Sends a snapshot only when something changed, so periodic rescans don't
  // redraw every CodeLens.
  private publish(scan: Scan): void {
    const tasks: TaskSummary[] = [...scan.tasks.values()]
      .map(({ task, path: rel, hash }) => ({
        id: task.id,
        path: rel,
        title: task.title,
        status: task.status,
        statusLine: task.statusLine,
        hash,
        allowed: allowedHumanStatuses(task.status),
      }))
      .sort((a, b) => Number(a.id.slice(2)) - Number(b.id.slice(2)));
    const diagnostics = new Map(scan.diagnostics);
    for (const [rel, extra] of this.writeProblems) diagnostics.set(rel, [...(diagnostics.get(rel) ?? []), ...extra]);
    const files = [...diagnostics].map(([p, d]) => ({ path: p, diagnostics: d }));
    const key = JSON.stringify({ readOnly: this.readOnly, tasks, files });
    if (key === this.lastPublished) return;
    this.lastPublished = key;
    this.version++;
    this.lastSnapshot = { version: this.version, readOnly: this.readOnly, tasks };
    this.options.notify({ method: "tasks/changed", params: this.lastSnapshot });
    this.options.notify({ method: "tasks/diagnostics", params: { version: this.version, files } });
  }

  private handEditLine(from: Status, to: Status): string {
    if (isAllowedHumanChange(from, to)) return this.entry("human", `status: ${from} → ${to}`);
    return this.entry("orchestrator", `status: ${from} → ${to} · edited by hand, but ${humanChangeRefusal(from, to)}; left as is`);
  }

  private entry(who: string, text: string): string {
    const d = this.now();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `* ${stamp} · ${who} · ${text}`;
  }
}
