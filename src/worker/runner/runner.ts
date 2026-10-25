// Runs one task through unit A of the agent runner: worktree, images,
// capability check, the locked-down Compose project with the egress proxy,
// one implementer turn, and a commit (D-058 to D-075). The gate loop (D-072)
// comes in unit B.
import * as fs from "node:fs";
import * as path from "node:path";
import { readAgent, type AgentResult } from "../agents/agentDefs";
import type { BaseImage } from "../agentImage";
import type { DockerClient } from "../docker";
import { readFile } from "../store";
import type { Task } from "../tasks/model";
import { parseTasksIndex } from "../tasks/parse";
import { gatePrograms, parseQuickRef } from "../tasks/quickref";
import { CapabilityCheck } from "./capability";
import {
  findDevService,
  findProjectFiles,
  generateOverride,
  imageRefusals,
  infrastructureCompose,
  projectName,
  projectPrefix,
  PROXY_SERVICE,
  PROXY_TOKEN_VARIABLE,
  READ_ONLY_PATHS,
  refusals,
  resolveConfig,
} from "./compose";
import { printableLine } from "./clean";
import { TaskBlocked, TokenRejected } from "./errors";
import { dockerEnv, type Run } from "./exec";
import { TaskImages } from "./images";
import { TaskProject } from "./project";
import { systemPrompt, taskPrompt } from "./prompts";
import { runAgent, type AgentOutcome } from "./session";
import { Worktrees } from "./worktree";

export interface RunnerDeps {
  root: string;
  stateDir: string;
  socket: string;
  docker: DockerClient;
  run: Run;
  baseImage: BaseImage;
  proxyImage: BaseImage;
  // The Claude token, asking the extension to sign in if there's none (D-049).
  token: () => Promise<string>;
  // Claude rejected this token: forget it (if it's still the current one),
  // so a new sign-in is asked for.
  tokenRejected: (token: string) => void;
  log: (line: string) => void;
  // For tests: the round's time limit.
  roundTimeoutMs?: number;
}

export interface RoundResult {
  summary: string;
  // Things the human should know that didn't stop the round.
  notes: string[];
}

export { TaskBlocked, TokenRejected } from "./errors";

// A round's time limit (D-079).
export const ROUND_TIMEOUT_MS = 60 * 60_000;

// Docker Engine before 26.0.0 lets DNS queries out of internal networks
// (CVE-2024-29018).
export const MIN_ENGINE = [26, 0, 0] as const;

export function engineTooOld(version: string): boolean {
  const parts = version.split(/[.+-]/).slice(0, 3).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < 3; i++) {
    const have = parts[i] ?? 0;
    const want = MIN_ENGINE[i] ?? 0;
    if (Number.isNaN(have)) return true;
    if (have !== want) return have < want;
  }
  return false;
}

// How the CLI reports a rejected token, as a fallback for the SDK's
// `authentication_failed`.
export const AUTH_FAILURE = /\b401\b|authentication_error|invalid bearer token|oauth (?:access )?token (?:has expired|is invalid)/i;
// How the pinned CLI reports a session it can't resume.
export const MISSING_SESSION = /no conversation found|no session found with id|session_not_found/i;
// The proxy's line for Claude answering 401 (agents can't write such a line:
// refusals start with "refused" and quote what the agent sent).
const UPSTREAM_401 = /^POST \/v1\/messages(?:\/count_tokens)? 401$/;

const readText = (file: string) => {
  const r = readFile(file);
  return r.status === "ok" ? r.content.text : undefined;
};

// The agent for a pipeline role, from the main checkout's TASKS.md (D-033).
export function pipelineAgent(root: string, task: Task, role: string): AgentResult {
  const text = readText(path.join(root, "TASKS.md"));
  if (text === undefined) return { ok: false, error: "TASKS.md can't be read" };
  const index = parseTasksIndex(text);
  if (!index.ok) return { ok: false, error: "TASKS.md doesn't parse; fix the problems shown for it" };
  const name = task.pipeline ?? "default";
  const pipeline = index.value.pipelines.find((p) => p.name === name);
  if (!pipeline) return { ok: false, error: `TASKS.md has no "${name}" pipeline` };
  const agent = pipeline.roles.find((r) => r.role === role)?.agents[0];
  if (!agent) return { ok: false, error: `the "${name}" pipeline has no ${role} agent` };
  return readAgent(root, agent);
}

