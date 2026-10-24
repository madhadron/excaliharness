// Extension-side handle on the orchestrator worker process (D-021).
import { fork, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import { isResponse, type Method, type Response } from "./worker/protocol";

interface Pending {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export const DEFAULT_TIMEOUT_MS = 5_000;

export class WorkerClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stopped = false;
  private readonly log: (line: string) => void;

  constructor(workerPath: string, log: (line: string) => void) {
    // Logging stops once disposed, so late process events never reach a
    // disposed output channel.
    this.log = (line) => {
      if (!this.stopped) log(line);
    };
    this.child = fork(workerPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      // Don't inherit the extension host's --inspect flags when debugging.
      execArgv: [],
    });
    this.logLines(this.child.stdout, "[worker]");
    this.logLines(this.child.stderr, "[worker:err]");
    this.child.on("message", (message: unknown) => {
      if (isResponse(message)) this.settle(message);
      else this.log(`[worker] ignored malformed message: ${JSON.stringify(message)}`);
    });
    this.child.on("error", (error) => {
      this.log(`[worker] process error: ${error.message}`);
      // A failed spawn emits "error" but never "exit".
      if (this.child.pid === undefined) this.markStopped(new Error(`worker failed to start: ${error.message}`));
    });
    this.child.on("exit", (code, signal) => {
      this.log(`[worker] exited (code ${code ?? "none"}, signal ${signal ?? "none"})`);
      this.markStopped(new Error("worker exited"));
    });
  }

  request(method: Method, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.stopped || !this.child.connected) {
      return Promise.reject(new Error("worker is not running"));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`worker did not answer ${method} within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.send({ id, method }, (error) => {
          if (error) this.settle({ id, error: error.message });
        });
      } catch (error) {
        this.settle({ id, error: error instanceof Error ? error.message : String(error) });
      }
    });
  }

  dispose(): void {
    const running = !this.stopped;
    this.markStopped(new Error("worker stopped"));
    if (running) this.child.kill();
  }

  private logLines(stream: Readable | null, prefix: string): void {
    if (!stream) return;
    createInterface({ input: stream }).on("line", (line) => this.log(`${prefix} ${line}`));
  }

  private settle(message: Response): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if ("error" in message) entry.reject(new Error(message.error));
    else entry.resolve(message.result);
  }

  private markStopped(error: Error): void {
    this.stopped = true;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}
