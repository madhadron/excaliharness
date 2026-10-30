// Orchestrator worker entry point, started by the extension with fork(), with
// the repo root, the base agent image's Dockerfile, the state folder and the
// parallel-task limit as arguments.
import * as fs from "node:fs";
import * as path from "node:path";
import { BaseImage } from "./agentImage";
import { DockerClient, DockerUnavailable, findSocket } from "./docker";
import { Orchestrator } from "./orchestrator";
import { dispatch, type Notification, type Response } from "./protocol";
import { run } from "./runner/exec";
import { TaskRunner } from "./runner/runner";
import { Worktrees } from "./runner/worktree";
import { Reviews } from "./review";
import { SignInService } from "./signIn";

const root = process.argv[2];
const dockerfile = process.argv[3];
// The extension's per-workspace storage: generated Compose files, sessions,
// capability results. Outside the repository (D-059).
const stateDir = process.argv[4];
// Given at start so the first pass already uses it; settings/update changes it.
const maxParallelTasks = Number(process.argv[5] ?? "2");
if (!process.send || !root || !fs.existsSync(root) || !dockerfile || !stateDir) {
  console.error("usage: worker.js <repo root> <agent Dockerfile> <state dir> [max parallel tasks], started by the extension with an IPC channel");
  process.exit(1);
}

// A send error means the extension is gone; exit as on disconnect.
// While shutting down, a failed send is expected and mustn't cut the wait
// for tasks to clean up short.
let shuttingDown = false;
const send = (message: Response | Notification) =>
  process.send?.(message, (error: Error | null) => {
    if (error && !shuttingDown) process.exit(0);
  });

const log = (line: string) => console.log(line);

// The token, held in memory only (D-050). Without one, the extension is asked
// to sign in, at most once every 10 minutes unless a token arrives.
let token: string | undefined;
const waiting = new Set<(t: string) => void>();
let askedAt = 0;
const SIGN_IN_WAIT_MS = 15 * 60_000;
const getToken = (): Promise<string> => {
  if (token) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    waiting.add(resolve);
    if (Date.now() - askedAt > 10 * 60_000) {
      askedAt = Date.now();
      send({ method: "auth/required", params: {} });
    }
    setTimeout(() => {
      waiting.delete(resolve);
      reject(new Error("not signed in to Claude"));
    }, SIGN_IN_WAIT_MS).unref();
  });
};
// Claude rejected the token (expired or revoked): forget it and ask for a
// new sign-in straight away (D-079).
// Only if it is still the current token: another round may have failed with
// an old one after a new sign-in.
const tokenRejected = (rejected: string) => {
  if (token !== rejected) return;
  token = undefined;
  askedAt = 0;
};

const socket = findSocket();
const runnerDocker = socket ? new DockerClient(socket) : undefined;
const workerDir = path.dirname(process.argv[1] ?? "");
const runner =
  socket && runnerDocker
    ? new TaskRunner({
        root,
        stateDir,
        socket,
        docker: runnerDocker,
        run,
        baseImage: new BaseImage(dockerfile, runnerDocker, socket, log, undefined, { idFile: path.join(stateDir, "images", "agent-base.json") }),
        proxyImage: new BaseImage(path.join(path.dirname(dockerfile), "proxy", "Dockerfile"), runnerDocker, socket, log, undefined, {
          name: "excaliharness-egress-proxy",
          contextFiles: { "proxy.js": path.join(workerDir, "proxy.js") },
          idFile: path.join(stateDir, "images", "egress-proxy.json"),
        }),
        token: getToken,
        tokenRejected,
        log,
      })
    : undefined;
if (!runner) log("no Docker socket found; tasks won't run until the window is reloaded with Docker running");
// Reviews need only git, so they work without Docker and in a read-only
// window.
const reviews = new Reviews(new Worktrees(run, root, path.join(stateDir, "worktrees"), log), path.join(stateDir, "review"), log);
const orchestrator = new Orchestrator(root, {
  notify: (notification) => {
    send(notification);
    // Base copies are kept only while the task can be reviewed.
    if (notification.method === "tasks/changed") {
      reviews.sweep(new Set(notification.params.tasks.filter((t) => t.status === "review" || t.status === "needs-human").map((t) => t.id)));
    }
  },
  log,
  ...(runner ? { runner } : {}),
  ...(Number.isInteger(maxParallelTasks) && maxParallelTasks >= 1 ? { maxParallelTasks } : {}),
});

// Docker is looked up afresh for each sign-in, so starting Docker after the
// extension just works. `signIn` is the service of the current (or last) one.
let signIn: SignInService | undefined;
// One BaseImage per daemon, so concurrent users of it share one build.
const images = new Map<string, BaseImage>();
const startSignIn = (): Promise<{ token: string }> => {
  if (signIn?.isRunning) return Promise.reject(new Error("a sign-in is already in progress"));
  const socket = findSocket();
  if (!socket) return Promise.reject(new DockerUnavailable("no Docker socket found"));
  const docker = new DockerClient(socket);
  let image = images.get(socket);
  if (!image) {
    image = new BaseImage(dockerfile, docker, socket, log, undefined, { idFile: path.join(stateDir, "images", "agent-base.json") });
    images.set(socket, image);
  }
  signIn = new SignInService({ docker, image, notify: send, log });
  return signIn.signIn();
};

process.on("message", (message: unknown) => {
  void dispatch(message, {
    ping: () => "pong",
    "tasks/list": () => orchestrator.list(),
    "tasks/setStatus": (params) => orchestrator.setStatus(params),
    "auth/signIn": startSignIn,
    "auth/submitCode": ({ attempt, code }) => {
      if (!signIn) throw new Error("no sign-in is in progress");
      return signIn.submitCode(attempt, code);
    },
    "auth/cancel": (params) => signIn?.cancel(params?.attempt),
    "auth/setToken": ({ token: next }) => {
      token = next;
      for (const resolve of waiting) resolve(next);
      waiting.clear();
    },
    "settings/update": ({ maxParallelTasks }) => orchestrator.setMaxParallelTasks(maxParallelTasks),
    "review/prepare": async ({ id }) => {
      const refusal = await orchestrator.reviewRefusal(id);
      if (refusal) throw new Error(refusal);
      return reviews.prepare(id);
    },
  }).then((response) => response && send(response));
});

// Stops running tasks and waits for them to stop their containers, and
// removes sign-in containers (they may hold the token), then exits; never
// waits more than SHUTDOWN_MS (D-079).
// Longer than an aborted command's grace period plus a `compose down`.
const SHUTDOWN_MS = 30_000;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  setTimeout(() => process.exit(0), SHUTDOWN_MS + 1_000).unref();
  void Promise.allSettled([orchestrator.shutdown(SHUTDOWN_MS), signIn?.shutdown() ?? Promise.resolve()]).finally(() => process.exit(0));
};
// The extension went away (window closed or extension host crashed).
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => orchestrator.stop());

orchestrator.start().catch((error: unknown) => {
  console.error(`orchestrator failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
