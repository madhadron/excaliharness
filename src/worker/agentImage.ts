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

export interface ImageOptions {
  // The tag's name part; the tag is <name>:<12 hex digits of the hash>.
  name?: string;
  // Files the build needs beside the Dockerfile, by their name in the build
  // context. They count toward the hash, so a change rebuilds the image.
  contextFiles?: Record<string, string>;
  // Where the built image's ID is kept. With it, the image is found by that
  // ID only, never by its tag, which anything on the daemon could replace
  // (D-079).
  idFile?: string;
}

// An image the extension builds from files it ships: the base agent image
// (D-024) and the egress proxy (D-066). Identified by ID, never pulled (D-052).
export class BaseImage {
  private inflight: Promise<string> | undefined;
  private readonly name: string;
  private readonly contextFiles: Record<string, string>;
  private readonly idFile: string | undefined;

  constructor(
    private readonly dockerfile: string,
    private readonly docker: Pick<DockerClient, "inspectImage">,
    // The daemon the API client talks to; the build must go to the same one.
    private readonly socket: string,
    private readonly log: (line: string) => void,
    private readonly exec: Exec = execCommand,
    options: ImageOptions = {},
  ) {
    this.name = options.name ?? "excaliharness-agent-base";
    this.contextFiles = options.contextFiles ?? {};
    this.idFile = options.idFile;
  }

  // The image ID of an image built from the current Dockerfile, building it
  // if needed. Concurrent calls share one build.
  ensure(onBuilding?: () => void): Promise<string> {
    this.inflight ??= this.find(onBuilding).finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async find(onBuilding?: () => void): Promise<string> {
    const digest = createHash("sha256").update(fs.readFileSync(this.dockerfile));
    for (const [name, source] of Object.entries(this.contextFiles).sort(([a], [b]) => a.localeCompare(b))) {
      digest.update(`\0${name}\0`).update(fs.readFileSync(source));
    }
    const hash = digest.digest("hex");
    const tag = `${this.name}:${hash.slice(0, 12)}`;
    const known = this.idFile ? this.readId(hash) : tag;
    const existing = known ? await this.docker.inspectImage(known) : undefined;
    if (existing && existing.Config?.Labels?.[DOCKERFILE_LABEL] === hash && IMAGE_ID.test(existing.Id)) return existing.Id;
    if (existing) this.log(`${known ?? tag} exists but wasn't built from this Dockerfile; rebuilding it`);

    onBuilding?.();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "excaliharness-build-"));
    const iidfile = path.join(dir, "iid");
    // With extra files, the context is a fresh directory holding just them.
    let context = path.dirname(this.dockerfile);
    if (Object.keys(this.contextFiles).length > 0) {
      context = path.join(dir, "context");
      fs.mkdirSync(context);
      for (const [name, source] of Object.entries(this.contextFiles)) fs.copyFileSync(source, path.join(context, name));
    }
    try {
      this.log(`building ${tag}`);
      await this.exec(
        "docker",
        ["-H", `unix://${this.socket}`, "build", "--pull=false", "--iidfile", iidfile, "--label", `${DOCKERFILE_LABEL}=${hash}`, "-t", tag, "-f", this.dockerfile, context],
        (line) => this.log(`[build] ${line}`),
      );
      const id = fs.readFileSync(iidfile, "utf8").trim();
      if (!IMAGE_ID.test(id)) throw new Error(`docker build wrote an unexpected image ID: "${id.slice(0, 80)}"`);
      const built = await this.docker.inspectImage(id);
      if (built?.Config?.Labels?.[DOCKERFILE_LABEL] !== hash) throw new Error("the built image doesn't carry the expected label");
      this.log(`built ${tag} as ${id}`);
      if (this.idFile) {
        fs.mkdirSync(path.dirname(this.idFile), { recursive: true });
        fs.writeFileSync(this.idFile, JSON.stringify({ hash, id }));
      }
      return id;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // The ID recorded for this hash, if any.
  private readId(hash: string): string | undefined {
    try {
      const saved = JSON.parse(fs.readFileSync(this.idFile ?? "", "utf8")) as { hash?: unknown; id?: unknown };
      return saved.hash === hash && typeof saved.id === "string" && IMAGE_ID.test(saved.id) ? saved.id : undefined;
    } catch {
      return undefined;
    }
  }
}
