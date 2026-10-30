// Runs a task through the gate loop (D-072): rebuild when build inputs
// changed (D-080), an implementer turn and a commit, the required gates on a
// copy of the commit (D-081), then the pipeline's reviewers (D-082), for up
// to three rounds (D-083). The containers are the target's Compose project
// with a generated locked-down override and the egress proxy (D-058 to
// D-079).
import * as fs from "node:fs";
import * as path from "node:path";
import { readAgent, type AgentDef, type AgentResult } from "../agents/agentDefs";
import type { BaseImage } from "../agentImage";
import type { DockerClient } from "../docker";
import { readFile } from "../store";
import type { Task } from "../tasks/model";
import { parseTasksIndex } from "../tasks/parse";
import { gatePrograms, parseQuickRef, type QuickRef } from "../tasks/quickref";
import { CapabilityCheck } from "./capability";
import { inertLine, printable, printableLine } from "./clean";
import {
  buildOverride,
  findDevService,
  findProjectFiles,
  generateOverride,
  agentBuild,
  agentBuildCompose,
  agentComposeTextProblems,
  imageRefusals,
  infrastructureCompose,
  outside,
  reservedNames,
  type AgentBuild,
  projectName,
  projectPrefix,
  PROXY_SERVICE,
  PROXY_TOKEN_VARIABLE,
  READ_ONLY_PATHS,
  refusals,
  resolveConfig,
  type AgentMounts,
  type ComposeConfig,
} from "./compose";
import { TaskBlocked, TokenRejected } from "./errors";
import { dockerEnv, type Run } from "./exec";
import { openLines, roundLine, type Finding, type GateFailure } from "./findings";
import { TaskImages } from "./images";
import { TaskProject } from "./project";
import { implementerPrompt, reviewerPrompt, systemPrompt } from "./prompts";
import { afterHumanReady, freshState, MAX_ROUNDS, Rounds, type RoundState } from "./rounds";
import { runAgent, type AgentOutcome, type AgentRun } from "./session";
import { removeQuietly, Worktrees, type BuildSpec } from "./worktree";

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
  // For tests: the limits of one agent turn and of the gates.
  turnTimeoutMs?: number;
  gatesTimeoutMs?: number;
}

export interface RunContext {
  // Appends a line to the task's Updates without changing its status.
  note: (line: string) => Promise<void>;
  // The human marked this task ready from needs-human (D-080, D-083).
  fromNeedsHuman: boolean;
  // The orchestrator just moved it from ready to in-implementation: a new
  // start, not a resume.
  started?: boolean;
}

export type RunOutcome =
  // Gates passed and reviewers found nothing: ready for the human.
  | { kind: "clean"; summary: string; notes: string[] }
  // Still open after the last round, or a rebuild that needs approval.
  | { kind: "needs-human"; reason: string; notes: string[] }
  // An agent asked a question; the round resumes once it's answered.
  | { kind: "question"; question: string; asker: string; notes: string[] };

export { TaskBlocked, TokenRejected } from "./errors";

// One agent turn's time limit (D-079, amended for unit B).
export const TURN_TIMEOUT_MS = 60 * 60_000;
// All of a round's required gates together (D-081).
export const GATES_TIMEOUT_MS = 20 * 60_000;
const GATE_OUTPUT_LINES = 80;

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

// The agents for a pipeline role, from the main checkout's TASKS.md (D-033).
// A missing pipeline is an error; a role with no agents is an empty list.
export function pipelineAgents(root: string, task: Task, role: string): { ok: true; agents: AgentDef[] } | { ok: false; error: string } {
  const text = readText(path.join(root, "TASKS.md"));
  if (text === undefined) return { ok: false, error: "TASKS.md can't be read" };
  const index = parseTasksIndex(text);
  if (!index.ok) return { ok: false, error: "TASKS.md doesn't parse; fix the problems shown for it" };
  const name = task.pipeline ?? "default";
  const pipeline = index.value.pipelines.find((p) => p.name === name);
  if (!pipeline) return { ok: false, error: `TASKS.md has no "${name}" pipeline` };
  const agents: AgentDef[] = [];
  for (const link of pipeline.roles.find((r) => r.role === role)?.agents ?? []) {
    const agent = readAgent(root, link);
    if (!agent.ok) return agent;
    agents.push(agent.agent);
  }
  return { ok: true, agents };
}

// The one agent for a role that must have one.
export function pipelineAgent(root: string, task: Task, role: string): AgentResult {
  const result = pipelineAgents(root, task, role);
  if (!result.ok) return result;
  const agent = result.agents[0];
  return agent ? { ok: true, agent } : { ok: false, error: `the "${task.pipeline ?? "default"}" pipeline has no ${role} agent` };
}

