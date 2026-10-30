// Prepares a task's review (D-027): which files its branch changed, and the
// versions they had where the branch started, for the diff editor. Git reads
// commits in the main repository only, never the worktree; the base is the
// human's own commit (where the branch left the main checkout's branch).
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewInfo } from "./protocol";
import { removeQuietly, type Worktrees } from "./runner/worktree";

const TASK_DIR = /^T-\d+$/;
// Copies a diff may still show; older ones of the same task are removed.
const KEEP_MS = 24 * 60 * 60_000;

export class Reviews {
  // One preparation or removal per task at a time.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly worktrees: Worktrees,
    // Where the base copies go: the extension's storage, outside the repository.
    private readonly dir: string,
    private readonly log?: (line: string) => void,
  ) {}

  prepare(id: string): Promise<ReviewInfo> {
    return this.queued(id, () => this.prepareNow(id));
  }

  // Removes the base copies of tasks not in `keep` (no longer to review).
  sweep(keep: ReadonlySet<string>): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (TASK_DIR.test(name) && !keep.has(name)) void this.queued(name, () => removeQuietly(path.join(this.dir, name), this.log));
    }
  }

  private queued<T>(id: string, job: () => T | Promise<T>): Promise<T> {
    const run = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(job);
    this.queues.set(id, run);
    void run.catch(() => undefined).then(() => {
      if (this.queues.get(id) === run) this.queues.delete(id);
    });
    return run;
  }

  private async prepareNow(id: string): Promise<ReviewInfo> {
    const worktree = this.worktrees.path(id);
    if (!fs.existsSync(worktree)) throw new Error(`${id} has no worktree yet, so there is nothing to review`);
    const { base, files, truncated } = await this.worktrees.changedFiles(id);
    const old = files.filter((f) => f.change !== "added").map((f) => f.path);
    // Named for what it holds, so copies a diff already shows are never
    // rewritten: the same files again reuse the folder, others get their own.
    // Each is made in a folder of its own and renamed into place whole, so
    // another worker (a second window) never sees one half made.
    const taskDir = path.join(this.dir, id);
    const baseDir = path.join(taskDir, createHash("sha256").update([base, ...old].join("\0")).digest("hex").slice(0, 16));
    if (fs.existsSync(baseDir)) {
      const now = new Date();
      fs.utimesSync(baseDir, now, now);
    } else {
      const temp = path.join(taskDir, `.tmp-${randomBytes(6).toString("hex")}`);
      try {
        await this.worktrees.exportFiles(base, old, temp);
        try {
          fs.renameSync(temp, baseDir);
        } catch (error) {
          // Another worker made the same copies first.
          if (!fs.existsSync(baseDir)) throw error;
        }
      } finally {
        removeQuietly(temp, this.log);
      }
    }
    this.removeOld(taskDir, baseDir);
    return { id, worktree, baseDir, base, files, truncated };
  }

  // Copies from earlier preparations, and folders a crashed one left.
  private removeOld(taskDir: string, current: string): void {
    for (const name of fs.readdirSync(taskDir)) {
      const dir = path.join(taskDir, name);
      if (dir === current) continue;
      const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
      if (stat && Date.now() - stat.mtimeMs > KEEP_MS) removeQuietly(dir, this.log);
    }
  }
}
