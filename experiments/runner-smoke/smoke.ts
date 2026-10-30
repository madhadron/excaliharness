// Throwaway (D-019 exception): the real Orchestrator and TaskRunner on a
// stand-in target repo, against the real Docker daemon, with a fake token. A
// full run of unit A ends with Claude rejecting the token (a 401), T-001
// still in-implementation, and no containers left. A fake leftover project is
// started first, to check the sweep stops it.
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { BaseImage } from "../../src/worker/agentImage";
import { DockerClient } from "../../src/worker/docker";
import { Orchestrator } from "../../src/worker/orchestrator";
import { run } from "../../src/worker/runner/exec";
import { projectPrefix } from "../../src/worker/runner/compose";
import { TaskRunner } from "../../src/worker/runner/runner";

const [repo, work] = [process.argv[2] ?? "", process.argv[3] ?? ""];
const root = path.join(work, "repo");
const socket = "/var/run/docker.sock";
const docker = new DockerClient(socket);
const log = (line: string) => console.log(`log: ${line.slice(0, 220)}`);
let rejected = false;
const runner = new TaskRunner({
  root,
  stateDir: path.join(work, "state"),
  socket,
  docker,
  run,
  baseImage: new BaseImage(path.join(repo, "agent-image/Dockerfile"), docker, socket, log),
  proxyImage: new BaseImage(path.join(repo, "agent-image/proxy/Dockerfile"), docker, socket, log, undefined, {
    name: "excaliharness-egress-proxy",
    contextFiles: { "proxy.js": path.join(repo, "dist/proxy.js") },
  }),
  // real-token.sh passes a real token in the environment; it is never printed.
  token: () => Promise.resolve(process.env.EXCALIHARNESS_SMOKE_TOKEN || "sk-ant-oat01-fake-token-for-the-smoke-test"),
  tokenRejected: (_token: string) => {
    rejected = true;
    log("TOKEN REJECTED");
  },
  log,
});
const orchestrator = new Orchestrator(root, {
  notify: (n) => {
    if (n.method === "task/attention") console.log(`ATTENTION: ${n.params.id} ${n.params.status}`);
  },
  log,
  watch: false,
  runner,
});
const status = () => /^\* status: (\S+)/m.exec(fs.readFileSync(path.join(root, "tasks/T-001.md"), "utf8"))?.[1];
const leftover = `${projectPrefix(root)}t-999`;
const containers = (prefix: string) => execFileSync("docker", ["ps", "-a", "--format", "{{.Names}} {{.Label \"com.docker.compose.project\"}}"], { encoding: "utf8" }).split("\n").filter((l) => l.includes(prefix));
(async () => {
  const file = path.join(work, "leftover.yaml");
  fs.writeFileSync(file, `services:\n  x:\n    image: "${process.argv[4] ?? ""}"\n    pull_policy: never\n    command: ["sleep", "600"]\n`);
  execFileSync("docker", ["compose", "-p", leftover, "-f", file, "up", "-d"], { stdio: "ignore" });
  fs.rmSync(file);
  console.log(`leftover before: ${containers(leftover).length}`);
  await orchestrator.start();
  const until = Date.now() + 15 * 60_000;
  while (Date.now() < until && !rejected && !["needs-human", "review", "needs-decision"].includes(status() ?? "")) {
    await new Promise((r) => setTimeout(r, 2_000));
    await orchestrator.runPass();
  }
  // Lets the round's cleanup (compose down) finish.
  await orchestrator.shutdown(60_000);
  console.log(`FINAL STATUS: ${status()} rejected=${rejected}`);
  console.log(`leftover after: ${containers(leftover).length}`);
  console.log(`task containers after: ${containers(projectPrefix(root)).length}`);
  console.log(fs.readFileSync(path.join(root, "tasks/T-001.md"), "utf8").split("## Updates")[1]?.trim());
  process.exit(0);
})();