type Variant = "agent" | "gates" | "review";

// The containers one phase of a round runs in: a Compose project whose dev
// service is mounted for the implementer (worktree, session), the gates (a
// copy of the commit) or reviewers (worktree, read-only).
class TaskEnv {
  constructor(
    private readonly deps: RunnerDeps,
    readonly name: string,
    private readonly projectDir: string,
    private readonly baseFiles: string[],
    private readonly dir: string,
    readonly service: string,
    readonly services: string[],
    private readonly compose: (variant: Variant, image: string, mounts: AgentMounts) => string,
    readonly mounts: Record<Variant, AgentMounts>,
    public image: string,
  ) {}

  project(variant: Variant): TaskProject {
    const file = path.join(this.dir, `${variant}.yaml`);
    fs.writeFileSync(file, this.compose(variant, this.image, this.mounts[variant]));
    return new TaskProject(this.deps.run, this.deps.socket, this.projectDir, this.name, [...this.baseFiles, file]);
  }
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
  private readonly rounds: Rounds;

  constructor(private readonly deps: RunnerDeps) {
    this.worktrees = new Worktrees(deps.run, deps.root, path.join(deps.stateDir, "worktrees"), deps.log);
    this.images = new TaskImages(deps.docker, deps.run, deps.log);
    this.capability = new CapabilityCheck(path.join(deps.stateDir, "capability"));
    this.rounds = new Rounds(path.join(deps.stateDir, "rounds"));
  }

  // Where a task's worktree is, for "Open review" (D-077).
  worktreePath(taskId: string): string {
    return this.worktrees.path(taskId);
  }

