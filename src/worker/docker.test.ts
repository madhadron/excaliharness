import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { demux, DockerClient, DockerUnavailable, findSocket, ROLE_LABEL } from "./docker";

const IMAGE = `sha256:${"a".repeat(64)}`;

let dir: string;
let socket: string;
let server: http.Server;
let requests: { method: string; url: string; body: string }[];
// Upgraded sockets leave the server's bookkeeping, so close() would wait on them.
let upgraded: import("node:net").Socket[];

function frame(stream: number, text: string): Buffer {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "docker-"));
  socket = path.join(dir, "docker.sock");
  requests = [];
  upgraded = [];
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", body });
      const url = req.url ?? "";
      if (url === "/_ping") return res.end("OK");
      if (url.startsWith("/images/missing")) return res.writeHead(404).end('{"message":"no such image"}');
      if (url.startsWith("/images/")) return res.end(JSON.stringify({ Id: IMAGE, Config: { Labels: { a: "b" } } }));
      if (url === "/containers/create") return res.writeHead(201).end('{"Id":"c1"}');
      if (url.startsWith("/containers/json")) return res.end('[{"Id":"old1"},{"Id":"old2"}]');
      if (url.startsWith("/containers/slow")) return; // Never answers.
      if (url.endsWith("/wait")) return res.end('{"StatusCode":3}');
      if (url.includes("/logs")) return res.end(Buffer.concat([frame(1, "out "), frame(2, "err")]));
      if (url.startsWith("/containers/gone")) return res.writeHead(404).end();
      if (url.startsWith("/containers/broken")) return res.writeHead(500).end("boom");
      res.writeHead(204).end();
    });
  });
  // Attach: answer the upgrade and echo what is written.
  server.on("upgrade", (_req, sock: import("node:net").Socket) => {
    upgraded.push(sock);
    sock.write("HTTP/1.1 101 UPGRADED\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\nhello ");
    sock.on("data", (d: Buffer) => sock.write(d));
  });
  await new Promise<void>((r) => server.listen(socket, r));
});

afterEach(async () => {
  for (const sock of upgraded) sock.destroy();
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("findSocket", () => {
  it("prefers a unix DOCKER_HOST, then the usual places", () => {
    expect(findSocket({ DOCKER_HOST: "unix:///custom.sock" }, () => false)).toBe("/custom.sock");
    expect(findSocket({ DOCKER_HOST: "tcp://host:2375" }, (p) => p === "/var/run/docker.sock")).toBe("/var/run/docker.sock");
    expect(findSocket({}, (p) => p.endsWith(path.join(".docker", "run", "docker.sock")))).toMatch(/\.docker\/run\/docker\.sock$/);
    expect(findSocket({}, () => false)).toBeUndefined();
  });
});

describe("DockerClient", () => {
  it("pings, and reports a missing daemon as DockerUnavailable", async () => {
    await new DockerClient(socket).ping();
    const missing = new DockerClient(path.join(dir, "nope.sock")).ping();
    await expect(missing).rejects.toBeInstanceOf(DockerUnavailable);
    await expect(missing).rejects.toMatchObject({ code: "docker-unavailable" });
  });

  it("inspects images and returns undefined for a missing one", async () => {
    const docker = new DockerClient(socket);
    await expect(docker.inspectImage("missing:tag")).resolves.toBeUndefined();
    await expect(docker.inspectImage("excaliharness-agent-base:abc")).resolves.toMatchObject({ Id: IMAGE });
  });

  it("creates hardened containers only from image IDs", async () => {
    const docker = new DockerClient(socket);
    await expect(docker.createContainer({ image: "node:22", cmd: ["x"], tty: false, role: "t" })).rejects.toThrow(/not an image ID/);
    expect(requests).toEqual([]);
    await expect(docker.createContainer({ image: IMAGE, cmd: ["claude", "setup-token"], tty: true, env: ["A=1"], role: "sign-in", noLogs: true, autoRemove: true })).resolves.toBe("c1");
    const body = JSON.parse(requests[0]?.body ?? "{}") as Record<string, unknown>;
    // Literal values, so a weakened constant would fail here (D-056).
    expect(body).toMatchObject({
      Image: IMAGE,
      User: "1000:1000",
      Tty: true,
      Labels: { [ROLE_LABEL]: "sign-in" },
      HostConfig: {
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        ReadonlyRootfs: true,
        Privileged: false,
        Binds: [],
        Mounts: [],
        IpcMode: "private",
        PidsLimit: 256,
        AutoRemove: true,
        LogConfig: { Type: "none" },
      },
    });
    const tmpfs = (body.HostConfig as { Tmpfs: Record<string, string> }).Tmpfs;
    expect(Object.keys(tmpfs).sort()).toEqual(["/home/node", "/tmp"]);
    for (const options of Object.values(tmpfs)) expect(options).toMatch(/noexec.*nosuid.*nodev.*size=/);
    expect(body.Env).toContain("A=1");
  });

  it("attaches to a container as a two-way stream", async () => {
    const { stream, head } = await new DockerClient(socket).attach("c1");
    let seen = head.toString();
    stream.on("data", (d: Buffer) => (seen += d.toString()));
    stream.write("world");
    const until = Date.now() + 2_000;
    while (seen !== "hello world" && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(seen).toBe("hello world");
    stream.destroy();
  });

  it("waits, reads demultiplexed logs, and treats removing a gone container as done", async () => {
    const docker = new DockerClient(socket);
    await expect(docker.wait("c1")).resolves.toBe(3);
    await expect(docker.logs("c1")).resolves.toBe("out err");
    await expect(docker.remove("gone")).resolves.toBeUndefined();
    await expect(docker.start("broken")).rejects.toThrow(/500 boom/);
  });

  it("lists containers by role", async () => {
    await expect(new DockerClient(socket).containersWithRole("sign-in")).resolves.toEqual(["old1", "old2"]);
    expect(decodeURIComponent(requests[0]?.url ?? "")).toContain(`"label":["${ROLE_LABEL}=sign-in"]`);
  });

  it("gives up on a daemon that doesn't answer", async () => {
    const docker = new DockerClient(socket) as unknown as { request: (m: string, p: string, b?: unknown, ok?: number[], t?: number) => Promise<unknown> };
    await expect(docker.request("POST", "/containers/slow/start", undefined, [], 100)).rejects.toThrow(/no answer/);
  });
});

describe("demux", () => {
  it("joins frames and ignores a truncated tail", () => {
    expect(demux(Buffer.concat([frame(1, "a"), frame(2, "b"), Buffer.from([1, 0, 0])]))).toBe("ab");
  });
});
