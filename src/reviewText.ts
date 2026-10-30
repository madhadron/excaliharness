// The parts of "Open review" (D-027) that don't need VS Code: handing a
// prepared review from the trusted window to the one opened on the worktree,
// and which files the diff shows.
import * as path from "node:path";
import { taskIdOf } from "./editorText";
import { isReviewInfo, type ReviewInfo } from "./worker/protocol";
import { EXTENSION_ID } from "./worker/tasks/model";

// A review waiting for the window on its worktree to open it.
export interface PendingReview extends ReviewInfo {
  at: number;
}

// Long enough for a new window to start; a stale review is never opened.
export const PENDING_TTL_MS = 5 * 60_000;

type Pending = Record<string, PendingReview>;

// The reviews still waiting, from what global state holds (anything else is
// dropped), keyed by worktree.
function live(stored: unknown, now: number): Pending {
  const out: Pending = {};
  if (typeof stored !== "object" || stored === null) return out;
  for (const value of Object.values(stored as Record<string, unknown>)) {
    if (!isReviewInfo(value) || !("at" in value)) continue;
    const at = value.at;
    if (typeof at !== "number" || now - at > PENDING_TTL_MS || at > now) continue;
    out[value.worktree] = { ...value, at };
  }
  return out;
}

export function addPending(stored: unknown, review: ReviewInfo, now: number): Pending {
  return { ...live(stored, now), [review.worktree]: { ...review, at: now } };
}

// The review for the worktree `isHere` accepts, and what remains without it.
export function takePending(stored: unknown, isHere: (worktree: string) => boolean, now: number): { review?: PendingReview; rest: Pending } {
  const rest = live(stored, now);
  const review = Object.values(rest).find((r) => isHere(r.worktree));
  if (review) delete rest[review.worktree];
  return review ? { review, rest } : { rest };
}

// Forgets `review` once its window has taken it, unless it was left again
// since (a newer one for the same worktree stays).
export function dropPending(stored: unknown, review: PendingReview, now: number): Pending {
  const rest = live(stored, now);
  if (rest[review.worktree]?.at === review.at) delete rest[review.worktree];
  return rest;
}

// Whether `folder` is a task's worktree or inside one: the worker keeps them
// at <the extension's storage>/worktrees/T-NNN (D-079). Compared without
// case, as macOS disks are.
export function isTaskWorktree(folder: string): boolean {
  const parts = path.resolve(folder).split(path.sep).map((p) => p.toLowerCase());
  return parts.some((p, i) => p === EXTENSION_ID && parts[i + 1] === "worktrees" && /^t-\d+$/.test(parts[i + 2] ?? ""));
}

// The task a review command is for: the one it names, or the task file in
// the active editor.
export function commandTaskId(root: string, arg: unknown, activeFile: string | undefined): string | undefined {
  const given = typeof arg === "object" && arg !== null && "id" in arg ? arg.id : undefined;
  if (typeof given === "string") return /^T-\d+$/.test(given) ? given : undefined;
  return activeFile ? taskIdOf(root, activeFile) : undefined;
}

// What a worktree path holds: a plain file reached without a symbolic link,
// nothing, or anything else.
export type FileKind = "file" | "missing" | "unsafe";

export interface DiffEntry {
  // The base copy, for a file that existed where the branch started.
  left?: string;
  // The worktree file, for one that exists now.
  right?: string;
}

// One diff entry per changed file. Files in the worktree that aren't plain
// files (a symbolic link could show anything on the disk) are left out and
// named in `unsafe`.
export function diffEntries(review: ReviewInfo, worktree: string, kind: (file: string) => FileKind): { entries: DiffEntry[]; unsafe: string[] } {
  const entries: DiffEntry[] = [];
  const unsafe: string[] = [];
  for (const f of review.files) {
    const right = path.join(worktree, f.path);
    const k = kind(right);
    if (k === "unsafe") {
      unsafe.push(f.path);
      continue;
    }
    const entry: DiffEntry = {};
    if (f.change !== "added") entry.left = path.join(review.baseDir, f.path);
    if (k === "file") entry.right = right;
    if (entry.left || entry.right) entries.push(entry);
  }
  return { entries, unsafe };
}
