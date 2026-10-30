import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run } from "./exec";
import { copiedFiles, copiedPaths, isBuildInput, Worktrees } from "./worktree";

let root: string;
let state: string;
const git = (args: string[], cwd = root) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "worktree-state-"));
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

const worktrees = () => new Worktrees(run, root, path.join(state, "worktrees"));

describe("Worktrees", () => {
  it("creates the task's worktree outside the repository and reuses it (D-079)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    expect(dir).toBe(path.join(state, "worktrees", "T-1"));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("task/T-1");
    fs.writeFileSync(path.join(dir, "keep.txt"), "x");
    expect(await w.ensure("T-1")).toBe(dir);
    expect(fs.existsSync(path.join(dir, "keep.txt"))).toBe(true);
  });

  it("reattaches an existing branch after the worktree was removed", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    await w.commit("T-1", "implementer", "T-1: add b");
    git(["worktree", "remove", "--force", dir]);
    await w.ensure("T-1");
    expect(fs.readFileSync(path.join(dir, "b.txt"), "utf8")).toBe("b\n");
  });

  it("recreates a worktree whose folder was deleted by hand", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.rmSync(dir, { recursive: true, force: true });
    expect(await w.ensure("T-1")).toBe(dir);
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
  });

  it("commits as the agent's role, and reports when there was nothing to commit", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    expect(await w.commit("T-1", "implementer", "nothing")).toEqual({ committed: false, refused: [] });
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    expect((await w.commit("T-1", "implementer", "T-1: change a")).committed).toBe(true);
    expect(git(["log", "-1", "--format=%an|%s"], dir)).toBe("Excaliharness (implementer)|T-1: change a");
    expect(await w.diff("T-1")).toContain("+two");
  });

  it("puts changes not committed yet in the diff", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.writeFileSync(path.join(dir, "a.txt"), "half done\n");
    const diff = await w.diff("T-1");
    expect(diff).toContain("Not committed yet");
    expect(diff).toContain("+half done");
  });

  it("never commits the read-only paths (D-068)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.mkdirSync(path.join(dir, "docs"));
    fs.writeFileSync(path.join(dir, "docs", "decisions.md"), "agent's decisions\n");
    fs.writeFileSync(path.join(dir, "TASKS.md"), "# Tasks\n");
    fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
    const result = await w.commit("T-1", "implementer", "T-1: mixed");
    expect(result.committed).toBe(true);
    expect(result.refused.sort()).toEqual(["TASKS.md", "docs/decisions.md"]);
    expect(git(["show", "--name-only", "--format=", "HEAD"], dir)).toBe("ok.txt");
  });

  it("never commits read-only paths with names git would quote, or pathspec magic", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.mkdirSync(path.join(dir, "agents"));
    fs.writeFileSync(path.join(dir, "agents", "é.md"), "x\n");
    fs.writeFileSync(path.join(dir, "agents", ":!x"), "x\n");
    fs.writeFileSync(path.join(dir, "ok.txt"), "fine\n");
    const result = await w.commit("T-1", "implementer", "T-1: odd names");
    expect(result.refused.sort()).toEqual(["agents/:!x", "agents/é.md"]);
    expect(git(["show", "--name-only", "--format=", "HEAD"], dir)).toBe("ok.txt");
  });

  it("puts back a .git file the agent changed", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    const before = fs.readFileSync(path.join(dir, ".git"), "utf8");
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: ./evil\n");
    await w.diff("T-1");
    expect(fs.readFileSync(path.join(dir, ".git"), "utf8").trim()).toBe(before.trim().replace(/^gitdir: /, "gitdir: "));
    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], dir)).toBe("task/T-1");
  });

  it("exports a commit for the gates, export-ignore or not, without touching the worktree (D-081)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.writeFileSync(path.join(dir, ".gitattributes"), "a.txt export-ignore\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    await w.commit("T-1", "implementer", "T-1: b");
    fs.writeFileSync(path.join(dir, "uncommitted.txt"), "x\n");
    const out = path.join(state, "gates", "T-1");
    await w.exportCommit(await w.head("T-1"), out);
    expect(fs.readFileSync(path.join(out, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.readFileSync(path.join(out, "b.txt"), "utf8")).toBe("b\n");
    expect(fs.existsSync(path.join(out, "uncommitted.txt"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "uncommitted.txt"))).toBe(true);
    expect(git(["status", "--short"])).toBe("");
  });

  it("lists the build inputs a round changed, not source changes (D-080)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.writeFileSync(path.join(dir, "Dockerfile"), "FROM x\nCOPY scripts/setup.sh /s.sh\nCOPY . .\n");
    await w.commit("T-1", "implementer", "T-1: dockerfile");
    const start = await w.startCommit("T-1");
    const afterDockerfile = await w.head("T-1");
    expect(await w.changedBuildInputs(start, afterDockerfile)).toEqual(["Dockerfile"]);
    fs.writeFileSync(path.join(dir, "a.txt"), "source change\n");
    fs.mkdirSync(path.join(dir, "scripts"));
    fs.writeFileSync(path.join(dir, "scripts", "setup.sh"), "echo\n");
    fs.mkdirSync(path.join(dir, "web"));
    fs.writeFileSync(path.join(dir, "web", "package.json"), "{}\n");
    await w.commit("T-1", "implementer", "T-1: more");
    expect((await w.changedBuildInputs(afterDockerfile, await w.head("T-1"))).sort()).toEqual(["scripts/setup.sh", "web/package.json"]);
    expect(await w.changedBuildInputs(afterDockerfile, afterDockerfile)).toEqual([]);
  });

  it("reads the files a Dockerfile copies by name", () => {
    const files = copiedFiles('FROM x\nCOPY package.json package-lock.json ./\nCOPY --chown=1000 ./scripts/a.sh /a\nCOPY --from=build /out /out\nADD https://x/y.tgz /y\nCOPY src/ /src/\nCOPY *.cfg /c/\nCOPY \\\n  tools/b.sh /b\nCOPY . .\n');
    expect([...files].sort()).toEqual(["package-lock.json", "package.json", "scripts/a.sh", "tools/b.sh"]);
    expect(isBuildInput("deep/requirements-dev.txt", [])).toBe(true);
    expect(isBuildInput("src/index.ts", [])).toBe(false);
    expect(isBuildInput("docker/dev.Dockerfile", [])).toBe(true);
    expect(isBuildInput("Dockerfile.dev", [])).toBe(true);
    expect(isBuildInput("compose.override.yaml", [])).toBe(true);
  });

  it("reads directories, globs and the JSON form of COPY", () => {
    const paths = copiedPaths('COPY ["setup.sh", "lib/", "/x/"]\nCOPY scripts /opt/scripts\nCOPY conf/*.ini /c/\nCOPY <<EOF /f\n');
    expect(paths).toEqual([
      { path: "setup.sh", tree: false },
      { path: "lib", tree: true },
      { path: "scripts", tree: true },
      { path: "conf/*.ini", tree: true },
    ]);
    expect(isBuildInput("scripts/install.sh", paths)).toBe(true);
    expect(isBuildInput("conf/a.ini", paths)).toBe(true);
    expect(isBuildInput("conf/a.txt", paths)).toBe(false);
    expect(isBuildInput("scriptsx/a", paths)).toBe(false);
  });

  it("finds a service's Dockerfile and what it copies, relative to its context", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    fs.mkdirSync(path.join(dir, "api", "docker"), { recursive: true });
    fs.writeFileSync(path.join(dir, "api", "docker", "app.df"), "FROM x\nCOPY tools/setup.sh /s\n");
    await w.commit("T-1", "implementer", "T-1: api");
    const before = await w.head("T-1");
    fs.mkdirSync(path.join(dir, "api", "tools"));
    fs.writeFileSync(path.join(dir, "api", "tools", "setup.sh"), "echo\n");
    fs.writeFileSync(path.join(dir, "api", "docker", "app.df"), "FROM y\nCOPY tools/setup.sh /s\n");
    await w.commit("T-1", "implementer", "T-1: change");
    const builds = [{ context: "api", dockerfile: "docker/app.df" }];
    expect((await w.changedBuildInputs(before, await w.head("T-1"), builds)).sort()).toEqual(["api/docker/app.df", "api/tools/setup.sh"]);
  });

  it("never runs hooks an agent could plant (D-069)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    const marker = path.join(root, "hook-ran");
    for (const hook of ["pre-commit", "commit-msg", "post-commit", "prepare-commit-msg"]) {
      const file = path.join(root, ".git", "hooks", hook);
      fs.writeFileSync(file, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    }
    // A hooksPath set in the repo's own config is overridden too.
    git(["config", "core.hooksPath", path.join(root, ".git", "hooks")]);
    fs.writeFileSync(path.join(dir, "a.txt"), "three\n");
    expect((await w.commit("T-1", "implementer", "T-1: three")).committed).toBe(true);
    expect(fs.existsSync(marker)).toBe(false);
  });

  // A git directory the agent controls, with a clean filter that runs a
  // command on `git add` (D-079).
  const evilGitDir = (marker: string) => {
    const evil = fs.mkdtempSync(path.join(os.tmpdir(), "evil-"));
    git(["init", "-q", evil], os.tmpdir());
    git(["config", "filter.x.clean", `touch ${marker}; cat`], evil);
    return path.join(evil, ".git");
  };

  it("refuses to run git in a worktree holding a nested repository (D-079)", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    const marker = path.join(state, "nested-filter-ran");
    const sub = path.join(dir, "sub");
    fs.mkdirSync(sub);
    git(["init", "-q"], sub);
    fs.writeFileSync(path.join(sub, "f.txt"), "x\n");
    git(["add", "-A"], sub);
    git(["commit", "-q", "-m", "nested"], sub);
    // The filter is set up only now, so the test's own git calls don't run it.
    git(["config", "filter.x.clean", `touch ${marker}; cat`], sub);
    fs.writeFileSync(path.join(sub, ".gitattributes"), "* filter=x\n");
    fs.writeFileSync(path.join(sub, "f.txt"), "changed\n");
    await expect(w.commit("T-1", "implementer", "T-1: nested")).rejects.toThrow(/git repository inside T-1's worktree \(sub\/\.git\)/);
    await expect(w.diff("T-1")).rejects.toThrow(/git repository inside/);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("recreates a worktree left half-created", async () => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    const admin = path.join(root, ".git", "worktrees", "T-1");
    fs.writeFileSync(path.join(admin, "locked"), "initializing");
    fs.rmSync(path.join(dir, "a.txt"));
    expect(await w.ensure("T-1")).toBe(dir);
    expect(fs.existsSync(path.join(dir, "a.txt"))).toBe(true);
    expect((await w.commit("T-1", "implementer", "nothing")).committed).toBe(false);
  });

  it.each(["gitdir file", "git directory"])("never reads a .git the agent rewrote (%s)", async (kind) => {
    const w = worktrees();
    const dir = await w.ensure("T-1");
    const marker = path.join(state, "filter-ran");
    const evil = evilGitDir(marker);
    fs.rmSync(path.join(dir, ".git"), { recursive: true, force: true });
    if (kind === "gitdir file") fs.writeFileSync(path.join(dir, ".git"), `gitdir: ${evil}\n`);
    else fs.cpSync(evil, path.join(dir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".gitattributes"), "* filter=x\n");
    fs.writeFileSync(path.join(dir, "a.txt"), "four\n");
    await w.commit("T-1", "implementer", "T-1: four");
    await w.diff("T-1");
    expect(fs.existsSync(marker)).toBe(false);
    expect(git(["log", "-1", "--format=%s", "task/T-1"])).toBe("T-1: four");
    fs.rmSync(path.dirname(evil), { recursive: true, force: true });
  });
});
