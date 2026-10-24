// Runs `claude setup-token` in a hardened container and relays the sign-in to
// the human (D-022, D-024, D-049 to D-056). Behaviours handled here come from
// experiment E-001: input sent too early is dropped, a wrong code leaves the
// CLI waiting for Enter, and with no code it waits forever.
//
// The CLI's output contains the token, so it is never logged; only events are.
import type { Duplex } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import type { BaseImage } from "./agentImage";
import type { DockerClient } from "./docker";
import type { Notification } from "./protocol";

export type SignInErrorCode = "timeout" | "cancelled" | "ended" | "token-rejected";

export class SignInError extends Error {
  constructor(
    readonly code: SignInErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SignInError";
  }
}

export interface Terminal {
  onData(listener: (chunk: string) => void): void;
  onEnd(listener: () => void): void;
  write(text: string): void;
  close(): void;
}

const PROMPT = "Paste code here";
// The CLI's answer to a code it couldn't use: "OAuth error: Invalid code…"
// for a malformed one, "OAuth error: Request failed with status code 400"
// when the server rejects it (E-004). Both end with "Press Enter to retry".
const REJECTED = "OAuth error";
// Followed by whitespace, so a token split across output chunks isn't taken
// half-received.
const TOKEN = /sk-ant-oat01-[A-Za-z0-9_-]+(?=\s)/;
// Also complete only once something follows it.
const URL_PATTERN = /https:\/\/\S+(?=\s)/;
// The sign-in page itself, not anything else on those sites.
const ALLOWED_HOSTS = ["claude.com", "claude.ai"];
// Characters a sign-in code is made of ("code#state", base64url and friends).
const CODE = /^[A-Za-z0-9#._~+/=-]{1,2000}$/;
const MAX_OUTPUT_CHARS = 1024 * 1024;

// The CLI lays words out with cursor movements, not spaces (E-001). Terminal
// escape sequences are control characters by definition.
/* eslint-disable no-control-regex */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\[(\d*)C/g, (_m, n: string) => " ".repeat(Number(n || 1)))
    .replace(/\x1b\[\d*G/g, " ")
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n?/g, "\n");
}
/* eslint-enable no-control-regex */

