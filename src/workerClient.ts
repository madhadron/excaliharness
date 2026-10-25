// Extension-side handle on the orchestrator worker process (D-021). Restarts
// the worker after a crash with a growing delay, and gives up after too many
// crashes in a short time (D-046).
import { fork, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import {
  isNotification,
  isResponse,
  type Method,
  type MethodParams,
  type Notification,
  type NotificationMethod,
  type Response,
} from "./worker/protocol";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_TIMEOUT_MS = 5_000;

const redact = (text: string) => text.replace(/sk-ant-[A-Za-z0-9_-]+/g, "[token]");

// An error the worker reported, with its code when it gave one.
export class WorkerError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export interface RestartPolicy {
  baseDelayMs: number;
  maxDelayMs: number;
  crashLimit: number;
  windowMs: number;
}

export const DEFAULT_RESTART: RestartPolicy = { baseDelayMs: 1_000, maxDelayMs: 30_000, crashLimit: 5, windowMs: 5 * 60_000 };

export interface WorkerClientOptions {
  workerPath: string;
  root: string;
  // The base agent image's Dockerfile, shipped in the extension (D-029).
  dockerfile: string;
  // Per-workspace storage for the worker's generated files (D-059).
  stateDir: string;
  // The parallel-task limit to start each worker with.
  maxParallelTasks?: () => number;
  // Called each time a worker process starts, to send it what it needs.
  onSpawn?: () => void;
  log: (line: string) => void;
  onNotification: (notification: Notification) => void;
  // The worker exited; anything derived from it (diagnostics) is now stale.
  onExit?: () => void;
  // Too many crashes; the worker won't be restarted until restart() is called.
  onGiveUp?: () => void;
  restart?: RestartPolicy;
}

export class WorkerClient {
  private child: ChildProcess | undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;
  private crashes: number[] = [];
  private restartTimer: NodeJS.Timeout | undefined;
  // Highest snapshot version seen from the current process, per notification.
  private versions = new Map<NotificationMethod, number>();
  private readonly policy: RestartPolicy;

  constructor(private readonly options: WorkerClientOptions) {
    this.policy = options.restart ?? DEFAULT_RESTART;
    this.spawn();
  }

  request<M extends Method>(
    method: M,
    ...[params, timeoutMs = DEFAULT_TIMEOUT_MS]: MethodParams[M] extends undefined ? [params?: undefined, timeoutMs?: number] : [params: MethodParams[M], timeoutMs?: number]
  ): Promise<unknown> {
    const child = this.child;
    if (this.disposed || !child?.connected) return Promise.reject(new Error("the worker is not running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`the worker did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.send({ id, method, params }, (error) => {
          if (error) this.settle({ id, error: error.message });
        });
      } catch (error) {
        this.settle({ id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  // Starts the worker again after onGiveUp, or if it isn't running.
  restart(): void {
    if (this.disposed) return;
    this.crashes = [];
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    if (!this.child) this.spawn();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.failAll(new Error("the worker was stopped"));
    this.child?.kill();
    this.child = undefined;
  }

  private log(line: string): void {
    if (!this.disposed) this.options.log(line);
  }

  private spawn(): void {
    this.versions = new Map();
    const limit = this.options.maxParallelTasks?.();
    const args = [this.options.root, this.options.dockerfile, this.options.stateDir, ...(limit === undefined ? [] : [String(limit)])];
    const child = fork(this.options.workerPath, args, {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Don't inherit the extension host's --inspect flags when debugging.
      execArgv: [],
    });
    this.child = child;
    // Events from a previous process are ignored once a new one has started.
    const current = () => this.child === child && !this.disposed;
    this.logLines(child.stdout, "[worker]", current);
    this.logLines(child.stderr, "[worker:err]", current);
    child.on("message", (message: unknown) => {
      if (!current()) return;
      if (isResponse(message)) this.settle(message);
      else if (isNotification(message)) this.notify(message);
      else this.log(`[worker] ignored malformed message: ${redact(JSON.stringify(message) ?? String(message)).slice(0, 200)}`);
    });
    child.on("error", (error) => {
      if (!current()) return;
      this.log(`[worker] process error: ${error.message}`);
      // A failed spawn emits "error" but never "exit".
      if (child.pid === undefined) this.exited(`failed to start: ${error.message}`);
    });
    child.once("spawn", () => {
      if (current()) this.options.onSpawn?.();
    });
    child.on("exit", (code, signal) => {
      if (!current()) return;
      this.exited(`exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
    });
  }

  private notify(notification: Notification): void {
    if ("version" in notification.params) {
      const last = this.versions.get(notification.method) ?? 0;
      if (notification.params.version <= last) return; // Older than what we have.
      this.versions.set(notification.method, notification.params.version);
    }
    this.options.onNotification(notification);
  }

  private exited(why: string): void {
    this.log(`[worker] ${why}`);
    this.child = undefined;
    this.failAll(new Error(`the worker ${why}`));
    this.options.onExit?.();
    if (this.disposed) return;
    const now = Date.now();
    this.crashes = [...this.crashes.filter((t) => now - t < this.policy.windowMs), now];
    if (this.crashes.length >= this.policy.crashLimit) {
      this.log(`[worker] crashed ${this.crashes.length} times in ${Math.round(this.policy.windowMs / 60_000)} minutes; not restarting`);
      this.options.onGiveUp?.();
      return;
    }
    const delay = Math.min(this.policy.maxDelayMs, this.policy.baseDelayMs * 2 ** (this.crashes.length - 1));
    this.log(`[worker] restarting in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.disposed && !this.child) this.spawn();
    }, delay);
  }

  private logLines(stream: Readable | null, prefix: string, current: () => boolean): void {
    if (!stream) return;
    createInterface({ input: stream }).on("line", (line) => {
      if (current()) this.log(`${prefix} ${line}`);
    });
  }

  private settle(message: Response): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if ("error" in message) entry.reject(new WorkerError(message.error, message.code));
    else entry.resolve(message.result);
  }

  private failAll(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
