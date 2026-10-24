import { describe, expect, it } from "vitest";
import type { Task } from "./model";
import { parseTask, parseTasksIndex } from "./parse";

const full = `# T-7: Password reset flow

* status: needs-decision
* depends_on: [[T-1]], [[T-4]]
* pipeline: ui
* kind: infrastructure
* custom_key: kept

## Description
Text with [[T-9]] in it.

\`\`\`markdown
## Updates
* fake · entry · status: done → ready
\`\`\`

## Questions
* [x] Q: Expire links?

      A: After one hour.
* [ ] Q: Rate limit?

      A:

## Updates
* 2026-10-23 14:02 · human · status: draft → ready
* 2026-10-23 14:03 · orchestrator · status: ready → needs-decision · agent asked
* 2026-10-23 14:04 · orchestrator · a note
`;

function ok(text: string, id = "T-7"): Task {
  const result = parseTask(text, id);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.value;
}

function errors(text: string, id = "T-7") {
  const result = parseTask(text, id);
  if (result.ok) throw new Error("expected errors");
  return result.errors;
}

describe("parseTask", () => {
  it("reads every part of a task file", () => {
    const task = ok(full);
    expect(task).toMatchObject({
      id: "T-7",
      title: "Password reset flow",
      status: "needs-decision",
      statusLine: 2,
      dependsOn: ["T-1", "T-4"],
      pipeline: "ui",
      kind: "infrastructure",
    });
    expect(task.metadata.map((m) => m.key)).toEqual(["status", "depends_on", "pipeline", "kind", "custom_key"]);
    expect(task.questions).toEqual([
      { checked: true, question: "Expire links?", answer: "After one hour.", line: 17 },
      { checked: false, question: "Rate limit?", answer: "", line: 20 },
    ]);
    // The fenced "## Updates" is not a section, so its fake entry is ignored.
    expect(task.statusEntries).toEqual([
      { from: "draft", to: "ready", line: 25 },
      { from: "ready", to: "needs-decision", line: 26 },
    ]);
    expect(task.sections.map((s) => s.name)).toEqual(["Description", "Questions", "Updates"]);
  });

  it("accepts a minimal task", () => {
    expect(ok("# T-1: x\n* status: draft\n", "T-1")).toMatchObject({ dependsOn: [], questions: [], statusEntries: [] });
  });

  it.each([
    ["no title", "* status: draft\n", 0, /first line/],
    ["wrong id", "# T-8: x\n* status: draft\n", 0, /file is T-7/],
    ["no status", "# T-7: x\n* pipeline: ui\n", 1, /Missing/],
    ["unknown status", "# T-7: x\n* status: started\n", 1, /Unknown status "started"/],
    ["duplicate key", "# T-7: x\n* status: draft\n* status: ready\n", 2, /Duplicate/],
    ["plain dependency", "# T-7: x\n* status: draft\n* depends_on: T-1\n", 2, /task links/],
    ["non-task link", "# T-7: x\n* status: draft\n* depends_on: [[docs/x]]\n", 2, /task links/],
    ["self dependency", "# T-7: x\n* status: draft\n* depends_on: [[T-7]]\n", 2, /itself/],
    ["unknown kind", "# T-7: x\n* status: draft\n* kind: feature\n", 2, /Unknown kind/],
  ])("reports %s on the right line", (_name, text, line, message) => {
    const [first] = errors(text);
    expect(first?.line).toBe(line);
    expect(first?.message).toMatch(message);
  });

  it("warns about a duplicate section and uses the first", () => {
    const result = parseTask("# T-1: x\n* status: draft\n## Updates\n* a · b · status: draft → ready\n## Updates\n", "T-1");
    expect(result.ok && result.warnings[0]?.line).toBe(4);
    expect(result.ok && result.value.statusEntries).toHaveLength(1);
  });

  it("ends the metadata list at the first line that isn't an item, and warns about stragglers", () => {
    const result = parseTask("# T-1: x\n* status: draft\n\n* kind: infrastructure\n", "T-1");
    expect(result.ok && result.value.kind).toBeUndefined();
    expect(result.ok && result.warnings[0]).toMatchObject({ line: 3, message: expect.stringMatching(/looks like metadata/) as unknown });
  });

  it("refuses a file with an unclosed code block", () => {
    const [first] = errors("# T-7: x\n* status: draft\n\n```\n## Updates\n");
    expect(first).toMatchObject({ line: 3, message: expect.stringMatching(/never closed/) as unknown });
  });

  it.each([
    ["a tilde fence", "~~~\n## Updates\n~~~"],
    ["a longer fence holding a shorter one", "````\n```\n## Updates\n```\n````"],
    ["a fence whose closer has text after it", "```\n``` not a closer\n## Updates\n```"],
  ])("keeps headings inside %s hidden", (_name, block) => {
    const task = ok(`# T-7: x\n* status: draft\n\n${block}\n`);
    expect(task.sections.map((s) => s.name)).toEqual([]);
  });

  it("ignores a closing run of # in headings", () => {
    expect(ok("# T-7: x\n* status: draft\n\n## Updates ##\n").sections.map((s) => s.name)).toEqual(["Updates"]);
  });

  it("reads multi-line answers and skips questions and entries inside code blocks", () => {
    const task = ok(
      [
        "# T-7: x",
        "* status: draft",
        "## Questions",
        "* [x] Q: Expire?",
        "",
        "      A: After an hour,",
        "      unless the user asks for longer.",
        "```",
        "* [ ] Q: example only",
        "```",
        "## Updates",
        "```",
        "* a · b · status: draft → done",
        "```",
        "",
      ].join("\n"),
    );
    expect(task.questions).toEqual([{ checked: true, question: "Expire?", answer: "After an hour,\nunless the user asks for longer.", line: 3 }]);
    expect(task.statusEntries).toEqual([]);
  });
});

