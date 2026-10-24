import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BaseImage, DOCKERFILE_LABEL, type Exec } from "./agentImage";
import type { ImageInfo } from "./docker";

let dir: string;
let dockerfile: string;
let hash: string;
let images: Map<string, ImageInfo>;
let builds: string[][];

const id = (n: string) => `sha256:${n.repeat(64)}`;
const docker = { inspectImage: (ref: string) => Promise.resolve(images.get(ref)) };

// A fake `docker build`: records its arguments and "builds" an image with the
// label it was given.
const exec: Exec = (command, args) => {
  builds.push([command, ...args]);
  const iidfile = args[args.indexOf("--iidfile") + 1] ?? "";
  const label = args[args.indexOf("--label") + 1] ?? "";
  const tag = args[args.indexOf("-t") + 1] ?? "";
  const built = { Id: id("b"), Config: { Labels: { [label.split("=")[0] ?? ""]: label.split("=")[1] ?? "" } } };
  images.set(built.Id, built);
  images.set(tag, built);
  fs.writeFileSync(iidfile, `${built.Id}\n`);
  return new Promise((r) => setTimeout(r, 20));
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "image-"));
  dockerfile = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerfile, "FROM scratch\n");
  hash = createHash("sha256").update("FROM scratch\n").digest("hex");
  images = new Map();
  builds = [];
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const tag = () => `excaliharness-agent-base:${hash.slice(0, 12)}`;

describe("BaseImage", () => {
  it("reuses an image whose label matches the Dockerfile", async () => {
    images.set(tag(), { Id: id("a"), Config: { Labels: { [DOCKERFILE_LABEL]: hash } } });
    await expect(new BaseImage(dockerfile, docker, "/run/docker.sock", () => {}, exec).ensure()).resolves.toBe(id("a"));
    expect(builds).toEqual([]);
  });

  it.each([
    ["a different label", { Id: id("a"), Config: { Labels: { [DOCKERFILE_LABEL]: "other" } } }],
    ["no labels", { Id: id("a"), Config: { Labels: null } }],
    ["no image", undefined],
  ])("builds when the tag has %s, never pulling, and returns the built ID", async (_name, existing) => {
    if (existing) images.set(tag(), existing);
    let building = 0;
    await expect(new BaseImage(dockerfile, docker, "/run/docker.sock", () => {}, exec).ensure(() => building++)).resolves.toBe(id("b"));
    expect(building).toBe(1);
    const args = builds[0] ?? [];
    expect(args.slice(0, 5)).toEqual(["docker", "-H", "unix:///run/docker.sock", "build", "--pull=false"]);
    expect(args).toContain(`${DOCKERFILE_LABEL}=${hash}`);
    expect(args.join(" ")).not.toMatch(/\bpull\b(?!=false)/);
  });

  it("shares one build between concurrent callers", async () => {
    const image = new BaseImage(dockerfile, docker, "/run/docker.sock", () => {}, exec);
    const ids = await Promise.all([image.ensure(), image.ensure(), image.ensure()]);
    expect(ids).toEqual([id("b"), id("b"), id("b")]);
    expect(builds).toHaveLength(1);
  });

  it("refuses a build whose result doesn't carry the label", async () => {
    const unlabeled: Exec = (_c, args) => {
      images.set(id("c"), { Id: id("c"), Config: { Labels: {} } });
      fs.writeFileSync(args[args.indexOf("--iidfile") + 1] ?? "", id("c"));
      return Promise.resolve();
    };
    await expect(new BaseImage(dockerfile, docker, "/run/docker.sock", () => {}, unlabeled).ensure()).rejects.toThrow(/expected label/);
  });

  it("refuses an image ID that isn't sha256", async () => {
    const odd: Exec = (_c, args) => {
      fs.writeFileSync(args[args.indexOf("--iidfile") + 1] ?? "", "evil/image:latest");
      return Promise.resolve();
    };
    await expect(new BaseImage(dockerfile, docker, "/run/docker.sock", () => {}, odd).ensure()).rejects.toThrow(/unexpected image ID/);
  });
});