// Only sign-in pages on Claude's own sites are offered to the human.
export function signInUrl(text: string): string | undefined {
  const candidate = URL_PATTERN.exec(text)?.[0];
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    const allowed = url.protocol === "https:" && url.username === "" && ALLOWED_HOSTS.includes(url.hostname) && url.pathname.endsWith("/oauth/authorize");
    return allowed ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

// How long to wait for the CLI to answer a code, and to show a fresh prompt
// after Enter. Below the extension's 60 s submit timeout.
const ANSWER_TIMEOUT_MS = 40_000;

export type SubmitOutcome = "accepted" | "invalid" | "no-response";

export interface SessionOptions {
  onUrl: (url: string) => void;
  log: (line: string) => void;
  deadlineMs?: number;
  // How long the output must be quiet before typing (E-001).
  quietMs?: number;
  pollMs?: number;
  answerTimeoutMs?: number;
}

// One sign-in conversation with the CLI. `result` settles once: with the
// token, or with a SignInError.
export class SignInSession {
  readonly result: Promise<string>;
  private resolve!: (token: string) => void;
  private reject!: (error: SignInError) => void;
  private raw = "";
  private text = "";
  private lastData = Date.now();
  private url: string | undefined;
  private token: string | undefined;
  private failure: SignInError | undefined;
  private submitting = false;
  private readonly waiters = new Set<() => void>();
  private readonly deadline: NodeJS.Timeout;
  private readonly ticker: NodeJS.Timeout;
  private readonly quietMs: number;
  private readonly answerTimeoutMs: number;

  constructor(
    private readonly terminal: Terminal,
    private readonly options: SessionOptions,
  ) {
    this.quietMs = options.quietMs ?? 1_500;
    this.answerTimeoutMs = options.answerTimeoutMs ?? ANSWER_TIMEOUT_MS;
    this.result = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
    // Nothing else may observe a rejection; don't let it go unhandled.
    this.result.catch(() => {});
    terminal.onData((chunk) => this.received(chunk));
    terminal.onEnd(() => this.fail(new SignInError("ended", "the sign-in ended before a token was shown")));
    this.deadline = setTimeout(() => this.fail(new SignInError("timeout", "sign-in timed out")), options.deadlineMs ?? 10 * 60_000);
    this.ticker = setInterval(() => this.wake(), options.pollMs ?? 100);
  }

  // Types the code once the prompt is showing and the output has gone quiet.
  // "invalid": the CLI rejected it and is showing a fresh prompt.
  // "no-response": it said nothing either way in time; the session goes on.
  async submit(code: string): Promise<SubmitOutcome> {
    const trimmed = code.trim();
    // Anything else, including control and escape characters, could be
    // interpreted by the CLI's terminal rather than read as the code.
    if (!CODE.test(trimmed)) {
      throw new Error("that doesn't look like a sign-in code");
    }
    if (this.submitting) throw new Error("a code is already being checked");
    this.submitting = true;
    try {
      await this.until(() => count(this.text, PROMPT) > 0 && this.quiet());
      // Text is re-stripped on each chunk, so allow for an escape sequence
      // split across chunks shifting it slightly.
      const from = Math.max(0, this.text.length - 32);
      // The code and Enter go separately: arriving together, a long code is
      // taken as a paste and the Enter inside it never submits (E-004). So
      // wait for the CLI to echo the code (masked as *), then for quiet, and
      // only then press Enter. Without waiting for the echo, the output is
      // still quiet from before and Enter would follow at once.
      const echoFrom = this.raw.length;
      this.terminal.write(trimmed);
      const echoed = await this.until(() => this.raw.length > echoFrom, this.answerTimeoutMs);
      if (!echoed) this.options.log("sign-in: no echo of the code; pressing Enter anyway");
      await this.until(() => this.quiet());
      this.terminal.write("\r");
      this.options.log("sign-in: code sent");
      const answered = await this.until(() => this.token !== undefined || this.text.slice(from).includes(REJECTED), this.answerTimeoutMs);
      if (this.token !== undefined) return "accepted";
      if (!answered) {
        this.options.log("sign-in: no answer to the code");
        return "no-response";
      }
      this.options.log("sign-in: code rejected; asking for another");
      await this.until(() => this.quiet());
      const prompts = count(this.text, PROMPT);
      this.terminal.write("\r");
      // If the CLI redraws without a new prompt, carry on once it's quiet.
      await this.until(() => count(this.text, PROMPT) > prompts && this.quiet(), this.answerTimeoutMs);
      return "invalid";
    } finally {
      this.submitting = false;
    }
  }

  cancel(): void {
    this.fail(new SignInError("cancelled", "sign-in was cancelled"));
  }

  private received(chunk: string): void {
    if (this.failure || this.token) return;
    this.raw += chunk;
    if (this.raw.length > MAX_OUTPUT_CHARS) {
      this.fail(new SignInError("ended", "the sign-in produced far more output than expected"));
      return;
    }
    this.text = stripAnsi(this.raw);
    this.lastData = Date.now();
    if (!this.url) {
      const url = signInUrl(this.text);
      if (url) {
        this.url = url;
        this.options.log("sign-in: page URL shown");
        this.options.onUrl(url);
      }
    }
    const token = TOKEN.exec(this.text)?.[0];
    if (token) {
      this.token = token;
      this.options.log("sign-in: token received");
      this.settle();
      this.resolve(token);
    }
    this.wake();
  }

  private quiet(): boolean {
    return Date.now() - this.lastData >= this.quietMs;
  }

  // Resolves true when `condition` holds, or false after `timeoutMs`;
  // rejects if the session fails first.
  private until(condition: () => boolean, timeoutMs?: number): Promise<boolean> {
    const deadline = timeoutMs === undefined ? Infinity : Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const check = () => {
        if (condition()) {
          this.waiters.delete(check);
          resolve(true);
        } else if (this.failure) {
          this.waiters.delete(check);
          reject(this.failure);
        } else if (Date.now() >= deadline) {
          this.waiters.delete(check);
          resolve(false);
        }
      };
      this.waiters.add(check);
      check();
    });
  }

  private wake(): void {
    for (const check of [...this.waiters]) check();
  }

  private fail(error: SignInError): void {
    if (this.failure || this.token) return;
    this.failure = error;
    this.options.log(`sign-in: ${error.message}`);
    this.settle();
    this.reject(error);
    this.wake();
  }

  private settle(): void {
    clearTimeout(this.deadline);
    clearInterval(this.ticker);
    this.terminal.close();
  }
}

