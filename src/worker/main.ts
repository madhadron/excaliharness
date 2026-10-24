// Orchestrator worker entry point, started by the extension with fork(), with
// the repo root and the base agent image's Dockerfile as arguments.
import * as fs from "node:fs";
import { BaseImage } from "./agentImage";
import { DockerClient, DockerUnavailable, findSocket } from "./docker";
import { Orchestrator } from "./orchestrator";
import { dispatch, type Notification, type Response } from "./protocol";
import { SignInService } from "./signIn";

const root = process.argv[2];
const dockerfile = process.argv[3];
if (!process.send || !root || !fs.existsSync(root) || !dockerfile) {
  console.error("usage: worker.js <repo root> <agent Dockerfile>, started by the extension with an IPC channel");
  process.exit(1);
}

// A send error means the extension is gone; exit as on disconnect.
const send = (message: Response | Notification) =>
  process.send?.(message, (error: Error | null) => {
    if (error) process.exit(0);
  });

const log = (line: string) => console.log(line);
const orchestrator = new Orchestrator(root, { notify: send, log });

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
    image = new BaseImage(dockerfile, docker, socket, log);
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
  }).then((response) => response && send(response));
});

// Removes sign-in containers (they may hold the token) before exiting, but
// never waits more than a few seconds.
const shutdown = () => {
  orchestrator.stop();
  void (signIn?.shutdown() ?? Promise.resolve()).finally(() => process.exit(0));
};
// The extension went away (window closed or extension host crashed).
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => orchestrator.stop());

orchestrator.start().catch((error: unknown) => {
  console.error(`orchestrator failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
