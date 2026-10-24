// Orchestrator worker entry point, started by the extension with fork() and
// the repo root as its argument.
import * as fs from "node:fs";
import { Orchestrator } from "./orchestrator";
import { dispatch, type Notification, type Response } from "./protocol";

const root = process.argv[2];
if (!process.send || !root || !fs.existsSync(root)) {
  console.error("usage: worker.js <repo root>, started by the extension with an IPC channel");
  process.exit(1);
}

// A send error means the extension is gone; exit as on disconnect.
const send = (message: Response | Notification) =>
  process.send?.(message, (error: Error | null) => {
    if (error) process.exit(0);
  });

const orchestrator = new Orchestrator(root, {
  notify: send,
  log: (line) => console.log(line),
});

process.on("message", (message: unknown) => {
  void dispatch(message, {
    ping: () => "pong",
    "tasks/list": () => orchestrator.list(),
    "tasks/setStatus": (params) => orchestrator.setStatus(params),
  }).then((response) => response && send(response));
});

const shutdown = () => {
  orchestrator.stop();
  process.exit(0);
};
// The extension went away (window closed or extension host crashed).
process.on("disconnect", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => orchestrator.stop());

orchestrator.start().catch((error: unknown) => {
  console.error(`orchestrator failed to start: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  process.exit(1);
});
