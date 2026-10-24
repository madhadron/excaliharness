// The per-repo orchestrator lock (D-021, D-044, D-048), held for the worker's
// lifetime. Created with O_EXCL; the holder records who it is and touches the
// file every few seconds (a heartbeat), so a later worker can tell a live lock
// from one left by a crash, even one written under another hostname.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface LockHolder {
  pid: number;
  host: string;
  startedAt: string;
  // The worker script and repo root, both on the holder's command line; used
  // to tell the holder from an unrelated process that reused its pid.
  script: string;
  root: string;
}

export const CACHE_DIR = ".excaliharness";
const LOCK_FILE = "orchestrator.lock";

export function lockPath(root: string): string {
  return path.join(root, CACHE_DIR, LOCK_FILE);
}

// The cache directory ignores itself, so the lock never shows up in git
// without touching the repo's own .gitignore. A symlink here could point the
// worker's writes anywhere, so it's refused.
export function ensureCacheDir(root: string): string {
  const dir = path.join(root, CACHE_DIR);
  const existing = fs.lstatSync(dir, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error(`${dir} exists but isn't a directory`);
  if (!existing) fs.mkdirSync(dir);
  const ignore = path.join(dir, ".gitignore");
  try {
    fs.writeFileSync(ignore, "*\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return dir;
}

// Reads the lock file. `holder` is missing when the file is incomplete: taking
// the lock is two steps (create the file with O_EXCL, then write the holder's
// record into it), so another worker can look between them and find it empty
// or half written; a holder that crashed between them leaves it that way.
function readHolder(file: string): { raw: string; holder?: LockHolder } | undefined {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return undefined;
  // No worker writes anything but a regular file here; handled like an
  // incomplete lock file.
  if (!stat.isFile()) return { raw: "" };
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockHolder>;
    if (typeof parsed.pid === "number" && typeof parsed.host === "string" && typeof parsed.script === "string" && typeof parsed.root === "string") {
      return { raw, holder: parsed as LockHolder };
    }
  } catch {
    // Incomplete: handled in tryAcquire by its age.
  }
  return { raw };
}

function commandOf(pid: number): string | undefined {
  try {
    if (process.platform === "linux") return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ").trim();
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 2_000 }).trim();
  } catch {
    return undefined;
  }
}

// Whether the holder's process is running, as far as this machine can tell.
// A holder on another host (or under an old hostname) can't be checked here;
// its heartbeat decides instead.
function isAlive(holder: LockHolder): boolean {
  if (holder.host !== os.hostname()) return true;
  if (holder.pid === process.pid) return true; // This very process.
  try {
    process.kill(holder.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  // A reused pid running something else doesn't hold the lock.
  const command = commandOf(holder.pid);
  return command === undefined || (command.includes(holder.script) && command.includes(holder.root));
}

// An incomplete lock file younger than this is assumed to be mid-write, so the
// lock counts as held; an older one was left by a crash and counts as stale.
const INCOMPLETE_GRACE_MS = 10_000;

// The holder touches the lock this often; a lock not touched for STALE_AFTER_MS
// counts as stale whatever host it names (a crashed holder, a hostname that
// changed, a lock file committed to the repo).
export const HEARTBEAT_MS = 10_000;
export const STALE_AFTER_MS = 60_000;

export interface HeldLock {
  held: true;
  release: () => void;
  // False once the lock file no longer holds our record (deleted by
  // `git clean`, or taken over); the worker must then stop writing.
  stillHeld: () => boolean;
  // The heartbeat: marks the lock as alive. Returns stillHeld().
  touch: () => boolean;
}

export type Acquired = HeldLock | { held: false; holder?: LockHolder };

export function tryAcquire(root: string, now = () => Date.now(), staleAfterMs = STALE_AFTER_MS): Acquired {
  ensureCacheDir(root);
  const file = lockPath(root);
  const me: LockHolder = {
    pid: process.pid,
    host: os.hostname(),
    startedAt: new Date(now()).toISOString(),
    script: process.argv[1] ?? "",
    root,
  };
  const mine = JSON.stringify(me);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Step 1: creating the file is what wins the lock. Step 2: record who
      // holds it. Until step 2 finishes, others see an incomplete lock file.
      const fd = fs.openSync(file, "wx", 0o644);
      try {
        fs.writeFileSync(fd, mine);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const stillHeld = () => readHolder(file)?.raw === mine;
      return { held: true, release: () => release(file, mine), stillHeld, touch: () => touch(file, stillHeld) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = readHolder(file);
    if (!existing) continue; // Released between our attempts.
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) continue;
    const age = now() - stat.mtimeMs;
    if (existing.holder) {
      if (age <= staleAfterMs && isAlive(existing.holder)) return { held: false, holder: existing.holder };
    } else if (age <= INCOMPLETE_GRACE_MS) {
      return { held: false };
    }
    removeStale(file, existing.raw);
  }
  return { held: false };
}

// Moves a stale lock aside, then checks it moved the lock it judged stale. If
// another worker replaced the lock in between, its lock is put back. (A third
// worker racing in that gap is caught by the holders' stillHeld checks.)
function removeStale(file: string, staleRaw: string): void {
  const aside = path.join(path.dirname(file), `.${LOCK_FILE}.stale-${randomBytes(4).toString("hex")}`);
  try {
    fs.renameSync(file, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (readHolder(aside)?.raw !== staleRaw) {
    try {
      fs.linkSync(aside, file);
    } catch {
      // Someone already created a fresh lock; it wins.
    }
  }
  fs.rmSync(aside, { force: true });
}

function touch(file: string, stillHeld: () => boolean): boolean {
  if (!stillHeld()) return false;
  try {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const now = new Date();
      fs.futimesSync(fd, now, now);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
  return stillHeld();
}

function release(file: string, mine: string): void {
  try {
    if (readHolder(file)?.raw === mine) fs.rmSync(file, { force: true });
  } catch {
    // Already gone.
  }
}
