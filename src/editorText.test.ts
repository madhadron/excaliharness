import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { findWikilinks, resolveWikilink, statusOf, taskIdOf } from "./editorText";

const root = "/repo";

describe("wikilinks", () => {
  it("finds every link with its position", () => {
    expect(findWikilinks("see [[T-1]] and\n[[agents/implementer]]")).toEqual([
      { line: 0, start: 4, end: 11, target: "T-1" },
      { line: 1, start: 0, end: 22, target: "agents/implementer" },
    ]);
  });

  it("resolves task ids and repo paths, and refuses to leave the repo", () => {
    expect(resolveWikilink(root, "T-7")).toBe(path.join(root, "tasks", "T-7.md"));
    expect(resolveWikilink(root, "agents/implementer")).toBe(path.join(root, "agents", "implementer.md"));
    expect(resolveWikilink(root, "../secrets")).toBeUndefined();
    expect(resolveWikilink(root, "/etc/passwd")).toBeUndefined();
    expect(resolveWikilink(root, "")).toBeUndefined();
    expect(resolveWikilink(root, "a/../../b")).toBeUndefined();
  });
});

describe("statusOf", () => {
  it("reads the status the way the worker does", () => {
    expect(statusOf("# T-1: x\n\n* kind: infrastructure\n* status: draft\n", "T-1")).toEqual({ line: 3, value: "draft" });
  });

  it("gives nothing for a file the worker wouldn't accept", () => {
    expect(statusOf("# T-1: x\n\n## Notes\n* status: draft\n", "T-1")).toBeUndefined();
    expect(statusOf("# T-1: x\n* status: draft\n```\n", "T-1")).toBeUndefined();
  });
});

describe("findWikilinks on hostile input", () => {
  it("stays fast on a long run of brackets", () => {
    const started = Date.now();
    findWikilinks("[[".repeat(40_000));
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("taskIdOf", () => {
  it("accepts only tasks/T-NNN.md directly under the root", () => {
    expect(taskIdOf(root, path.join(root, "tasks", "T-12.md"))).toBe("T-12");
    expect(taskIdOf(root, path.join(root, "tasks", "notes.md"))).toBeUndefined();
    expect(taskIdOf(root, path.join(root, "tasks", "sub", "T-1.md"))).toBeUndefined();
    expect(taskIdOf(root, path.join("/other", "tasks", "T-1.md"))).toBeUndefined();
  });
});
