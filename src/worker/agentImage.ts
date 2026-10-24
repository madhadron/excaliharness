// Builds the base agent image from the Dockerfile shipped in the extension
// (D-024, D-029) and identifies it by ID, never by name (D-052).
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createInterface } from "node:readline";
import { IMAGE_ID, type DockerClient } from "./docker";

export const DOCKERFILE_LABEL = "org.excaliharness.dockerfile-sha256";
const BUILD_TIMEOUT_MS = 20 * 60_000;

export type Exec = (command: string, args: string[], onLine: (line: string) => void) => Promise<void>;

// Runs a command without a shell, streaming its output line by line.
// Docker contexts and buildx builders could send the build to a different
// daemon than the one containers run on, so they're cleared.
export const execCommand: Exec = (command, args, onLine) =>
  new Promise((resolve, reject) => {
    const env = { ...process.env };
    for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "BUILDX_BUILDER"]) delete env[key];
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: BUILD_TIMEOUT_MS, env });
    const tail: string[] = [];
    const take = (line: string) => {
      tail.push(line);
      if (tail.length > 20) tail.shift();
      onLine(line);
    };
    createInterface({ input: child.stdout }).on("line", take);
    createInterface({ input: child.stderr }).on("line", take);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args[0] ?? ""} failed (${signal ?? `exit ${code}`}):\n${tail.join("\n")}`));
    });
  });

export class BaseImage {
  private inflight: Promise<string> | undefined;

  constructor(
    private readonly dockerfile: string,
    private readonly docker: Pick<DockerClient, "inspectImage">,
    // The daemon the API client talks to; the build must go to the same one.
    private readonly socket: string,
    private readonly log: (line: string) => void,
    private readonly exec: Exec = execCommand,
  ) {}

  // The image ID of an image built from the current Dockerfile, building it
  // if needed. Concurrent calls share one build.
  ensure(onBuilding?: () => void): Promise<string> {
    this.inflight ??= this.find(onBuilding).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async find(onBuilding?: () => void): Promise<string> {
    const hash = createHash("sha256").update(fs.readFileSync(this.dockerfile)).digest("hex");
    const tag = `excaliharness-agent-base:${hash.slice(0, 12)}`;
    const existing = await this.docker.inspectImage(tag);
    if (existing && existing.Config?.Labels?.[DOCKERFILE_LABEL] === hash && IMAGE_ID.test(existing.Id)) return existing.Id;
    if (existing) this.log(`${tag} exists but wasn't built from this Dockerfile; rebuilding it`);

    onBuilding?.();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excaliharness-build-"));
    const iidfile = path.join(dir, "iid");
    try {
      this.log(`building ${tag}`);
      await this.exec(
        "docker",
        ["-H", `unix://${this.socket}`, "build", "--pull=false", "--iidfile", iidfile, "--label", `${DOCKERFILE_LABEL}=${hash}`, "-t", tag, "-f", this.dockerfile, path.dirname(this.dockerfile)],
        (line) => this.log(`[build] ${line}`),
      );
      const id = fs.readFileSync(iidfile, "utf8").trim();
      if (!IMAGE_ID.test(id)) throw new Error(`docker build wrote an unexpected image ID: "${id.slice(0, 80)}"`);
      const built = await this.docker.inspectImage(id);
      if (built?.Config?.Labels?.[DOCKERFILE_LABEL] !== hash) throw new Error("the built image doesn't carry the expected label");
      this.log(`built ${tag} as ${id}`);
      return id;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
}
