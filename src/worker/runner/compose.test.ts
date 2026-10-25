import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findDevService,
  findProjectFiles,
  generateOverride,
  imageRefusals,
  infrastructureCompose,
  INTERNAL_NETWORK,
  projectName,
  projectPrefix,
  PROXY_SERVICE,
  refusals,
  type ComposeConfig,
} from "./compose";
import { override, reset, toYaml } from "./yaml";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "compose-"));
  fs.mkdirSync(path.join(root, "tasks"));
  fs.writeFileSync(path.join(root, "TASKS.md"), "# Tasks\n");
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

// Shaped like `docker compose config --format json` output (E-007).
const config = (): ComposeConfig => ({
  services: {
    dev: { build: { context: root, dockerfile: "Dockerfile" }, networks: { default: null } },
    db: { image: "postgres:17", networks: { default: null } },
    cache: { image: "redis:8", networks: { backend: { aliases: ["c"] } } },
    sidecar: { image: "x", network_mode: "service:db" },
  },
});

describe("yaml", () => {
  it("writes tags, quoted keys and scalars, and empty collections inline", () => {
    expect(toYaml({ a: reset(null), b: override(["x", "y"]), c: { d: true, e: 2 }, f: [], g: {} })).toBe(
      ['"a": !reset null', '"b": !override', '  - "x"', '  - "y"', '"c":', '  "d": true', '  "e": 2', '"f": []', '"g": {}', ""].join("\n"),
    );
  });

  it("quotes strings so nothing in them is read as YAML syntax", () => {
    expect(toYaml({ k: "a: b # c\n- d" })).toBe('"k": "a: b # c\\n- d"\n');
  });
});

describe("findProjectFiles", () => {
  it("needs a root Dockerfile and a Compose file (D-058)", () => {
    expect(findProjectFiles(root)).toEqual({ ok: false, missing: ["Dockerfile", expect.stringMatching(/^a Compose file/) as unknown] });
    fs.writeFileSync(path.join(root, "Dockerfile"), "FROM x\n");
    fs.writeFileSync(path.join(root, "docker-compose.yml"), "services: {}\n");
    expect(findProjectFiles(root)).toEqual({ ok: true, compose: "docker-compose.yml" });
  });
});

describe("findDevService", () => {
  it("picks the one service built from the root Dockerfile (D-063)", () => {
    expect(findDevService(config(), root)).toEqual({ ok: true, name: "dev" });
  });

  it("refuses none or more than one", () => {
    const none = config();
    delete none.services.dev;
    expect(findDevService(none, root)).toMatchObject({ ok: false, error: expect.stringMatching(/no Compose service/) as unknown });
    const two = config();
    two.services.other = { build: { context: root } };
    expect(findDevService(two, root)).toMatchObject({ ok: false, error: expect.stringMatching(/more than one/) as unknown });
    const elsewhere = config();
    elsewhere.services.dev = { build: { context: path.join(root, "sub") } };
    expect(findDevService(elsewhere, root).ok).toBe(false);
  });
});

