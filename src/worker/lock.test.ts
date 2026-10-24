import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lockPath, tryAcquire } from "./lock";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "lock-"));
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const writeLock = (content: string) => {
  fs.mkdirSync(path.dirname(lockPath(root)), { recursive: true });
  fs.writeFileSync(lockPath(root), content);
};

describe("tryAcquire", () => {
  it("lets one holder in at a time and releases", () => {
    const first = tryAcquire(root);
    expect(first.held).toBe(true);
    const second = tryAcquire(root);
    expect(second).toMatchObject({ held: false, holder: { pid: process.pid } });
    if (first.held) first.release();
    expect(tryAcquire(root).held).toBe(true);
  });

  it("treats a live pid running something else as stale (pid reuse)", () => {
    // The parent process is alive, but it isn't a worker for this repo.
    writeLock(JSON.stringify({ pid: process.ppid, host: os.hostname(), startedAt: "", script: "/nowhere/worker.js", root }));
    expect(tryAcquire(root).held).toBe(true);
  });

  it("notices when its lock file is deleted or replaced", () => {
    const held = tryAcquire(root);
    if (!held.held) throw new Error("expected the lock");
    expect(held.stillHeld()).toBe(true);
    fs.rmSync(lockPath(root));
    expect(held.stillHeld()).toBe(false);
  });

  it("refuses a cache directory that is a symlink", () => {
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), "elsewhere-"));
    fs.symlinkSync(elsewhere, path.join(root, ".excaliharness"));
    expect(() => tryAcquire(root)).toThrow(/isn't a directory/);
    expect(fs.readdirSync(elsewhere)).toEqual([]);
    fs.rmSync(elsewhere, { recursive: true, force: true });
  });

  it("makes the cache directory ignore itself in git", () => {
    tryAcquire(root);
    expect(fs.readFileSync(path.join(root, ".excaliharness", ".gitignore"), "utf8")).toBe("*\n");
  });

  it("takes over a lock whose holder is dead", () => {
    writeLock(JSON.stringify({ pid: 2 ** 22 + 12345, host: os.hostname(), startedAt: "", script: "worker.js", root }));
    expect(tryAcquire(root).held).toBe(true);
  });

  it("respects a recently touched lock from another host", () => {
    writeLock(JSON.stringify({ pid: 1, host: "elsewhere", startedAt: "", script: "worker.js", root }));
    expect(tryAcquire(root)).toMatchObject({ held: false, holder: { host: "elsewhere" } });
  });

  it("takes over a lock from another host (or an old hostname) once its heartbeat stops", () => {
    writeLock(JSON.stringify({ pid: 1, host: "old-hostname", startedAt: "", script: "worker.js", root }));
    const twoMinutesAgo = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath(root), twoMinutesAgo, twoMinutesAgo);
    expect(tryAcquire(root).held).toBe(true);
  });

  it("keeps its lock fresh with touch, and touch reports losing it", () => {
    const held = tryAcquire(root);
    if (!held.held) throw new Error("expected the lock");
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lockPath(root), old, old);
    expect(held.touch()).toBe(true);
    expect(Date.now() - fs.statSync(lockPath(root)).mtimeMs).toBeLessThan(5_000);
    writeLock(JSON.stringify({ pid: 1, host: "elsewhere", startedAt: "", script: "x", root }));
    expect(held.touch()).toBe(false);
  });

  it("waits for a fresh empty lock (being written) but takes an old one", () => {
    writeLock("");
    expect(tryAcquire(root).held).toBe(false);
    const later = () => Date.now() + 60_000;
    expect(tryAcquire(root, later).held).toBe(true);
  });

  it("release leaves a lock that someone else took over", () => {
    const first = tryAcquire(root);
    writeLock(JSON.stringify({ pid: 1, host: "elsewhere", startedAt: "", script: "x", root }));
    if (first.held) first.release();
    expect(fs.existsSync(lockPath(root))).toBe(true);
  });
});