// Adapts an attached container stream to a Terminal.
export function streamTerminal(stream: Duplex, head: Buffer): Terminal {
  const decoder = new StringDecoder("utf8");
  const pending = head.length ? [decoder.write(head)] : [];
  let ended = false;
  return {
    onData: (listener) => {
      for (const chunk of pending.splice(0)) listener(chunk);
      stream.on("data", (chunk: Buffer) => listener(decoder.write(chunk)));
    },
    onEnd: (listener) => {
      const once = () => {
        if (ended) return;
        ended = true;
        listener();
      };
      stream.on("end", once);
      stream.on("close", once);
      stream.on("error", once);
    },
    write: (text) => {
      if (!stream.destroyed) stream.write(text);
    },
    close: () => stream.destroy(),
  };
}

export interface SignInDeps {
  docker: DockerClient;
  image: BaseImage;
  notify: (notification: Notification) => void;
  log: (line: string) => void;
  deadlineMs?: number;
  quietMs?: number;
  checkTimeoutMs?: number;
}

// One sign-in at a time. Each attempt has a number that the prompt carries
// and that submit and cancel must quote, so UI left over from an earlier
// attempt can't act on a newer one.
export class SignInService {
  private current: SignInSession | undefined;
  private attempt = 0;
  private running = false;
  private cancelAttempt: ((error: SignInError) => void) | undefined;
  // Containers this service created and hasn't removed yet.
  private readonly live = new Set<string>();

