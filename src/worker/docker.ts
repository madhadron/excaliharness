// A minimal Docker Engine API client over the Unix socket, using Node
// built-ins only (D-051). It deliberately has no way to pull or create
// images, and creates containers only from image IDs (D-052).
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { Duplex } from "node:stream";

export class DockerUnavailable extends Error {
  // Sent to the extension with the error (D-055).
  readonly code = "docker-unavailable";
  constructor(detail: string) {
    super(`Docker isn't running or can't be reached (${detail})`);
    this.name = "DockerUnavailable";
  }
}

// DOCKER_HOST if it names a Unix socket, else the usual places.
export function findSocket(env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = fs.existsSync): string | undefined {
  const host = env.DOCKER_HOST;
  if (host?.startsWith("unix://")) return host.slice("unix://".length);
  const candidates = ["/var/run/docker.sock", path.join(os.homedir(), ".docker", "run", "docker.sock")];
  return candidates.find((p) => exists(p));
}

export interface ContainerSpec {
  // Must be an image ID (sha256:...), never a name that could be pulled.
  image: string;
  cmd: string[];
  env?: string[];
  tty: boolean;
  // What the container is for; also how leftovers are found and removed.
  role: string;
  // Keep no log on the daemon (for output that contains secrets).
  noLogs?: boolean;
  // Docker removes the container when it exits, even if the worker is gone.
  autoRemove?: boolean;
}

// Non-streaming calls give up after this, so a wedged daemon can't hang the
// worker (and its cleanup) forever.
const REQUEST_TIMEOUT_MS = 30_000;

// Every container the worker creates carries this label with its role.
export const ROLE_LABEL = "org.excaliharness.role";

const CONSOLE: [number, number] = [50, 1000];

// D-056: the container gets network access and nothing else, with limits so a
// misbehaving CLI can't exhaust the machine.
export const HARDENED_HOST_CONFIG = {
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges"],
  ReadonlyRootfs: true,
  Tmpfs: {
    "/home/node": "rw,noexec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=700",
    "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
  },
  Binds: [],
  Mounts: [],
  Privileged: false,
  IpcMode: "private",
  PidsLimit: 256,
  Memory: 1024 * 1024 * 1024,
  ConsoleSize: CONSOLE,
} as const;

export const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface ImageInfo {
  Id: string;
  Config?: { Labels?: Record<string, string> | null };
}

const isMissing = (error: unknown) => {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES" || code === "ENOTSOCK";
};

export class DockerClient {
  constructor(private readonly socket: string) {}

  async ping(): Promise<void> {
    await this.request("GET", "/_ping");
  }

  // Undefined if there is no such image.
  async inspectImage(ref: string): Promise<ImageInfo | undefined> {
    const result = await this.request("GET", `/images/${encodeURIComponent(ref)}/json`, undefined, [404]);
    return result.status === 404 ? undefined : (JSON.parse(result.body.toString("utf8")) as ImageInfo);
  }

  async createContainer(spec: ContainerSpec): Promise<string> {
    if (!IMAGE_ID.test(spec.image)) throw new Error(`refusing to create a container from "${spec.image}": not an image ID`);
    const body = {
      Image: spec.image,
      Cmd: spec.cmd,
      Env: ["TERM=xterm-256color", `COLUMNS=${CONSOLE[1]}`, `LINES=${CONSOLE[0]}`, ...(spec.env ?? [])],
      // Numeric, matching the tmpfs owner, so it doesn't depend on the image.
      User: "1000:1000",
      Labels: { [ROLE_LABEL]: spec.role },
      Tty: spec.tty,
      OpenStdin: spec.tty,
      StdinOnce: false,
      AttachStdin: spec.tty,
      AttachStdout: true,
      AttachStderr: true,
      NetworkDisabled: false,
      HostConfig: {
        ...HARDENED_HOST_CONFIG,
        ...(spec.noLogs ? { LogConfig: { Type: "none", Config: {} } } : {}),
        AutoRemove: spec.autoRemove ?? false,
      },
    };
    const result = await this.request("POST", "/containers/create", body);
    const { Id } = JSON.parse(result.body.toString("utf8")) as { Id: string };
    return Id;
  }

