// Prepares a task's review (D-027): which files its branch changed, and the
// versions they had where the branch started, for the diff editor. Git reads
// commits in the main repository only, never the worktree; the base is the
// human's own commit (where the branch left the main checkout's branch).
import * as fs from "node:fs";
import * as path from "node:path";
import type { ReviewInfo } from "./protocol";
import type { Worktrees } from "./runner/worktree";

export class Reviews {
  // One preparation per task at a time, since each replaces the task's copies.
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly worktrees: Worktrees,
    // Where the base copies go: the extension's storage, outside the repository.
    private readonly dir: string,
  ) {}

  prepare(id: string): Promise<ReviewInfo> {
    const run = (this.queues.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => this.prepareNow(id));
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
    const baseDir = path.join(this.dir, id);
    await this.worktrees.exportFiles(
      base,
      files.filter((f) => f.change !== "added").map((f) => f.path),
      baseDir,
    );
    return { id, worktree, baseDir, base, files, truncated };
  }
}