  // Runs the task's loop from wherever it stopped, until it is clean, needs
  // the human, or an agent asks a question.
  async run(task: Task, taskText: string, abort: AbortController, context: RunContext): Promise<RunOutcome> {
    const { root, stateDir, log } = this.deps;
    const { signal } = abort;
    // The human's go-ahead is recorded before anything can fail, so a stop
    // here doesn't lose it (D-080, D-083).
    let state = this.rounds.load(task.id);
    if (context.fromNeedsHuman) {
      state = afterHumanReady(state);
      this.rounds.save(task.id, state);
    }
    // Clean before, and set ready again since (e.g. parked in review): the
    // work is looked at afresh.
    if (state.phase === "done" && context.started) {
      state = { ...freshState(), ...(state.image ? { image: state.image } : {}), ...(state.start ? { start: state.start } : {}) };
      this.rounds.save(task.id, state);
    }
    // Decided already, but not yet recorded in the task file (a crash).
    if (state.phase === "done") return { kind: "clean", summary: state.summary ?? NO_SUMMARY, notes: [] };
    if (state.exhausted) return { kind: "needs-human", reason: `still open after ${MAX_ROUNDS} rounds`, notes: openLines(state.failures, state.findings, this.worktrees.path(task.id)) };

    signal.throwIfAborted();
    const version = await this.deps.docker.version();
    if (engineTooOld(version)) throw new TaskBlocked(`Docker Engine ${version || "(unknown version)"} is too old: agents need 26.0.0 or later, because older versions let DNS queries out of internal networks (CVE-2024-29018). Update Docker.`);
    const implementer = pipelineAgent(root, task, "implement");
    if (!implementer.ok) throw new TaskBlocked(implementer.error);
    const reviewers = pipelineAgents(root, task, "review");
    if (!reviewers.ok) throw new TaskBlocked(reviewers.error);
    const readme = readText(path.join(root, "README.md"));
    const quickRef = readme === undefined ? undefined : parseQuickRef(readme);
    const decisions = readText(path.join(root, "docs", "decisions.md"));

    const worktree = await this.worktrees.ensure(task.id);
    // Before any agent turn, so it is the human's commit (D-080).
    if (!state.start) {
      state.start = await this.worktrees.startCommit(task.id);
      this.rounds.save(task.id, state);
    }
    signal.throwIfAborted();
    const token = await this.deps.token();
    signal.throwIfAborted();
    const [baseImage, proxyImage] = await Promise.all([this.deps.baseImage.ensure(), this.deps.proxyImage.ensure()]);
    signal.throwIfAborted();
    // Answered only if the question reached the task file and came back
    // answered (D-011): the task left needs-decision for in-implementation.
    let answered = state.paused === "implementer" && cameBackAnswered(task);

    const dir = path.join(stateDir, "compose", task.id);
    fs.mkdirSync(dir, { recursive: true });
    const name = projectName(root, task.id);
    // Agents see this empty file in place of the worktree's .git (D-079).
    const emptyFile = path.join(stateDir, "empty");
    if (!fs.existsSync(emptyFile)) fs.writeFileSync(emptyFile, "");
    const mounts: Record<Variant, AgentMounts> = {
      agent: { root, worktree, emptyFile },
      // Set to each round's own copy of the commit (D-081).
      gates: { root, worktree: path.join(stateDir, "gates", task.id), emptyFile, session: false },
      review: { root, worktree, emptyFile, readOnly: true, session: false },
    };
    const notes: string[] = [];
    const deps: EnvDeps = { task, name, dir, mounts, token, baseImage, proxyImage, notes, warned: false };
    const infra = task.kind === "infrastructure";

    // Infrastructure tasks have their implementer in the base image (D-062);
    // their checks and reviews run once the dev environment they write builds.
    const agentEnv = infra ? this.baseEnv(deps) : undefined;
    // The project's environment for the branch's current commit, made once
    // per commit.
    let cached: { head: string; env: TaskEnv | RunOutcome | BuildFailed } | undefined;
    const projectEnv = async (): Promise<TaskEnv | RunOutcome | BuildFailed> => {
      const head = await this.worktrees.head(task.id);
      if (cached?.head !== head) cached = { head, env: await this.projectEnv(deps, state, signal) };
      return cached.env;
    };

    for (;;) {
      signal.throwIfAborted();
      if (state.phase === "implement") {
        let env = agentEnv;
        if (!env) {
          const ready = await projectEnv();
          if (ready instanceof TaskEnv) env = ready;
          else return ready.kind === "build-failed" ? buildFailedOutcome(ready, notes) : ready;
        }
        const outcome = await this.implementerTurn({ env, task, taskText, state, agent: implementer.agent, decisions, quickRef, answered, token, abort, checkGates: !infra });
        if (outcome.question) {
          state.paused = "implementer";
          this.rounds.save(task.id, state);
          return { kind: "question", question: outcome.question, asker: implementer.agent.name, notes };
        }
        // The answer has been given; later rounds don't repeat it.
        answered = false;
        delete state.paused;
        const summary = outcome.summary?.trim() || NO_SUMMARY;
        // Committed only once the agent's containers are gone, so nothing it
        // left running can change the worktree while host git reads it (D-079).
        const commit = await this.worktrees.commit(task.id, "implementer", `${commitSubject(task.id, summary)}\n\n${summary}`);
        if (!commit.committed) notes.push(`Round ${state.round}: the implementer made no changes.`);
        if (commit.refused.length) notes.push(`Not committed, because agents can't change ${READ_ONLY_PATHS.join(", ")} or add nested repositories: ${commit.refused.map((t) => inertLine(t)).join(", ")}.`);
        state.summary = summary;
        state.phase = "gates";
        this.rounds.save(task.id, state);
      }

      if (state.phase === "gates") {
        const ready = await projectEnv();
        if (ready instanceof TaskEnv) {
          // An infrastructure task's dev environment is checked here, as part
          // of its gates (D-062).
          state.failures = await this.gates(ready, task.id, state.round, quickRef, abort, infra);
        } else if (ready.kind === "build-failed") {
          // For an infrastructure task, a dev environment that doesn't build
          // is this round's gate failure, for the implementer to fix.
          if (!infra) return buildFailedOutcome(ready, notes);
          state.failures = [{ label: "Build the dev environment", commands: [], code: null, timedOut: false, output: ready.output }];
        } else return ready;
        state.phase = "review";
        this.rounds.save(task.id, state);
      }

      if (state.phase === "review") {
        let env: TaskEnv;
        // An infrastructure task is reviewed in the base image, never in one
        // its implementer's Dockerfile built, which could tamper with the
        // reviewers (D-085).
        if (agentEnv) env = agentEnv;
        else {
          const ready = await projectEnv();
          if (!(ready instanceof TaskEnv)) return ready.kind === "build-failed" ? buildFailedOutcome(ready, notes) : ready;
          env = ready;
        }
        const review = await this.review(env, task, taskText, state, reviewers.agents, decisions, quickRef, token, abort);
        if ("question" in review) {
          state.paused = "reviewer";
          this.rounds.save(task.id, state);
          return { kind: "question", question: review.question, asker: review.asker, notes };
        }
        delete state.paused;
        state.findings = review.findings;
        // Saved before noting: a crash in between loses a line, not a review.
        this.rounds.save(task.id, state);
        await context.note(roundLine(state.round, state.failures, state.findings));
        if (!state.failures.length && !state.findings.length) {
          // Kept until the orchestrator has recorded it (finished()).
          state.phase = "done";
          this.rounds.save(task.id, state);
          return { kind: "clean", summary: state.summary ?? NO_SUMMARY, notes };
        }
        if (state.round >= MAX_ROUNDS) {
          state.exhausted = true;
          state.phase = "implement";
          this.rounds.save(task.id, state);
          return { kind: "needs-human", reason: `still open after ${MAX_ROUNDS} rounds`, notes: [...notes, ...openLines(state.failures, state.findings, worktree)] };
        }
        state.round++;
        state.phase = "implement";
        this.rounds.save(task.id, state);
        log(`${task.id}: starting round ${state.round}`);
      }
    }
  }

