// Throwaway check (D-019 exception): runs the real SignInService against the
// real Docker daemon and submits a wrong code. "invalid" means the CLI read
// the code from its terminal. No token is created.
import { BaseImage } from "../../src/worker/agentImage";
import { DockerClient } from "../../src/worker/docker";
import { SignInService } from "../../src/worker/signIn";

const docker = new DockerClient("/var/run/docker.sock");
const log = (line: string) => console.log(`log: ${line}`);
const service = new SignInService({
  docker,
  image: new BaseImage("agent-image/Dockerfile", docker, "/var/run/docker.sock", log),
  log,
  notify: (n) => {
    if (n.method === "progress") console.log(`progress: ${n.params.message}`);
    if (n.method !== "auth/prompt") return;
    console.log(`prompt for attempt ${n.params.attempt} (host ${new URL(n.params.url).host})`);
    // Long and shaped like a real code, so it exercises paste handling (E-004).
    void service.submitCode(n.params.attempt, `${"x".repeat(60)}#${"y".repeat(31)}`).then(
      (outcome) => {
        console.log(`RESULT: ${outcome}`);
        service.cancel();
      },
      (error: unknown) => console.log(`submit error: ${String(error)}`),
    );
  },
});
service.signIn().catch((error: unknown) => console.log(`signIn ended: ${String(error)}`));