  constructor(private readonly deps: SignInDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  async signIn(): Promise<{ token: string }> {
    if (this.running) throw new Error("a sign-in is already in progress");
    this.running = true;
    const attempt = ++this.attempt;
    const { docker, notify } = this.deps;
    const progress = (message: string) => notify({ method: "progress", params: { message } });
    // Every step races this, so cancel works during the build or the token
    // check too, not only at the prompt.
    const cancelled = new Promise<never>((_resolve, reject) => {
      this.cancelAttempt = reject;
    });
    cancelled.catch(() => {});
    const step = <T>(work: Promise<T>): Promise<T> => Promise.race([work, cancelled]);
    try {
      await step(docker.ping());
      await step(removeLeftovers(docker, this.deps.log));
      progress("Preparing the agent image…");
      // A build that loses the race keeps going and is reused next time.
      const image = await step(this.deps.image.ensure(() => progress("Building the agent image (first time only)…")));
      const token = await step(this.runSetupToken(image, attempt, progress));
      progress("Checking the token…");
      await step(checkToken(docker, image, token, this.deps.log, this.track, this.deps.checkTimeoutMs));
      return { token };
    } finally {
      this.cancelAttempt = undefined;
      this.running = false;
    }
  }

  // `attempt` must be the one the prompt named.
  submitCode(attempt: number, code: string): Promise<SubmitOutcome> {
    if (!this.current || attempt !== this.attempt) return Promise.reject(new Error("no sign-in is in progress"));
    return this.current.submit(code);
  }

  // Without an attempt, cancels whatever is running (the progress
  // notification's Cancel button); with one, only that attempt.
  cancel(attempt?: number): void {
    if (attempt !== undefined && attempt !== this.attempt) return;
    const error = new SignInError("cancelled", "sign-in was cancelled");
    this.current?.cancel();
    this.cancelAttempt?.(error);
  }

  // Called when the worker exits: removes this service's containers, waiting
  // at most `capMs` so shutdown can't hang.
  async shutdown(capMs = 3_000): Promise<void> {
    this.cancel();
    const removals = [...this.live].map((id) => this.deps.docker.remove(id).catch(() => undefined));
    await Promise.race([Promise.all(removals), new Promise((r) => setTimeout(r, capMs))]);
  }

  private readonly track = {
    add: (id: string) => this.live.add(id),
    remove: async (id: string) => {
      try {
        await this.deps.docker.remove(id);
      } catch (error) {
        this.deps.log(`couldn't remove a container: ${String(error)}`);
      } finally {
        this.live.delete(id);
      }
    },
  };

  private async runSetupToken(image: string, attempt: number, progress: (message: string) => void): Promise<string> {
    const { docker, notify, log } = this.deps;
    const id = await docker.createContainer({
      image,
      // The CLI waits forever without a code (E-001); this ends it even if
      // the worker is gone, and AutoRemove then removes the container.
      // --foreground keeps the CLI in the terminal's foreground process
      // group; without it, it can print the prompt but never read the code.
      cmd: ["timeout", "--foreground", String(Math.ceil((this.deps.deadlineMs ?? 10 * 60_000) / 1000) + 60), "claude", "setup-token"],
      tty: true,
      role: "sign-in",
      // Its output contains the token, so the daemon keeps no log of it.
      noLogs: true,
      autoRemove: true,
    });
    this.track.add(id);
    try {
      const { stream, head } = await docker.attach(id);
      const options: SessionOptions = {
        log,
        onUrl: (url) => {
          progress("Waiting for you to sign in…");
          notify({ method: "auth/prompt", params: { url, attempt } });
        },
      };
      if (this.deps.deadlineMs !== undefined) options.deadlineMs = this.deps.deadlineMs;
      if (this.deps.quietMs !== undefined) options.quietMs = this.deps.quietMs;
      const session = new SignInSession(streamTerminal(stream, head), options);
      this.current = session;
      try {
        await docker.start(id);
        await docker.resize(id).catch(() => undefined);
        return await session.result;
      } finally {
        session.cancel(); // No-op once settled; stops a session left waiting.
        this.current = undefined;
      }
    } finally {
      await this.track.remove(id);
    }
  }
}

// Containers a crashed worker left behind may hold the token (the check
// container's environment), so they're removed before anything else.
export async function removeLeftovers(docker: DockerClient, log: (line: string) => void): Promise<void> {
  for (const role of ["sign-in", "token-check"]) {
    for (const id of await docker.containersWithRole(role)) {
      log(`removing a leftover ${role} container`);
      await docker.remove(id);
    }
  }
}

// D-053: one real request with only the token, in a fresh hardened container.
export interface ContainerTracker {
  add: (id: string) => void;
  remove: (id: string) => Promise<void>;
}

export async function checkToken(
  docker: DockerClient,
  image: string,
  token: string,
  log: (line: string) => void,
  tracker: ContainerTracker,
  timeoutMs = 120_000,
): Promise<void> {
  const id = await docker.createContainer({
    image,
    cmd: ["timeout", String(Math.ceil(timeoutMs / 1000) + 30), "claude", "-p", "Reply with exactly: ok"],
    env: [`CLAUDE_CODE_OAUTH_TOKEN=${token}`],
    tty: false,
    role: "token-check",
  });
  tracker.add(id);
  try {
    await docker.start(id);
    let timer: NodeJS.Timeout | undefined;
    const code = await Promise.race([
      docker.wait(id),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timer));
    const output = code === "timeout" ? "" : await docker.logs(id);
    if (code !== 0 || !/\bok\b/i.test(output)) {
      const detail = code === "timeout" ? "it timed out" : output.replaceAll(token, "[token]").trim().split("\n").at(-1) || `exit ${code}`;
      log(`token check failed: ${detail}`);
      throw new SignInError("token-rejected", `the new token didn't work (${detail})`);
    }
    log("token check passed");
  } finally {
    await tracker.remove(id);
  }
}