  // The orchestrator recorded a clean task: its round state and build copy
  // can go.
  finished(taskId: string): void {
    this.rounds.clear(taskId);
    removeQuietly(path.join(this.deps.stateDir, "build", taskId), this.deps.log);
  }

  // A project of our own: one agent service and the proxy. For an
  // infrastructure task's implementer, in the base agent image (D-062); for
  // its checks and reviews, in the image built from its dev service (D-085).
  private baseEnv(d: EnvDeps, image = d.baseImage): TaskEnv {
    const compose = (_variant: Variant, img: string, mounts: AgentMounts) => infrastructureCompose({ ...mounts, baseImage: img, proxyImage: d.proxyImage, project: d.name });
    return new TaskEnv(this.deps, d.name, d.dir, [], d.dir, "agent", [], compose, d.mounts, image);
  }

  // The human's Compose setup in the main checkout (D-059).
  private async composeSetup(): Promise<ComposeSetup> {
    const { run, socket, root } = this.deps;
    const files = findProjectFiles(root);
    if (!files.ok) throw new TaskBlocked(`the repository is missing ${files.missing.join(" and ")} at its root (D-058)`);
    const config = await resolveConfig(run, socket, root, files.compose);
    const dev = findDevService(config, root);
    if (!dev.ok) throw new TaskBlocked(dev.error);
    const problems = [...refusals(config.services[dev.name] ?? {}, root), ...imageRefusals(config), ...reservedNames(config)];
    if (problems.length) throw new TaskBlocked(`the Compose setup can't be used for agents because ${problems.join("; ")} (D-059)`);
    return { composeRoot: root, composeFile: path.join(root, files.compose), config, dev: dev.name, services: Object.keys(config.services).filter((s) => s !== dev.name) };
  }

  // An infrastructure task's dev service build, from a copy of its commit,
  // checked against D-085's allowlist. Problems are the agent's to fix.
  private async agentSetup(copy: string): Promise<AgentBuild | BuildFailed> {
    const { run, socket } = this.deps;
    const failed = (problems: string[]): BuildFailed => ({ kind: "build-failed", output: `the dev environment can't be used for agents because ${problems.map((t) => inertLine(t)).join("; ")} (D-085)` });
    const files = findProjectFiles(copy);
    if (!files.ok) return { kind: "build-failed", output: `the task's dev environment is missing ${files.missing.join(" and ")} at its root (D-058)` };
    const composePath = path.join(copy, files.compose);
    if (fs.statSync(composePath).size > 1_000_000) return failed([`its ${files.compose} is over 1 MB`]);
    // Before Compose reads it at all: these make it read or fetch other files.
    const textProblems = agentComposeTextProblems(fs.readFileSync(composePath, "utf8"));
    if (textProblems.length) return failed(textProblems);
    let config: ComposeConfig;
    try {
      config = await resolveConfig(run, socket, copy, files.compose, this.emptyEnvFile());
    } catch (error) {
      return { kind: "build-failed", output: inertLine(error instanceof Error ? error.message : String(error)) };
    }
    const dev = findDevService(config, copy);
    if (!dev.ok) return { kind: "build-failed", output: inertLine(dev.error) };
    const build = agentBuild(config, dev.name, copy);
    const problems = [...(build.ok ? [] : build.problems), ...reservedNames(config)];
    if (problems.length || !build.ok) return failed(problems);
    return build.build;
  }

  // An empty env file of ours, used in place of an agent's .env (D-085).
  private emptyEnvFile(): string {
    const file = path.join(this.deps.stateDir, "empty.env");
    if (!fs.existsSync(file)) fs.writeFileSync(file, "");
    return file;
  }

  // A copy of a commit for building; one per commit, older ones removed.
  private async buildCopy(taskId: string, commit: string): Promise<string> {
    const base = path.join(this.deps.stateDir, "build", taskId);
    const dir = path.join(base, commit);
    // Beside the copy, not in it: a commit can't fake it, and it stays out of
    // the build context.
    const complete = `${dir}.complete`;
    if (!fs.existsSync(complete) || !fs.existsSync(dir)) {
      await this.worktrees.exportCommit(commit, dir);
      fs.writeFileSync(complete, "");
    }
    for (const other of fs.existsSync(base) ? fs.readdirSync(base) : []) if (other !== commit && other !== `${commit}.complete`) removeQuietly(path.join(base, other), this.deps.log);
    return dir;
  }

