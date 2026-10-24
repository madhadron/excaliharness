// File access for the worker, the only writer of task files (D-021, D-035).
// Writes are atomic (temp file + rename) and compare-and-swap: they happen
// only if the file still has the content the edit was computed from. Nothing
// here throws for filesystem errors; they come back as results to report.
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TEMP_PREFIX = ".excaliharness-";
// Task files are small; anything bigger is a mistake, not something to load.
export const MAX_FILE_BYTES = 1024 * 1024;

export function hashOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface FileContent {
  text: string;
  hash: string;
}

export type ReadResult = { status: "ok"; content: FileContent } | { status: "missing" } | { status: "unusable"; reason: string };

const errorText = (error: unknown) => {
  const e = error as NodeJS.ErrnoException;
  return e.code ? `${e.code}: ${e.message}` : String(error);
};

// Reads a regular file of reasonable size. Symlinks are refused: a rename onto
// one would replace the link instead of changing its target, and following one
// could take the worker outside the repository.
export function readFile(file: string): ReadResult {
  let fd: number;
  try {
    const link = fs.lstatSync(file);
    if (link.isSymbolicLink()) return { status: "unusable", reason: "it is a symbolic link, which the orchestrator doesn't follow" };
    if (!link.isFile()) return { status: "unusable", reason: "it isn't a regular file" };
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    return { status: "unusable", reason: errorText(error) };
  }
  try {
    const { size } = fs.fstatSync(fd);
    if (size > MAX_FILE_BYTES) return { status: "unusable", reason: `it is larger than ${MAX_FILE_BYTES / 1024} KB` };
    const bytes = readFrom(fd);
    return { status: "ok", content: { text: bytes.toString("utf8"), hash: hashOf(bytes) } };
  } catch (error) {
    return { status: "unusable", reason: errorText(error) };
  } finally {
    fs.closeSync(fd);
  }
}

export type UpdateResult = { status: "unchanged" | "written" } | { status: "failed"; reason: string };

const MAX_ATTEMPTS = 3;

export interface StoreHooks {
  // Called between writing the temp file and renaming it; tests use it to
  // simulate a save landing in that window.
  beforeRename?: (file: string) => void;
}

export class Store {
  constructor(private readonly hooks: StoreHooks = {}) {}

  // Applies `edit` to the file's current text and writes the result. `edit`
  // returns undefined to leave the file alone (e.g. it no longer parses). If
  // the file changes underneath, the edit is recomputed on the new content.
  update(file: string, edit: (text: string) => string | undefined): UpdateResult {
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const current = readFile(file);
      if (current.status === "missing") return { status: "failed", reason: "the file is missing" };
      if (current.status === "unusable") return { status: "failed", reason: current.reason };
      const next = edit(current.content.text);
      if (next === undefined || next === current.content.text) return { status: "unchanged" };
      try {
        if (this.swap(file, current.content.hash, next) === "written") return { status: "written" };
      } catch (error) {
        return { status: "failed", reason: errorText(error) };
      }
    }
    return { status: "failed", reason: `the file kept changing during ${MAX_ATTEMPTS} attempts to write it` };
  }

  // Writes `next` only if the file still hashes to `expected`.
  //
  // The original file stays open across the rename. An editor that saves in
  // place during the window writes to that (now orphaned) inode; we detect it,
  // wait for their write to settle, and put their content back with another
  // atomic rename, so the caller's retry is computed from it. An editor that
  // saves by renaming is caught by the inode check just before our rename.
  private swap(file: string, expected: string, next: string): "written" | "conflict" {
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const tmp = path.join(path.dirname(file), `${TEMP_PREFIX}${randomBytes(6).toString("hex")}.tmp`);
    try {
      const original = fs.fstatSync(fd);
      if (hashOf(readFrom(fd)) !== expected) return "conflict";
      writeTemp(tmp, next, original.mode & 0o666);
      this.hooks.beforeRename?.(file);
      if (fs.lstatSync(file).ino !== original.ino) return "conflict";
      fs.renameSync(tmp, file);
      const theirs = settledContent(fd);
      if (hashOf(theirs) !== expected) {
        writeTemp(tmp, theirs, original.mode & 0o666);
        fs.renameSync(tmp, file);
        return "conflict";
      }
      return "written";
    } finally {
      fs.closeSync(fd);
      fs.rmSync(tmp, { force: true });
    }
  }
}

// `mode` keeps read/write bits only: no setuid, setgid or execute bits on
// files the worker writes.
function writeTemp(tmp: string, content: string | Buffer, mode: number): void {
  fs.rmSync(tmp, { force: true });
  const out = fs.openSync(tmp, "wx", mode);
  try {
    fs.fchmodSync(out, mode); // Not reduced by the umask.
    fs.writeFileSync(out, content);
    fs.fsyncSync(out);
  } finally {
    fs.closeSync(out);
  }
}

// An in-place save truncates, then writes. Reads until two in a row agree, so
// a half-finished save isn't mistaken for their content.
function settledContent(fd: number): Buffer {
  let previous = readFrom(fd);
  for (let i = 0; i < 10; i++) {
    sleepSync(20);
    const current = readFrom(fd);
    if (current.equals(previous)) return current;
    previous = current;
  }
  return previous;
}

const sleeper = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  Atomics.wait(sleeper, 0, 0, ms);
}

function readFrom(fd: number): Buffer {
  const size = fs.fstatSync(fd).size;
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const n = fs.readSync(fd, buffer, offset, size - offset, offset);
    if (n === 0) break;
    offset += n;
  }
  return buffer.subarray(0, offset);
}

// Removes temp files a crashed worker left behind. Only the lock holder may
// call this, or it could delete another worker's in-flight temp file.
export function removeLeftoverTempFiles(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(TEMP_PREFIX) && name.endsWith(".tmp")) fs.rmSync(path.join(dir, name), { force: true });
  }
}