// Builds a task file: title, metadata lines, then body lines.
const file = (meta: string[], body: string[] = [], title = "# T-7: Title") => [title, ...meta, "", ...body, ""].join("\n");
const warningsOf = (text: string) => {
  const result = parseTask(text, "T-7");
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return result.warnings;
};

describe("malformed titles", () => {
  it.each([
    ["no space after #", "#T-7: Title"],
    ["a level-2 heading", "## T-7: Title"],
    ["no colon", "# T-7 Title"],
    ["a lowercase id", "# t-7: Title"],
    ["no id", "# Title"],
    ["a blank first line", ""],
  ])("rejects %s", (_name, title) => {
    expect(errors(file(["* status: draft"], [], title))[0]).toMatchObject({ line: 0, message: expect.stringMatching(/first line/) as unknown });
  });

  it("rejects an empty title", () => {
    expect(errors(file(["* status: draft"], [], "# T-7:"))[0]?.message).toMatch(/title is empty/);
  });

  it("accepts a BOM before the title", () => {
    expect(ok(`\uFEFF${file(["* status: draft"])}`).title).toBe("Title");
  });
});

describe("malformed metadata", () => {
  it.each([
    ["an uppercase key", "* Status: draft"],
    ["no space after the bullet", "*status: draft"],
    ["no colon", "* status draft"],
    ["a + bullet", "+ status: draft"],
    ["a numbered item", "1. status: draft"],
    ["a table row", "| status | draft |"],
  ])("points at %s instead of reporting the status missing", (_name, line) => {
    expect(errors(file([line]))[0]).toMatchObject({ line: 1, message: expect.stringMatching(/isn't read as the status/) as unknown });
  });

  it.each([
    ["emphasis", "**ready**"],
    ["a trailing comment", "ready # started early"],
    ["a different case", "Ready"],
    ["an empty value", ""],
  ])("rejects a status with %s", (_name, value) => {
    expect(errors(file([`* status: ${value}`]))[0]?.message).toMatch(/Unknown status/);
  });

  it.each([
    ["no comma between links", "[[T-1]] [[T-2]]"],
    ["single brackets", "[T-1]"],
    ["an unclosed link", "[[T-1]"],
    ["a code span", "`[[T-1]]`"],
    ["a Markdown link", "[T-1](tasks/T-1.md)"],
  ])("rejects depends_on with %s", (_name, value) => {
    expect(errors(file(["* status: draft", `* depends_on: ${value}`]))[0]).toMatchObject({ line: 2, message: expect.stringMatching(/task links/) as unknown });
  });

  it("tolerates spaces inside links and stray commas, and warns about duplicates", () => {
    const text = file(["* status: draft", "* depends_on: [[ T-1 ]],, [[T-2]], [[T-1]]"]);
    expect(ok(text).dependsOn).toEqual(["T-1", "T-2"]);
    expect(warningsOf(text)[0]?.message).toMatch(/more than once/);
  });

  it("accepts an empty depends_on and an empty pipeline", () => {
    const task = ok(file(["* status: draft", "* depends_on:", "* pipeline:"]));
    expect(task.dependsOn).toEqual([]);
    expect(task.pipeline).toBeUndefined();
  });

  it("rejects an empty kind", () => {
    expect(errors(file(["* status: draft", "* kind:"]))[0]?.message).toMatch(/Unknown kind ""/);
  });
});

describe("malformed sections", () => {
  it.each([
    ["no space after ##", "##Updates"],
    ["a level-3 heading", "### Updates"],
    ["an indented heading", "  ## Updates"],
    ["a heading in a blockquote", "> ## Updates"],
    ["a setext heading", "Updates\n-------"],
  ])("doesn't read %s as a section", (_name, heading) => {
    expect(ok(file(["* status: draft"], [heading, "* a · b · status: draft → ready"])).sections).toEqual([]);
  });

  it("warns that section names are case-sensitive", () => {
    const text = file(["* status: draft"], ["## updates", "* a · b · status: draft → ready"]);
    expect(ok(text).statusEntries).toEqual([]);
    expect(warningsOf(text)[0]).toMatchObject({ line: 3, message: expect.stringMatching(/case-sensitive/) as unknown });
  });
});

describe("malformed questions and answers", () => {
  const questions = (...body: string[]) => file(["* status: needs-decision"], ["## Questions", ...body]);

  it.each([
    ["an empty checkbox", "* [] Q: Expire?"],
    ["no Q: marker", "* [ ] Expire?"],
    ["a numbered item", "1. [ ] Q: Expire?"],
    ["an unknown mark", "* [y] Q: Expire?"],
    ["no checkbox", "* Q: Expire?"],
  ])("warns about %s instead of silently ignoring it", (_name, line) => {
    const text = questions(line);
    expect(ok(text).questions).toEqual([]);
    expect(warningsOf(text)[0]?.message).toMatch(/looks like a question/);
  });

  it("accepts an uppercase X as checked", () => {
    expect(ok(questions("- [X] Q: Expire?")).questions[0]?.checked).toBe(true);
  });

  it("warns about an answer that isn't indented", () => {
    const text = questions("* [ ] Q: Expire?", "A: After an hour.");
    expect(ok(text).questions[0]?.answer).toBe("");
    expect(warningsOf(text)[0]?.message).toMatch(/Indent the answer/);
  });

  it("ignores an answer with no question above it", () => {
    expect(ok(questions("      A: orphan")).questions).toEqual([]);
  });
});

describe("malformed Updates entries", () => {
  const updates = (...body: string[]) => ok(file(["* status: draft"], ["## Updates", ...body])).statusEntries;

  it.each([
    ["an ASCII arrow", "* a · b · status: draft -> ready"],
    ["a missing target", "* a · b · status: draft →"],
    ["missing separators", "* status: draft → ready"],
    ["no bullet", "a · b · status: draft → ready"],
  ])("doesn't record %s as a status change", (_name, line) => {
    expect(updates(line)).toEqual([]);
  });

  it("records unknown status names, which the rules then skip", () => {
    expect(updates("* a · b · status: foo → bar")).toEqual([{ from: "foo", to: "bar", line: 4 }]);
  });
});

describe("common Markdown in task bodies", () => {
  const body = (...lines: string[]) => file(["* status: draft"], ["## Description", ...lines, "## Updates", "* a · b · status: draft → ready"]);

  it.each([
    ["a table", ["| field | value |", "| --- | --- |", "| status: | done |", "| ## Updates | x |"]],
    ["footnotes", ["See the RFC.[^1]", "", "[^1]: ## Updates is a heading in the RFC."]],
    ["an ordered list", ["1. status: done", "2. depends_on: [[T-9]]", "3) ## Updates"]],
    ["nested lists", ["* top", "    * [ ] Q: not a question here", "        * status: done"]],
    ["a blockquote", ["> * status: done", "> ## Updates"]],
    ["inline code", ["Run `## Updates` and `* status: done`."]],
    ["a single-line HTML comment", ["<!-- ## Updates -->"]],
    ["a multi-line HTML comment", ["<!--", "## Updates", "* x · y · status: draft → done", "-->"]],
    ["an indented code block", ["    ## Updates", "    * x · y · status: draft → done"]],
    ["links and images", ["[## Updates](x.md) ![status: done](a.png)"]],
  ])("reads %s as body text without affecting the task", (_name, lines) => {
    const task = ok(body(...lines));
    expect(task.status).toBe("draft");
    expect(task.dependsOn).toEqual([]);
    expect(task.sections.map((s) => s.name)).toEqual(["Description", "Updates"]);
    expect(task.statusEntries.map((e) => e.to)).toEqual(["ready"]);
  });

  it("refuses an unclosed HTML comment, which would hide the rest of the file", () => {
    expect(errors(body("<!-- draft notes"))[0]?.message).toMatch(/HTML comment is never closed/);
  });
});

describe("parseTasksIndex", () => {
  it("reads pipelines and finds the index section", () => {
    const result = parseTasksIndex(
      "# Tasks\n\n## Pipelines\n* default\n    * implement: [[agents/implementer]]\n    * review: [[agents/a]], [[agents/b]]\n\n## Index\n* [[T-1]] x · draft\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pipelines).toEqual([
      {
        name: "default",
        line: 3,
        roles: [
          { role: "implement", agents: ["agents/implementer"], line: 4 },
          { role: "review", agents: ["agents/a", "agents/b"], line: 5 },
        ],
      },
    ]);
    expect(result.value.index?.heading).toBe(7);
  });

  it.each([
    ["a role outside a pipeline", "## Pipelines\n    * implement: [[agents/x]]\n", /nested/],
    ["an agent that isn't a link", "## Pipelines\n* default\n    * implement: implementer\n", /links/],
    ["stray text", "## Pipelines\nprose\n", /Expected/],
  ])("reports %s", (_name, text, message) => {
    const result = parseTasksIndex(text);
    expect(!result.ok && result.errors[0]?.message).toMatch(message);
  });

  it.each([
    ["a role with no agents", "## Pipelines\n* default\n    * implement:\n", /names no agents/],
    ["an agent link leaving the repo", "## Pipelines\n* default\n    * implement: [[../outside]]\n", /stay inside the repository/],
    ["an absolute agent link", "## Pipelines\n* default\n    * implement: [[/etc/agent]]\n", /stay inside the repository/],
    ["a duplicate pipeline", "## Pipelines\n* default\n    * implement: [[agents/a]]\n* default\n", /already a pipeline/],
    ["an uppercase role", "## Pipelines\n* default\n    * Implement: [[agents/a]]\n", /Expected/],
    ["a numbered pipeline", "## Pipelines\n1. default\n", /Expected/],
    ["a table", "## Pipelines\n| pipeline | agents |\n", /Expected/],
    ["an unclosed code block", "## Pipelines\n```\n* default\n", /never closed/],
  ])("reports %s", (_name, text, message) => {
    const result = parseTasksIndex(text);
    expect(!result.ok && result.errors[0]?.message).toMatch(message);
  });

  it("ignores code blocks and comments inside Pipelines", () => {
    const result = parseTasksIndex("## Pipelines\n```\nnot a pipeline\n```\n<!-- note -->\n* default\n    * implement: [[agents/a]]\n");
    expect(result.ok && result.value.pipelines.map((p) => p.name)).toEqual(["default"]);
  });

  it("leaves whatever is in Index to the orchestrator", () => {
    expect(parseTasksIndex("## Index\n| a table | here |\nprose\n").ok).toBe(true);
  });

  it("accepts a file without pipelines or index", () => {
    expect(parseTasksIndex("# Tasks\n")).toEqual({ ok: true, value: { pipelines: [] }, warnings: [] });
  });
});