export class TaskRunner {
  // Whether a task could start now: Docker is reachable and there's a token.
  // Checked before a task's status changes, so a stopped Docker doesn't
  // send tasks to needs-human.
  async preflight(): Promise<void> {
    await this.deps.docker.ping();
    await this.deps.token();
  }

  // Stops this repository's projects left over from a worker that didn't
  // clean up (D-075, D-079). Run before any task starts.
  async sweep(): Promise<void> {
    const { run, socket, root, stateDir, log } = this.deps;
    const prefix = projectPrefix(root);
    const listed = await run("docker", ["compose", "ls", "--all", "--format", "json"], { env: dockerEnv(socket), timeoutMs: 60_000 });
    if (listed.code !== 0) throw new Error(`docker compose ls failed: ${listed.stderr.trim().slice(0, 300)}`);
    const parsed: unknown = JSON.parse(listed.stdout || "[]");
    if (!Array.isArray(parsed)) throw new Error("docker compose ls returned something other than a list");
    const projects = parsed
      .map((p: unknown) => (typeof p === "object" && p !== null && typeof (p as { Name?: unknown }).Name === "string" ? (p as { Name: string }).Name : ""))
      .filter((n) => n.startsWith(prefix));
    // A folder with no Compose file in it or above it, so only the labels
    // are used.
    const empty = path.join(stateDir, "no-project");
    fs.mkdirSync(empty, { recursive: true });
    const failed: string[] = [];
    for (const name of projects) {
      log(`stopping leftover project ${name}`);
      await new TaskProject(run, socket, empty, name, []).down().catch((error: unknown) => {
        failed.push(name);
        log(`couldn't stop ${name}: ${String(error)}`);
      });
    }
    if (failed.length) throw new Error(`couldn't stop ${failed.join(", ")}`);
  }

  private readonly worktrees: Worktrees;
  private readonly images: TaskImages;
  private readonly capability: CapabilityCheck;

  constructor(private readonly deps: RunnerDeps) {
    this.worktrees = new Worktrees(deps.run, deps.root, path.join(deps.stateDir, "worktrees"), deps.log);
    this.images = new TaskImages(deps.docker, deps.run, deps.log);
    this.capability = new CapabilityCheck(path.join(deps.stateDir, "capability"));
  }

