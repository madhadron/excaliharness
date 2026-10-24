import { describe, expect, it } from "vitest";
import { editTask, replaceIndex } from "./edit";
import { joinText, splitText } from "./text";

describe("splitText / joinText", () => {
  it.each(["", "\n", "a", "a\n", "a\nb", "a\r\nb\r\n", "a\r\nb\nc", "﻿a\nb\n", "\n\n\n"])("round-trips %j byte for byte", (text) => {
    expect(joinText(splitText(text))).toBe(text);
  });

  it("refuses to join lines and line endings of different lengths", () => {
    expect(() => joinText({ bom: false, lines: ["a", "b"], eols: ["\n"], eol: "\n" })).toThrow(/2 lines but 1 line endings/);
  });

  it("uses the dominant line ending for new lines", () => {
    expect(splitText("a\r\nb\r\nc\n").eol).toBe("\r\n");
    expect(splitText("a\nb\n").eol).toBe("\n");
  });
});

const task = ["# T-1: Title", "", "* status: draft", "* note: kept", "", "## Description", "Body.", "", "## Updates", "* old entry", ""].join("\n");

describe("editTask", () => {
  it("changes the status and appends to Updates in one edit, leaving other lines alone", () => {
    const out = editTask(task, 2, { status: "ready", updates: ["* new entry"] });
    expect(out).toBe(task.replace("* status: draft", "* status: ready").replace("* old entry\n", "* old entry\n* new entry\n"));
  });

  it("keeps the bullet and spacing before status:", () => {
    expect(editTask("# T-1: x\n  - status:   draft\n", 1, { status: "ready", updates: [] })).toBe("# T-1: x\n  - status: ready\n");
  });

  it("refuses to edit a line that isn't the status line", () => {
    expect(() => editTask(task, 3, { status: "ready", updates: [] })).toThrow(/not a status line/);
  });

  it("appends after the last entry, before trailing blank lines and the next section", () => {
    const text = "# T-1: x\n* status: draft\n\n## Updates\n* a\n\n\n## Later\nz\n";
    expect(editTask(text, 1, { updates: ["* b"] })).toBe("# T-1: x\n* status: draft\n\n## Updates\n* a\n* b\n\n\n## Later\nz\n");
  });

  it("fills an empty Updates section", () => {
    expect(editTask("# T-1: x\n* status: draft\n\n## Updates\n", 1, { updates: ["* a"] })).toBe("# T-1: x\n* status: draft\n\n## Updates\n* a\n");
  });

  it("adds an Updates section when there is none", () => {
    expect(editTask("# T-1: x\n* status: draft\n", 1, { updates: ["* a"] })).toBe("# T-1: x\n* status: draft\n\n## Updates\n* a\n");
  });

  it("keeps CRLF, a BOM and a missing final newline", () => {
    const text = "﻿# T-1: x\r\n* status: draft\r\n\r\n## Updates\r\n* a";
    expect(editTask(text, 1, { status: "ready", updates: ["* b"] })).toBe("﻿# T-1: x\r\n* status: ready\r\n\r\n## Updates\r\n* a\r\n* b");
  });

  it("ignores an Updates heading inside a fenced code block", () => {
    const text = "# T-1: x\n* status: draft\n\n```\n## Updates\n```\n";
    expect(editTask(text, 1, { updates: ["* a"] })).toBe(`${text}\n## Updates\n* a\n`);
  });
});

describe("replaceIndex", () => {
  it("replaces only the Index body, keeping a blank line before the next section", () => {
    const text = "# Tasks\n\n## Index\n* stale\n\n## Pipelines\n* default\n";
    expect(replaceIndex(text, ["* [[T-1]] A · ready"])).toBe("# Tasks\n\n## Index\n* [[T-1]] A · ready\n\n## Pipelines\n* default\n");
  });

  it("returns the same text when the index is already current", () => {
    const text = "# Tasks\n\n## Index\n* [[T-1]] A · ready\n";
    expect(replaceIndex(text, ["* [[T-1]] A · ready"])).toBe(text);
  });

  it("adds the section when it's missing", () => {
    expect(replaceIndex("# Tasks\n", ["* [[T-1]] A · ready"])).toBe("# Tasks\n\n## Index\n* [[T-1]] A · ready\n");
  });

  it("fills an empty Index heading", () => {
    expect(replaceIndex("# Tasks\n\n## Index\n", ["* x"])).toBe("# Tasks\n\n## Index\n* x\n");
  });
});