  // The containers for checks and reviews, with the task's image (D-080):
  // the human's Compose setup with the locked-down override, or for an
  // infrastructure task only its dev service, in a project of our own (D-085).
  protected async projectEnv(d: EnvDeps, state: RoundState, signal: AbortSignal): Promise<TaskEnv | RunOutcome | BuildFailed> {
    const image = await this.ensureImage(d, state, signal);
    if (typeof image !== "string") return image;
    if (d.task.kind === "infrastructure") return this.baseEnv(d, image);
    const setup = await this.composeSetup();
    const compose = (_variant: Variant, img: string, mounts: AgentMounts) => {
      const { yaml, unconnected } = generateOverride({ config: setup.config, devService: setup.dev, devImage: img, proxyImage: d.proxyImage, project: d.name, ...mounts });
      if (unconnected.length && !d.warned) {
        d.warned = true;
        d.notes.push(`Agents can't reach ${unconnected.join(", ")}: these services set network_mode.`);
      }
      return yaml;
    };
    return new TaskEnv(this.deps, d.name, setup.composeRoot, [setup.composeFile], d.dir, setup.dev, setup.services, compose, d.mounts, image);
  }

  // The derived agent image for the branch (D-080). A build with the network
  // on runs without asking only for a commit already trusted: the one the
  // task started from (the human's code) or one built before. Anything else
  // is built only after the human approved exactly that commit. Builds read
  // a copy of the commit, never the worktree. Whether a rebuild is needed at
  // all comes from the build inputs that changed.
  protected async ensureImage(d: EnvDeps, state: RoundState, signal: AbortSignal): Promise<string | RunOutcome | BuildFailed> {
    const { docker } = this.deps;
    const id = d.task.id;
    const head = await this.worktrees.head(id);
    if (!state.start) {
      state.start = await this.worktrees.startCommit(id);
      this.rounds.save(id, state);
    }
    const start = state.start;
    if (state.image && !(await this.worktrees.exists(state.image.builtFrom))) delete state.image;
    const specs = d.task.kind === "infrastructure" ? (state.buildSpec ? [state.buildSpec] : undefined) : await this.buildSpecs();
    const since = state.image?.builtFrom ?? start;
    const changed = await this.worktrees.changedBuildInputs(since, head, specs);
    if (!changed.length) {
      if (state.image && (await docker.inspectImage(state.image.derived))) return state.image.derived;
      // The image is missing or never built: build the trusted commit, whose
      // build inputs match the branch's.
      return this.build(d, state, since, signal);
    }
    if (state.approval?.commit === head && state.approval.approved) {
      // Used up by this attempt, unless it was stopped. Failed, it waits for
      // the human again: marking it ready retries that same commit.
      const built = await this.build(d, state, head, signal);
      if (typeof built === "string") {
        delete state.approval;
        delete state.failedBuild;
      } else {
        state.approval = { commit: head, approved: false };
        state.failedBuild = { commit: head, output: built.output };
      }
      this.rounds.save(id, state);
      return built;
    }
    // This commit's approved build already failed (e.g. before a restart).
    if (state.failedBuild?.commit === head) return { kind: "build-failed", output: state.failedBuild.output };
    state.approval = { commit: head, approved: false };
    this.rounds.save(id, state);
    const listed = changed.slice(0, 10).map((t) => inertLine(t)).join(", ") + (changed.length > 10 ? ` and ${changed.length - 10} more` : "");
    return {
      kind: "needs-human",
      reason: `the image needs rebuilding because these build inputs changed: ${listed}. Mark it ready to rebuild it from commit ${head.slice(0, 12)}: its build steps run with network access on your Docker, where they can read your other local images and build cache (D-080)`,
      notes: d.notes,
    };
  }

  // The builds in the human's Compose setup, for finding changed build inputs.
  protected async buildSpecs(): Promise<BuildSpec[]> {
    const { root } = this.deps;
    const setup = await this.composeSetup();
    const specs: BuildSpec[] = [];
    for (const service of Object.values(setup.config.services)) {
      if (service.build?.context === undefined || /^[a-z]+:\/\/|^git@/i.test(service.build.context)) continue;
      const rel = path.relative(root, path.resolve(root, service.build.context));
      if (outside(rel)) continue;
      const dockerfile = service.build.dockerfile ?? "Dockerfile";
      specs.push({ context: rel.split(path.sep).join("/") || ".", dockerfile: path.isAbsolute(dockerfile) ? path.relative(path.resolve(root, service.build.context), dockerfile) : dockerfile });
    }
    return specs.length ? specs : [{ context: ".", dockerfile: "Dockerfile" }];
  }

