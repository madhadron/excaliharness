// Running docker and git from the worker, without a shell. Docker commands
// always go to the daemon the worker's API client uses: DOCKER_HOST is set to
// that socket, and contexts and buildx builders, which could point elsewhere,
// are cleared (as for the base image build, D-052).
import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  // Output beyond MAX_CAPTURE was dropped.
  truncated?: boolean;
  // Stopped because it ran over its time limit.
  timedOut?: boolean;
}

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  // Each output line as it arrives, for progress and logs.
  onLine?: (line: string) => void;
  // Stops the command: SIGINT, then SIGKILL after a grace period.
  signal?: AbortSignal;
}

export type Run = (command: string, args: string[], options?: RunOptions) => Promise<RunResult>;

const MAX_CAPTURE = 4 * 1024 * 1024;
const MAX_LINE = 64 * 1024;
export const KILL_GRACE_MS = 10_000;

export const run: Run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error(`${command} was cancelled`));
      return;
    }
    // In its own process group, so stopping it also stops what it started
    // (docker's Compose plugin), which could otherwise hold the pipes open.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;
    const signal = (sig: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, sig);
      } catch {
        // Already gone.
      }
    };
    const stop = () => {
      if (killTimer) return;
      signal("SIGINT");
      killTimer = setTimeout(() => {
        signal("SIGKILL");
        // Something outside the group still holds the pipes: stop waiting.
        giveUpTimer = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(child.exitCode);
        }, 2_000);
        giveUpTimer.unref();
      }, KILL_GRACE_MS);
      killTimer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs ?? 30 * 60_000);
    timer.unref();
    options.signal?.addEventListener("abort", stop, { once: true });
    const partials: string[] = [];
    const take = (which: "out" | "err") => {
      const index = partials.push("") - 1;
      return (text: string) => {
        const current = which === "out" ? stdout : stderr;
        if (current.length + text.length > MAX_CAPTURE) truncated = true;
        if (current.length < MAX_CAPTURE) {
          const kept = text.slice(0, MAX_CAPTURE - current.length);
          if (which === "out") stdout += kept;
          else stderr += kept;
        }
        if (!options.onLine) return;
        const parts = ((partials[index] ?? "") + text).split(/\r?\n/);
        partials[index] = (parts.pop() ?? "").slice(-MAX_LINE);
        for (const line of parts) options.onLine(line.slice(0, MAX_LINE));
      };
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    const done = () => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (giveUpTimer) clearTimeout(giveUpTimer);
      options.signal?.removeEventListener("abort", stop);
    };
    function finish(code: number | null): void {
      if (settled) return;
      settled = true;
      done();
      for (const line of partials) if (line && options.onLine) options.onLine(line);
      resolve({ code, stdout, stderr, ...(truncated ? { truncated } : {}), ...(timedOut ? { timedOut } : {}) });
    }
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      done();
      reject(error);
    });
    child.on("close", (code) => finish(code));
  });

// The only parts of the worker's environment Compose and docker get, so
// nothing else from the host can be interpolated into a container (D-079).
// DOCKER_CONFIG and TMPDIR only say where the CLI finds its plugins and
// scratch space.
const PASSED = ["PATH", "HOME", "DOCKER_CONFIG", "TMPDIR"];

export function dockerEnv(socket: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of PASSED) if (process.env[key] !== undefined) env[key] = process.env[key];
  return { ...env, ...extra, DOCKER_HOST: `unix://${socket}` };
}

// The last few lines of a failed command's output, for an error message.
export function tail(result: RunResult, lines = 8): string {
  const text = `${result.stderr}\n${result.stdout}`.trim().split("\n").slice(-lines).join("\n");
  return result.timedOut ? `(timed out)\n${text}` : text;
}
