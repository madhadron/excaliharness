import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Reviews } from "./review";
import { run } from "./runner/exec";
import { Worktrees } from "./runner/worktree";

let root: string;
let state: string;
const git = (args: string[], cwd = root) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" }).trim();

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "review-"));
  state = fs.mkdtempSync(path.join(os.tmpdir(), "review-state-"));
  git(["init", "-q", "-b", "main"]);
  fs.writeFileSync(path.join(root, "a.txt"), "one\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(state, { recursive: true, force: true });
});

describe("Reviews", () => {
  const setup = () => {
    const worktrees = new Worktrees(run, root, path.join(state, "worktrees"));
    return { worktrees, reviews: new Reviews(worktrees, path.join(state, "review")) };
  };

  it("refuses a task that has no worktree", async () => {
    await expect(setup().reviews.prepare("T-1")).rejects.toThrow(/T-1 has no worktree yet/);
  });

  it("lists the branch's changes and copies their base versions", async () => {
    const { worktrees, reviews } = setup();
    const dir = await worktrees.ensure("T-1");
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    await worktrees.commit("T-1", "implementer", "T-1: change");
    // Two at once for the same task: each sees a complete copy.
    const [first, second] = await Promise.all([reviews.prepare("T-1"), reviews.prepare("T-1")]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({
      id: "T-1",
      worktree: dir,
      base: git(["rev-parse", "main"]),
      files: [
        { path: "a.txt", change: "modified" },
        { path: "b.txt", change: "added" },
      ],
      truncated: false,
    });
    expect(path.dirname(first.baseDir)).toBe(path.join(state, "review", "T-1"));
    expect(fs.readdirSync(first.baseDir)).toEqual(["a.txt"]);
    expect(fs.readFileSync(path.join(first.baseDir, "a.txt"), "utf8")).toBe("one\n");
    // Nothing half made is left beside it.
    expect(fs.readdirSync(path.join(state, "review", "T-1"))).toEqual([path.basename(first.baseDir)]);
  });

  it("never rewrites copies a diff may show: other files get a new folder, and old ones go after a day", async () => {
    const { worktrees, reviews } = setup();
    const dir = await worktrees.ensure("T-1");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    await worktrees.commit("T-1", "implementer", "T-1: add b");
    const first = await reviews.prepare("T-1");
    fs.writeFileSync(path.join(dir, "a.txt"), "two\n");
    await worktrees.commit("T-1", "implementer", "T-1: change a");
    const second = await reviews.prepare("T-1");
    expect(second.baseDir).not.toBe(first.baseDir);
    expect(fs.existsSync(first.baseDir)).toBe(true);
    const old = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    fs.utimesSync(first.baseDir, old, old);
    fs.utimesSync(second.baseDir, old, old);
    // The one prepared again is kept; the other is old and goes.
    expect((await reviews.prepare("T-1")).baseDir).toBe(second.baseDir);
    expect(fs.existsSync(first.baseDir)).toBe(false);
    expect(fs.existsSync(path.join(second.baseDir, "a.txt"))).toBe(true);
  });

  it("removes the copies of tasks no longer to review", async () => {
    const { worktrees, reviews } = setup();
    await worktrees.ensure("T-1");
    await worktrees.ensure("T-2");
    await reviews.prepare("T-1");
    await reviews.prepare("T-2");
    fs.writeFileSync(path.join(state, "review", "other"), "x");
    reviews.sweep(new Set(["T-2"]));
    // The removal is queued behind any preparation of the task.
    await reviews.prepare("T-2");
    await new Promise((r) => setTimeout(r, 20));
    expect(fs.readdirSync(path.join(state, "review")).sort()).toEqual(["T-2", "other"]);
  });
});