describe("refusals", () => {
  it.each([
    [{ privileged: true }, /privileged/],
    [{ cap_add: ["SYS_ADMIN"] }, /adds capabilities/],
    [{ devices: ["/dev/kvm"] }, /devices/],
    [{ network_mode: "host" }, /network_mode/],
    [{ network_mode: "none" }, /network_mode/],
    [{ pid: "host" }, /host's pid/],
    [{ ipc: "service:db" }, /another container's ipc/],
    [{ cgroup: "host" }, /host's cgroup/],
    [{ uts: "host" }, /host's uts/],
    [{ volumes: [{ type: "bind", source: "/var/run/docker.sock", target: "/var/run/docker.sock" }] }, /Docker socket/],
    [{ volumes: [{ type: "bind", source: "/Users/fred/.ssh", target: "/root/.ssh" }] }, /outside the repository/],
  ])("refuses %j", (service, message) => {
    expect(refusals(service, root).join(" ")).toMatch(message);
  });

  it("refuses images named like ours on any service (D-079)", () => {
    const c = config();
    c.services.db = { image: "excaliharness-egress-proxy:abc" };
    expect(imageRefusals(c).join(" ")).toMatch(/db service .* reserved/);
    expect(imageRefusals(config())).toEqual([]);
  });

  it("accepts mounts inside the repository and named volumes", () => {
    expect(refusals({ volumes: [{ type: "bind", source: root, target: "/app" }, { type: "volume", source: "data", target: "/data" }] }, root)).toEqual([]);
  });
});

describe("generateOverride", () => {
  const worktree = () => path.join(root, ".excaliharness", "worktrees", "T-1");
  const base = () => ({ config: config(), devService: "dev", proxyImage: `sha256:${"p".repeat(64)}`, root, project: "excaliharness-abcd1234-t-1", emptyFile: "/state/empty" });
  const generate = () => generateOverride({ ...base(), devImage: `sha256:${"d".repeat(64)}`, worktree: worktree() });

  it("locks down the dev service", () => {
    const { yaml } = generate();
    for (const line of [
      '"build": !reset null',
      `"image": "sha256:${"d".repeat(64)}"`,
      '"pull_policy": "never"',
      '"cap_drop":',
      '"read_only": true',
      '"user": "1000:1000"',
      '"env_file": !reset []',
      '"volumes_from": !reset []',
      '"secrets": !reset []',
      '"init": true',
      '"environment": !override',
      '"ports": !reset []',
      '"networks": !override',
      `  - "${INTERNAL_NETWORK}"`,
      '"volumes": !override',
      `- "${worktree()}:/workspace"`,
      `- "${path.join(root, "tasks")}:/workspace/tasks:ro"`,
      `- "${path.join(root, "TASKS.md")}:/workspace/TASKS.md:ro"`,
      // The agent never sees the worktree's .git file (D-079).
      '- "/state/empty:/workspace/.git:ro"',
      // The session volume is named per task (D-079).
      '"name": "excaliharness-abcd1234-t-1-session"',
    ]) {
      expect(yaml).toContain(line);
    }
    // Read-only paths that don't exist aren't mounted.
    expect(yaml).not.toContain("decisions.md");
  });

  it("copies each other service's networks and adds ours, so an implicit default isn't lost (E-007)", () => {
    const { yaml, unconnected } = generate();
    expect(yaml).toMatch(/"db":\n\s+"networks":\n\s+"default": null\n\s+"excaliharness-internal-network": null/);
    expect(yaml).toMatch(/"cache":\n\s+"networks":\n\s+"backend": null\n\s+"excaliharness-internal-network": null/);
    expect(unconnected).toEqual(["sidecar"]);
  });

  it("never writes the token; the proxy gets it from Compose's environment (D-066)", () => {
    const { yaml } = generate();
    expect(yaml).toContain(`"${PROXY_SERVICE}":`);
    expect(yaml).toContain('"EXCALIHARNESS_PROXY_TOKEN": "${EXCALIHARNESS_PROXY_TOKEN:-}"');
    expect(yaml).not.toMatch(/sk-ant-/);
  });

  it("escapes $ in paths so Compose doesn't interpolate them", () => {
    const odd = path.join(root, "a$b");
    const { yaml } = generateOverride({ ...base(), devImage: "sha256:x", worktree: odd });
    expect(yaml).toContain(`a$$b:/workspace`);
  });
});

describe("infrastructureCompose", () => {
  it("runs the base image with the same lockdown, without override tags", () => {
    const yaml = infrastructureCompose({ baseImage: "sha256:b", proxyImage: "sha256:p", root, worktree: "/w", project: "p", emptyFile: "/e" });
    expect(yaml).not.toMatch(/!reset|!override/);
    expect(yaml).toContain('"image": "sha256:b"');
    expect(yaml).toContain('"read_only": true');
    expect(yaml).toContain('- "/w:/workspace"');
  });
});

it("names projects per repository and task (D-061, D-079)", () => {
  expect(projectName("/repo/a", "T-007")).toMatch(/^excaliharness-[0-9a-f]{8}-t-007$/);
  expect(projectName("/repo/a", "T-007").startsWith(projectPrefix("/repo/a"))).toBe(true);
  expect(projectPrefix("/repo/a")).not.toBe(projectPrefix("/repo/b"));
});