  // Builds the dev and derived images from a copy of `commit`.
  protected async build(d: EnvDeps, state: RoundState, commit: string, signal: AbortSignal): Promise<string | BuildFailed> {
    const { run, socket, root } = this.deps;
    const infra = d.task.kind === "infrastructure";
    let copy: string;
    try {
      copy = await this.buildCopy(d.task.id, commit);
    } catch (error) {
      // Too big a commit is the agent's to fix in an infrastructure task.
      if (infra && error instanceof TaskBlocked) return { kind: "build-failed", output: inertLine(error.message) };
      throw error;
    }
    let target: TaskProject;
    let devService: string;
    let imageName: string;
    let others: string[] = [];
    if (infra) {
      // Only the dev service's allowed build settings, in a file of ours.
      const build = await this.agentSetup(copy);
      if ("kind" in build) return build;
      state.buildSpec = { context: build.context, dockerfile: build.dockerfile };
      const file = path.join(d.dir, "agent-build.yaml");
      imageName = `${d.name}-dev`;
      fs.writeFileSync(file, agentBuildCompose(build, imageName));
      target = new TaskProject(run, socket, copy, d.name, [file], this.emptyEnvFile());
      devService = "dev";
    } else {
      // The human's Compose file, with its build contexts moved to the copy.
      const setup = await this.composeSetup();
      const overrideFile = path.join(d.dir, "build.yaml");
      fs.writeFileSync(overrideFile, buildOverride(setup.config, root, copy));
      target = new TaskProject(run, socket, root, d.name, [setup.composeFile, overrideFile]);
      devService = setup.dev;
      imageName = setup.config.services[setup.dev]?.image ?? `${d.name}-${setup.dev}`;
      others = setup.services.filter((s) => setup.config.services[s]?.build !== undefined);
    }
    this.deps.log(`${d.task.id}: building the image from ${commit.slice(0, 12)}`);
    try {
      const devImage = await this.images.devImage(target, devService, imageName, others, signal);
      const derived = await this.images.derived(devImage, d.baseImage, target.env(), signal);
      state.image = { builtFrom: commit, devImage, derived };
      this.rounds.save(d.task.id, state);
      return derived;
    } catch (error) {
      signal.throwIfAborted();
      // Docker itself failing isn't the build's fault: the task waits.
      await this.deps.docker.ping().catch(() => {
        throw error;
      });
      // The end of the build's output, where it says what failed; agent text.
      const lines = printable(error instanceof Error ? error.message : String(error)).trim().split("\n").slice(-40);
      return { kind: "build-failed", output: lines.map((l) => inertLine(l, 400)).join("\n") };
    } finally {
      // A copy can be gigabytes; a retry exports it again.
      removeQuietly(path.join(this.deps.stateDir, "build", d.task.id), this.deps.log);
    }
  }

  // Starts a phase's project: leftovers first (D-075), the proxy alone with
  // the token in Compose's environment (D-066), then the other services.
  private async start(project: TaskProject, env: TaskEnv, token: string | undefined, signal: AbortSignal): Promise<void> {
    await project.down();
    if (token !== undefined) await project.up([PROXY_SERVICE], { [PROXY_TOKEN_VARIABLE]: token }, signal);
    if (env.services.length) await project.up(env.services, {}, signal);
  }

  // Stops a phase's project, returning the proxy's log.
  private async stop(project: TaskProject, taskId: string, withProxy: boolean, signal: AbortSignal): Promise<string[]> {
    // Skipped when stopping, so shutdown isn't held up.
    const proxyLog = withProxy && !signal.aborted ? await this.readProxyLog(project) : [];
    for (const line of proxyLog) if (line.startsWith("refused ")) this.deps.log(`${taskId} proxy ${line.slice(0, 200)}`);
    await project.down().catch((error: unknown) => this.deps.log(`couldn't stop ${taskId}'s services: ${String(error)}`));
    return proxyLog;
  }

