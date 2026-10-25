// Decides which tasks run (D-074, D-075): ready tasks in id order, at most
// `limit` at once, never the same task twice. Tasks found in-implementation
// with nothing running (after a restart) are resumed first. The caller leaves
// out parked tasks.
import type { Task } from "../tasks/model";
import { taskNumber } from "../tasks/index";

export class Scheduler {
  private readonly running = new Map<string, { abort: AbortController; done: Promise<void> }>();
  private stopped = false;

  constructor(
    private readonly start: (taskId: string, abort: AbortController) => Promise<void>,
    private limit: number,
    private readonly log: (line: string) => void,
    private readonly onIdle: () => void = () => {},
  ) {}

  get runningIds(): string[] {
    return [...this.running.keys()];
  }

  setLimit(limit: number): void {
    this.limit = Math.max(1, Math.floor(limit));
  }

  consider(tasks: Iterable<Task>): void {
    if (this.stopped) return;
    const candidates = [...tasks]
      .filter((t) => (t.status === "ready" || t.status === "in-implementation") && !this.running.has(t.id))
      .sort((a, b) => Number(b.status === "in-implementation") - Number(a.status === "in-implementation") || taskNumber(a.id) - taskNumber(b.id));
    for (const task of candidates) {
      if (this.running.size >= this.limit) break;
      this.launch(task.id);
    }
  }

  stopAll(): void {
    this.stopped = true;
    for (const { abort } of this.running.values()) abort.abort("stopped");
  }

  // Stops every running task without stopping the scheduler.
  abortAll(reason: string): void {
    for (const { abort } of this.running.values()) abort.abort(reason);
  }

  // Stops one running task, e.g. because the human changed its status.
  abort(taskId: string, reason: string): void {
    this.running.get(taskId)?.abort.abort(reason);
  }

  // Resolves once every running task has finished (its cleanup included).
  async idle(): Promise<void> {
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  private launch(taskId: string): void {
    const abort = new AbortController();
    this.log(`starting ${taskId}`);
    const done = this.start(taskId, abort)
      .catch((error: unknown) => this.log(`${taskId} failed unexpectedly: ${String(error)}`))
      .finally(() => {
        this.running.delete(taskId);
        this.onIdle();
      });
    this.running.set(taskId, { abort, done });
  }
}