  // The container's terminal as a two-way stream (Tty containers only).
  attach(id: string): Promise<{ stream: Duplex; head: Buffer }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        socketPath: this.socket,
        path: `/containers/${encodeURIComponent(id)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
        method: "POST",
        headers: { Connection: "Upgrade", Upgrade: "tcp" },
      });
      req.on("upgrade", (_res, stream, head) => resolve({ stream, head }));
      req.on("response", (res) => {
        res.resume();
        reject(new Error(`attach: HTTP ${res.statusCode}`));
      });
      req.on("error", (error) => reject(isMissing(error) ? new DockerUnavailable(error.message) : error));
      req.end();
    });
  }

  async start(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/start`);
  }

  async resize(id: string): Promise<void> {
    await this.request("POST", `/containers/${encodeURIComponent(id)}/resize?h=${CONSOLE[0]}&w=${CONSOLE[1]}`);
  }

  // Blocks until the container exits, so it has no request timeout; callers
  // race it against their own deadline.
  async wait(id: string): Promise<number> {
    const result = await this.request("POST", `/containers/${encodeURIComponent(id)}/wait`, undefined, [], 0);
    return (JSON.parse(result.body.toString("utf8")) as { StatusCode: number }).StatusCode;
  }

  // Combined stdout and stderr of a non-Tty container.
  async logs(id: string): Promise<string> {
    const result = await this.request("GET", `/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1`);
    return demux(result.body);
  }

  // IDs of this worker's containers with the given role, running or not.
  async containersWithRole(role: string): Promise<string[]> {
    const filters = encodeURIComponent(JSON.stringify({ label: [`${ROLE_LABEL}=${role}`] }));
    const result = await this.request("GET", `/containers/json?all=1&filters=${filters}`);
    return (JSON.parse(result.body.toString("utf8")) as { Id: string }[]).map((c) => c.Id);
  }

  async remove(id: string): Promise<void> {
    await this.request("DELETE", `/containers/${encodeURIComponent(id)}?force=1`, undefined, [404]);
  }

  private request(
    method: string,
    urlPath: string,
    body?: unknown,
    okStatuses: number[] = [],
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<{ status: number; body: Buffer }> {
    if (urlPath.startsWith("/images/create") || urlPath.includes("/pull")) {
      return Promise.reject(new Error("the worker never pulls images (D-052)"));
    }
    return new Promise((resolve, reject) => {
      const req = http.request(
        { socketPath: this.socket, path: urlPath, method, headers: body ? { "Content-Type": "application/json" } : {} },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const status = res.statusCode ?? 0;
            const buffer = Buffer.concat(chunks);
            if (status < 300 || okStatuses.includes(status)) resolve({ status, body: buffer });
            else reject(new Error(`Docker ${method} ${urlPath.split("?")[0]} failed: ${status} ${buffer.toString("utf8").slice(0, 300)}`));
          });
          res.on("error", reject);
        },
      );
      req.on("error", (error) => reject(isMissing(error) ? new DockerUnavailable(error.message) : error));
      if (timeoutMs > 0) {
        req.setTimeout(timeoutMs, () => req.destroy(new DockerUnavailable(`no answer to ${method} ${urlPath.split("?")[0]} within ${timeoutMs / 1000} s`)));
      }
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  }
}

// Non-Tty output is multiplexed: an 8-byte header (stream, 0, 0, 0, size)
// before each frame.
export function demux(buffer: Buffer): string {
  let out = "";
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    const size = buffer.readUInt32BE(offset + 4);
    out += buffer.subarray(offset + 8, offset + 8 + size).toString("utf8");
    offset += 8 + size;
  }
  return out;
}