  // An agent turn with its own time limit (D-079).
  private async limited(abort: AbortController, turn: (inner: AbortController) => Promise<AgentOutcome>): Promise<AgentOutcome> {
    const limit = this.deps.turnTimeoutMs ?? TURN_TIMEOUT_MS;
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
      const outcome = await turn(inner);
      if (timedOut && !abort.signal.aborted) outcome.error = `the agent ran over its limit of ${Math.round(limit / 60_000)} minutes and was stopped`;
      return outcome;
    } finally {
      clearTimeout(timer);
      abort.signal.removeEventListener("abort", forward);
    }
  }

  // A failed turn: a rejected token (believed only if the proxy saw Claude
  // answer 401, since the CLI's output can be forged) or an agent failure.
  private failed(outcome: AgentOutcome, who: string, proxyLog: string[], token: string): never {
    const error = outcome.error ?? "unknown error";
    const said = outcome.authFailed || AUTH_FAILURE.test(`${error}\n${outcome.stderr ?? ""}`);
    if (said && proxyLog.some((line) => UPSTREAM_401.test(line))) {
      this.deps.tokenRejected(token);
      throw new TokenRejected(`Claude rejected the token: ${error}`);
    }
    throw new Error(`${who} failed: ${error}`);
  }

  protected async implementerTurn(o: {
    env: TaskEnv;
    task: Task;
    taskText: string;
    state: RoundState;
    agent: AgentDef;
    decisions: string | undefined;
    quickRef: QuickRef | undefined;
    answered: boolean;
    token: string;
    abort: AbortController;
    checkGates: boolean;
  }): Promise<AgentOutcome> {
    const { stateDir, log } = this.deps;
    const { signal } = o.abort;
    const project = o.env.project("agent");
    let outcome: AgentOutcome;
    let proxyLog: string[];
    try {
      await this.start(project, o.env, o.token, signal);
      // An infrastructure task writes the gates, so they're checked only
      // once its dev environment exists (D-062).
      const programs = o.checkGates && o.quickRef ? gatePrograms(o.quickRef) : [];
      const capability = await this.capability.check(project, o.env.service, o.env.image, programs, signal);
      signal.throwIfAborted();
      if (!capability.ok) throw new TaskBlocked(capability.problems.join(" "));

      const sessions = new Sessions(path.join(stateDir, "sessions", `${o.task.id}.json`));
      const diff = await this.worktrees.diff(o.task.id).catch(() => "");
      const turn = (resume: string | undefined) =>
        this.limited(o.abort, (inner) =>
          runAgent({
            project,
            service: o.env.service,
            agent: o.agent,
            role: "implementer",
            systemPrompt: systemPrompt(o.agent, "implementer", o.decisions, o.quickRef?.text),
            prompt: implementerPrompt({
              task: o.task,
              text: o.taskText,
              diff,
              round: o.state.round,
              failures: o.state.failures,
              findings: o.state.findings,
              resumed: resume !== undefined,
              answered: o.answered,
            }),
            ...(resume ? { resume } : {}),
            abort: inner,
            log,
            stateDir,
            onSession: (id) => sessions.save(id),
          }),
        );
      const resume = sessions.load();
      outcome = await turn(resume);
      // A session that can't be resumed (its volume was removed) is
      // forgotten, and the round starts a fresh one once. Other early
      // failures (a rejected token, an outage) keep the session.
      if (resume && outcome.error && !outcome.answered && !signal.aborted && MISSING_SESSION.test(`${outcome.error}\n${outcome.stderr ?? ""}`)) {
        log(`${o.task.id}: couldn't resume session ${resume}; starting a new one`);
        sessions.clear();
        outcome = await turn(undefined);
      }
    } finally {
      proxyLog = await this.stop(project, o.task.id, true, signal);
    }
    signal.throwIfAborted();
    if (outcome.question) return outcome;
    if (outcome.error) this.failed(outcome, "the implementer agent", proxyLog, o.token);
    return outcome;
  }

  // The required gates on a copy of the round's commit, 20 minutes in all
  // (D-081). Returns the ones that failed.
  protected async gates(env: TaskEnv, taskId: string, round: number, quickRef: QuickRef | undefined, abort: AbortController, checkImage: boolean): Promise<GateFailure[]> {
    const { signal } = abort;
    const entries = quickRef?.entries.filter((e) => e.gate) ?? [];
    if (!entries.length && !checkImage) return [];
    // A fresh folder each time, removed afterwards: what a gate leaves can't
    // stop the next round (D-081).
    const base = path.join(this.deps.stateDir, "gates", taskId);
    removeQuietly(base, this.deps.log);
    const gatesDir = path.join(base, `round-${round}-${Date.now()}`);
    await this.worktrees.exportCommit(await this.worktrees.head(taskId), gatesDir);
    env.mounts.gates.worktree = gatesDir;
    const project = env.project("gates");
    const failures: GateFailure[] = [];
    try {
      // No proxy: the gates run the project's code, which needs no Claude.
      await this.start(project, env, undefined, signal);
      if (checkImage) {
        // In the gates' container (the copy, no session): an agent-written
        // entrypoint mustn't touch the worktree. No proxy is running.
        const capability = await this.capability.check(project, env.service, env.image, quickRef ? gatePrograms(quickRef) : [], signal, { proxy: false, session: false });
        signal.throwIfAborted();
        // Docker going away isn't the image's fault.
        if (!capability.ok) await this.deps.docker.ping();
        if (!capability.ok) return [{ label: "Check the agent image", commands: [], code: null, timedOut: false, output: capability.problems.join("\n") }];
      }
      // The budget starts once the services are up.
      const deadline = Date.now() + (this.deps.gatesTimeoutMs ?? GATES_TIMEOUT_MS);
      for (const entry of entries) {
        const remaining = deadline - Date.now();
        const failure = (code: number | null, timedOut: boolean, output: string): GateFailure => ({ label: entry.label, commands: entry.commands, code, timedOut, output });
        if (remaining <= 0) {
          failures.push(failure(null, true, "(not run: the gates' time was used up)"));
          continue;
        }
        this.deps.log(`${taskId}: gate ${entry.label}`);
        const result = await this.deps.run(
          "docker",
          [...project.composeArgs(), "run", "--rm", "-T", "--no-deps", env.service, "sh", "-ec", entry.commands.join("\n")],
          { cwd: path.dirname(gatesDir), env: project.env(), timeoutMs: remaining, signal },
        );
        signal.throwIfAborted();
        if (result.code !== 0 || result.timedOut) {
          const output = printable(`${result.stdout}\n${result.stderr}`).trim().split("\n").slice(-GATE_OUTPUT_LINES).join("\n").slice(-8_000);
          failures.push(failure(result.code, result.timedOut === true, output));
        }
      }
    } finally {
      await this.stop(project, taskId, false, signal);
      removeQuietly(base, this.deps.log);
    }
    return failures;
  }

  // The pipeline's reviewers, all at once, each fresh and read-only (D-082).
  protected async review(
    env: TaskEnv,
    task: Task,
    taskText: string,
    state: RoundState,
    reviewers: AgentDef[],
    decisions: string | undefined,
    quickRef: QuickRef | undefined,
    token: string,
    abort: AbortController,
  ): Promise<{ findings: Finding[] } | { question: string; asker: string }> {
    if (!reviewers.length) return { findings: [] };
    const { signal } = abort;
    const diff = await this.worktrees.branchDiff(task.id);
    const project = env.project("review");
    let outcomes: AgentOutcome[];
    let proxyLog: string[];
    try {
      await this.start(project, env, token, signal);
      const run = (agent: AgentDef) =>
        this.limited(abort, (inner) => {
          const options: AgentRun = {
            project,
            service: env.service,
            agent,
            role: "reviewer",
            systemPrompt: systemPrompt(agent, "reviewer", decisions, quickRef?.text),
            prompt: reviewerPrompt({ task, text: taskText, diff, round: state.round, previous: state.findings }),
            abort: inner,
            log: this.deps.log,
            stateDir: this.deps.stateDir,
          };
          return runAgent(options);
        });
      outcomes = await Promise.all(reviewers.map(run));
    } finally {
      proxyLog = await this.stop(project, task.id, true, signal);
    }
    signal.throwIfAborted();
    const findings: Finding[] = [];
    for (const [i, outcome] of outcomes.entries()) {
      const reviewer = reviewers[i]?.name ?? "a reviewer";
      if (outcome.question) return { question: outcome.question, asker: reviewer };
      if (outcome.error) this.failed(outcome, `the reviewer ${reviewer}`, proxyLog, token);
      if (outcome.findings === undefined) {
        findings.push({ severity: "blocking", summary: "the reviewer ended without calling report_findings, so its review is missing", reviewer });
      } else findings.push(...outcome.findings);
    }
    return { findings };
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

interface EnvDeps {
  task: Task;
  name: string;
  dir: string;
  mounts: Record<Variant, AgentMounts>;
  token: string;
  baseImage: string;
  proxyImage: string;
  notes: string[];
  // "Agents can't reach …" has been noted.
  warned: boolean;
}

interface ComposeSetup {
  composeRoot: string;
  composeFile: string;
  config: ComposeConfig;
  dev: string;
  services: string[];
}

// The image couldn't be built, or the agent's Compose setup can't be used.
interface BuildFailed {
  kind: "build-failed";
  output: string;
}

const NO_SUMMARY = "The implementer finished without a summary.";

// The agent can't fix a build it can't run in: the human fixes the branch,
// or retries the build.
function buildFailedOutcome(failed: BuildFailed, notes: string[]): RunOutcome {
  return { kind: "needs-human", reason: `the image couldn't be built (fix the task's branch, or mark it ready to try again): ${failed.output.split("\n").slice(-5).join(" ")}`, notes };
}

// The task came back from needs-decision with its questions answered.
function cameBackAnswered(task: Task): boolean {
  const last = [...task.statusEntries].reverse().find((e) => e.to === "in-implementation" || e.to === "needs-decision");
  return last?.from === "needs-decision" && last.to === "in-implementation";
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
