// Watches task files (D-036 as amended). Watching a file follows its inode and
// goes deaf after an atomic rename, so this watches directories instead: the
// repo root for TASKS.md and tasks/ itself, and tasks/ for task files. Events
// are only hints; every one triggers a full rescan, and a periodic rescan
// catches events the platform dropped.
import * as fs from "node:fs";
import * as path from "node:path";
import { TEMP_PREFIX } from "./store";

export interface WatchOptions {
  debounceMs?: number;
  maxWaitMs?: number;
  rescanMs?: number;
  rearmMs?: number;
}

export interface WatchEvents {
  // Something under the task files may have changed.
  onChange: () => void;
  onError: (message: string) => void;
}

export class TaskWatcher {
  private readonly watchers = new Map<string, fs.FSWatcher>();
  private debounce: NodeJS.Timeout | undefined;
  private firstPending: number | undefined;
  private readonly timers: NodeJS.Timeout[] = [];
  private readonly rearms = new Set<NodeJS.Timeout>();
  private closed = false;
  private readonly debounceMs: number;
  private readonly maxWaitMs: number;
  private readonly rescanMs: number;
  private readonly rearmMs: number;

  constructor(
    private readonly root: string,
    private readonly events: WatchEvents,
    options: WatchOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 500;
    this.maxWaitMs = options.maxWaitMs ?? 2_000;
    this.rescanMs = options.rescanMs ?? 30_000;
    this.rearmMs = options.rearmMs ?? 1_000;
  }

  start(): void {
    this.arm("root", this.root, (name) => {
      if (name === null || name === "TASKS.md") this.changed();
      if (name === null || name === "tasks") {
        this.arm("tasks", path.join(this.root, "tasks"), (n) => this.taskEvent(n));
        this.changed();
      }
    });
    this.arm("tasks", path.join(this.root, "tasks"), (n) => this.taskEvent(n));
    const rescan = setInterval(() => this.changed(), this.rescanMs);
    rescan.unref();
    this.timers.push(rescan);
  }

  close(): void {
    this.closed = true;
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
    for (const t of [...this.timers, ...this.rearms, this.debounce]) if (t) clearTimeout(t);
  }

  private taskEvent(name: string | null): void {
    if (name !== null && name.startsWith(TEMP_PREFIX)) return;
    this.changed();
  }

  // (Re)starts the watcher for one directory. A missing directory (tasks/ not
  // created yet) is fine: the root watcher re-arms it when it appears.
  private arm(key: string, dir: string, onEvent: (name: string | null) => void): void {
    if (this.closed) return;
    this.watchers.get(key)?.close();
    this.watchers.delete(key);
    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(dir, { persistent: false }, (_event, name) => onEvent(name === null ? null : String(name)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.events.onError(`can't watch ${dir}: ${String(error)}`);
      return;
    }
    watcher.on("error", (error) => {
      watcher.close();
      if (this.watchers.get(key) === watcher) this.watchers.delete(key);
      this.events.onError(`watching ${dir} failed (${error.message}); re-arming`);
      const t = setTimeout(() => {
        this.rearms.delete(t);
        this.arm(key, dir, onEvent);
        this.changed();
      }, this.rearmMs);
      t.unref();
      this.rearms.add(t);
    });
    this.watchers.set(key, watcher);
  }

  // Debounced, with a maximum wait so a stream of autosaves can't postpone
  // the rescan forever.
  private changed(): void {
    if (this.closed) return;
    const now = Date.now();
    this.firstPending ??= now;
    if (this.debounce) clearTimeout(this.debounce);
    const wait = Math.max(0, Math.min(this.debounceMs, this.firstPending + this.maxWaitMs - now));
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.firstPending = undefined;
      this.events.onChange();
    }, wait);
  }

}
