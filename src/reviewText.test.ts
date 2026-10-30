import { describe, expect, it } from "vitest";
import { addPending, commandTaskId, diffEntries, dropPending, isTaskWorktree, PENDING_TTL_MS, takePending, type FileKind } from "./reviewText";
import type { ReviewInfo } from "./worker/protocol";

const review = (id: string): ReviewInfo => ({
  id,
  worktree: `/s/worktrees/${id}`,
  baseDir: `/s/review/${id}`,
  base: "abc",
  files: [
    { path: "a.txt", change: "modified" },
    { path: "b.txt", change: "added" },
    { path: "c.txt", change: "deleted" },
    { path: "link", change: "modified" },
  ],
  truncated: false,
});

describe("pending reviews", () => {
  it("hands a review to the window on its worktree once", () => {
    const stored = addPending(addPending(undefined, review("T-1"), 1_000), review("T-2"), 2_000);
    const taken = takePending(stored, (w) => w === "/s/worktrees/T-2", 3_000);
    expect(taken.review).toEqual({ ...review("T-2"), at: 2_000 });
    expect(Object.keys(taken.rest)).toEqual(["/s/worktrees/T-1"]);
    expect(takePending(taken.rest, (w) => w === "/s/worktrees/T-2", 3_000).review).toBeUndefined();
  });

  it("drops stale, future and malformed entries", () => {
    const stored = { a: { ...review("T-1"), at: 0 }, b: { ...review("T-2"), at: 99_999_999 }, c: { at: 10 }, d: "x" };
    expect(takePending(stored, () => true, PENDING_TTL_MS + 1)).toEqual({ rest: {} });
    expect(takePending("nonsense", () => true, 0)).toEqual({ rest: {} });
  });

  it("replaces an earlier review of the same worktree", () => {
    const stored = addPending(addPending(undefined, review("T-1"), 1_000), { ...review("T-1"), base: "def" }, 2_000);
    expect(Object.values(stored).map((r) => [r.base, r.at])).toEqual([["def", 2_000]]);
  });
});

describe("dropPending", () => {
  it("forgets the review taken, but not one left again since", () => {
    const stored = addPending(undefined, review("T-1"), 1_000);
    const taken = { ...review("T-1"), at: 1_000 };
    expect(dropPending(stored, taken, 2_000)).toEqual({});
    const again = addPending(stored, review("T-1"), 1_500);
    expect(Object.values(dropPending(again, taken, 2_000)).map((r) => r.at)).toEqual([1_500]);
  });
});

describe("isTaskWorktree", () => {
  it("knows the worker's worktree folders and what is inside them, whatever the case", () => {
    const storage = "/Users/h/Library/Application Support/Code/User/workspaceStorage/abc";
    expect(isTaskWorktree(`${storage}/madhadron.excaliharness/worktrees/T-7`)).toBe(true);
    expect(isTaskWorktree(`${storage}/madhadron.excaliharness/worktrees/T-7/src`)).toBe(true);
    expect(isTaskWorktree(`${storage}/Madhadron.Excaliharness/Worktrees/t-7`)).toBe(true);
    expect(isTaskWorktree("/home/h/globalStorage/madhadron.excaliharness/worktrees/T-12")).toBe(true);
  });

  it("leaves other folders alone", () => {
    expect(isTaskWorktree("/home/h/repo")).toBe(false);
    expect(isTaskWorktree("/s/madhadron.excaliharness/worktrees")).toBe(false);
    expect(isTaskWorktree("/s/madhadron.excaliharness/review/T-1")).toBe(false);
    expect(isTaskWorktree("/s/other/worktrees/T-1")).toBe(false);
  });
});

describe("commandTaskId", () => {
  it("takes the id it is given, or the task file in the editor", () => {
    expect(commandTaskId("/repo", { id: "T-3" }, "/repo/tasks/T-1.md")).toBe("T-3");
    expect(commandTaskId("/repo", undefined, "/repo/tasks/T-1.md")).toBe("T-1");
    expect(commandTaskId("/repo", {}, "/repo/tasks/T-1.md")).toBe("T-1");
  });

  it("refuses a malformed id rather than falling back to the editor", () => {
    expect(commandTaskId("/repo", { id: "../T-3" }, "/repo/tasks/T-1.md")).toBeUndefined();
    expect(commandTaskId("/repo", undefined, "/repo/README.md")).toBeUndefined();
    expect(commandTaskId("/repo", undefined, undefined)).toBeUndefined();
  });
});

describe("diffEntries", () => {
  const kinds: Record<string, FileKind> = { "/w/a.txt": "file", "/w/b.txt": "file", "/w/c.txt": "missing", "/w/link": "unsafe" };

  it("pairs base copies with worktree files, and leaves out what isn't a plain file", () => {
    expect(diffEntries(review("T-1"), "/w", (f) => kinds[f] ?? "missing")).toEqual({
      entries: [{ left: "/s/review/T-1/a.txt", right: "/w/a.txt" }, { right: "/w/b.txt" }, { left: "/s/review/T-1/c.txt" }],
      unsafe: ["link"],
    });
  });

  it("drops an added file that is gone again", () => {
    expect(diffEntries(review("T-1"), "/w", () => "missing").entries).not.toContainEqual({});
  });
});