  // One round, stopped by `abort` or after the time limit.
  async round(task: Task, taskText: string, abort: AbortController): Promise<RoundResult> {
    const limit = this.deps.roundTimeoutMs ?? ROUND_TIMEOUT_MS;
    const inner = new AbortController();
    const forward = () => inner.abort(abort.signal.reason);
    abort.signal.addEventListener("abort", forward, { once: true });
    if (abort.signal.aborted) forward();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      inner.abort("time limit");
    }, limit);
    timer.unref();
    try {
      return await this.roundWithin(task, taskText, inner);
    } catch (error) {
      if (timedOut && !abort.signal.aborted) throw new Error(`the round ran over its limit of ${Math.round(limit / 60_000)} minutes and was stopped`, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", forward);
    }
  }

  private async roundWithin(task: Task, taskText: string, abort: AbortController): Promise<RoundResult> {
    const { root, stateDir, socket, run, log } = this.deps;
    const { signal } = abort;
    const notes: string[] = [];
    signal.throwIfAborted();
    const version = await this.deps.docker.version();
    if (engineTooOld(version)) throw new TaskBlocked(`Docker Engine ${version || "(unknown version)"} is too old: agents need 26.0.0 or later, because older versions let DNS queries out of internal networks (CVE-2024-29018). Update Docker.`);
    const agent = pipelineAgent(root, task, "implement");
    if (!agent.ok) throw new TaskBlocked(agent.error);
    const readme = readText(path.join(root, "README.md"));
    const quickRef = readme === undefined ? undefined : parseQuickRef(readme);

    const worktree = await this.worktrees.ensure(task.id);
    signal.throwIfAborted();
    const token = await this.deps.token();
    signal.throwIfAborted();
    const [baseImage, proxyImage] = await Promise.all([this.deps.baseImage.ensure(), this.deps.proxyImage.ensure()]);
    signal.throwIfAborted();
    const dir = path.join(stateDir, "compose", task.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName(root, task.id);
    // Agents see this empty file in place of the worktree's .git (D-079).
    const emptyFile = path.join(stateDir, "empty");
    if (!fs.existsSync(emptyFile)) fs.writeFileSync(emptyFile, "");

    let project: TaskProject;
    let service: string;
    let image: string;
    // The project's other services, started before the agent so it can use
    // them (its own container is started per turn, with --no-deps).
    let services: string[] = [];
    if (task.kind === "infrastructure") {
      // No dev image yet: the base agent image, in a project of its own (D-062).
      const file = path.join(dir, "compose.yaml");
      fs.writeFileSync(file, infrastructureCompose({ baseImage, proxyImage, root, worktree, project: name, emptyFile }));
      project = new TaskProject(run, socket, dir, name, [file]);
      service = "agent";
      image = baseImage;
    } else {
      const files = findProjectFiles(root);
      if (!files.ok) throw new TaskBlocked(`the repository is missing ${files.missing.join(" and ")} at its root (D-058)`);
      const config = await resolveConfig(run, socket, root, files.compose);
      const dev = findDevService(config, root);
      if (!dev.ok) throw new TaskBlocked(dev.error);
      const problems = [...refusals(config.services[dev.name] ?? {}, root), ...imageRefusals(config)];
      if (problems.length) throw new TaskBlocked(`the ${dev.name} service can't be used for agents because ${problems.join("; ")} (D-059)`);
      const target = new TaskProject(run, socket, root, name, [path.join(root, files.compose)]);
      services = Object.keys(config.services).filter((s) => s !== dev.name);
      const built = services.filter((s) => config.services[s]?.build !== undefined);
      const devImage = await this.images.devImage(target, dev.name, config.services[dev.name]?.image ?? `${name}-${dev.name}`, built, signal);
      image = await this.images.derived(devImage, baseImage, target.env(), signal);
      const { yaml, unconnected } = generateOverride({ config, devService: dev.name, devImage: image, proxyImage, root, worktree, project: name, emptyFile });
      if (unconnected.length) notes.push(`Agents can't reach ${unconnected.join(", ")}: these services set network_mode.`);
      const override = path.join(dir, "override.yaml");
      fs.writeFileSync(override, yaml);
      project = new TaskProject(run, socket, root, name, [path.join(root, files.compose), override]);
      service = dev.name;
    }

    let outcome: AgentOutcome;
    // The proxy's own log: method, path, status, and why it refused.
    let proxyLog: string[] = [];
    try {
      // Containers a crashed worker left behind go first (D-075).
      await project.down();
      // Only the proxy is created with the token in Compose's environment, so
      // no other service can interpolate it (D-066).
      await project.up([PROXY_SERVICE], { [PROXY_TOKEN_VARIABLE]: token }, signal);
      if (services.length) await project.up(services, {}, signal);
      // An infrastructure task is what writes the gates, so they aren't
      // checked for it here (D-062 checks them on the host in unit B).
      const programs = task.kind !== "infrastructure" && quickRef ? gatePrograms(quickRef) : [];
      const capability = await this.capability.check(project, service, image, programs, signal);
      if (!capability.ok) throw new TaskBlocked(capability.problems.join(" "));

      const sessions = new Sessions(path.join(stateDir, "sessions", `${task.id}.json`));
      const diff = await this.worktrees.diff(task.id).catch(() => "");
      const turn = (resume: string | undefined) =>
        runAgent({
          project,
          service,
          agent: agent.agent,
          systemPrompt: systemPrompt(agent.agent, readText(path.join(root, "docs", "decisions.md")), quickRef?.text),
          prompt: taskPrompt(task, taskText, diff),
          ...(resume ? { resume } : {}),
          abort,
          log,
          stateDir,
          onSession: (id) => sessions.save(id),
        });
      const resume = sessions.load();
      outcome = await turn(resume);
      // A session that can't be resumed (its volume was removed) is
      // forgotten, and the round starts a fresh one once. Other early
      // failures (a rejected token, an outage) keep the session.
      if (resume && outcome.error && !outcome.answered && !signal.aborted && MISSING_SESSION.test(`${outcome.error}\n${outcome.stderr ?? ""}`)) {
        log(`${task.id}: couldn't resume session ${resume}; starting a new one`);
        sessions.clear();
        outcome = await turn(undefined);
      }
    } finally {
      // Skipped when stopping, so shutdown isn't held up.
      if (!signal.aborted) proxyLog = await this.readProxyLog(project);
      for (const line of proxyLog) if (line.startsWith("refused ")) log(`${task.id} proxy ${line.slice(0, 200)}`);
      await project.down().catch((error: unknown) => log(`couldn't stop ${task.id}'s services: ${String(error)}`));
    }
    signal.throwIfAborted();
    if (outcome.error) {
      // The CLI's output can be forged by what the agent runs, so a rejected
      // token also needs the proxy to have seen Claude answer 401.
      const said = outcome.authFailed || AUTH_FAILURE.test(`${outcome.error}\n${outcome.stderr ?? ""}`);
      if (said && proxyLog.some((line) => UPSTREAM_401.test(line))) {
        this.deps.tokenRejected(token);
        throw new TokenRejected(`Claude rejected the token: ${outcome.error}`);
      }
      throw new Error(`the implementer agent failed: ${outcome.error}`);
    }
    const summary = outcome.summary?.trim() || "The implementer finished without a summary.";
    // Committed only once the agent's containers are gone, so nothing it
    // left running can change the worktree while host git reads it (D-079).
    const commit = await this.worktrees.commit(task.id, "implementer", `${commitSubject(task.id, summary)}\n\n${summary}`);
    if (!commit.committed) notes.push("The implementer made no changes.");
    if (commit.refused.length) notes.push(`Not committed, because agents can't change ${READ_ONLY_PATHS.join(", ")} or add nested repositories: ${commit.refused.join(", ")}.`);
    return { summary, notes };
  }

  // The proxy's log lines, cleaned (refusal reasons quote agent text).
  private async readProxyLog(project: TaskProject): Promise<string[]> {
    try {
      const out = await project.compose(["logs", "--no-log-prefix", "--tail", "500", PROXY_SERVICE], { what: "reading the proxy's log", timeoutMs: 5_000 });
      return out.split("\n").map(printableLine).filter(Boolean);
    } catch {
      return [];
    }
  }
}

// "T-NNN: " and the summary's first sentence, cut at a word to fit 72
// characters.
export function commitSubject(taskId: string, summary: string): string {
  const prefix = `${taskId}: `;
  // A sentence ends at ". ", but not after "e.g." and the like.
  const first = (summary.split("\n")[0] ?? "").split(/(?<=(?<!\b(?:e\.g|i\.e|etc|vs|cf))\.)\s/)[0]?.trim() ?? "";
  const room = 72 - prefix.length;
  if (first.length <= room) return prefix + first;
  const cut = first.slice(0, room - 1);
  const space = cut.lastIndexOf(" ");
  return `${prefix}${(space > room / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:]+$/, "")}…`;
}

// The task's agent session ID (D-071), saved as soon as the CLI reports it.
class Sessions {
  constructor(private readonly file: string) {}

  load(): string | undefined {
    try {
      const id = (JSON.parse(fs.readFileSync(this.file, "utf8")) as { sessionId?: unknown }).sessionId;
      return typeof id === "string" && id ? id : undefined;
    } catch {
      return undefined;
    }
  }

  save(sessionId: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ sessionId }));
  }

  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}
