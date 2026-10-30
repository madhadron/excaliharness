// Unit tests for the smaller runner pieces: agent definitions, the Quick
// reference, the capability check's script and interpretation, the derived
// Dockerfile, the CLI command and the scheduler.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgent, readAgent } from "../agents/agentDefs";
import type { Task } from "../tasks/model";
import { gatePrograms, parseQuickRef } from "../tasks/quickref";
import { checkScript, interpret } from "./capability";
import { KILL_GRACE_MS, run } from "./exec";
import { derivedDockerfile, pinnedTag } from "./images";
import { TaskProject } from "./project";
import { implementerPrompt, reviewerPrompt, systemPrompt, taskPrompt } from "./prompts";
import { AUTH_FAILURE, commitSubject, engineTooOld, MISSING_SESSION } from "./runner";
import { Scheduler } from "./scheduler";
import { cliCommand } from "./session";

describe("agent definitions", () => {
  it("reads model, tools and the role prompt", () => {
    const result = parseAgent("agents/implementer", "---\nname: implementer\nmodel: claude-sonnet-5-5\ntools: Read, Edit, Bash\n---\nYou implement tasks.\n");
    expect(result).toEqual({ ok: true, agent: { name: "agents/implementer", model: "claude-sonnet-5-5", tools: ["Read", "Edit", "Bash"], prompt: "You implement tasks." } });
  });

  it("reads tools as a YAML list too", () => {
    const result = parseAgent("agents/a", "---\ntools:\n  - Read\n  - Bash\nmodel: m\n---\nDo it.\n");
    expect(result.ok && result.agent.tools).toEqual(["Read", "Bash"]);
  });

  it.each([
    ["---\ntools:\n- Read\n- 'Bash'\n---\nDo it.\n", ["Read", "Bash"]],
    ['---\ntools: [Read, "Edit"]\n---\nDo it.\n', ["Read", "Edit"]],
  ])("reads YAML list forms %j", (text, tools) => {
    const result = parseAgent("agents/a", text);
    expect(result.ok && result.agent.tools).toEqual(tools);
  });

  it("unquotes the model and ignores comments and blank lines in lists", () => {
    const result = parseAgent("agents/a", "---\nmodel: \"inherit\"\ntools:\n  - Read # look\n\n  # more\n  - Bash\n---\nDo it.\n");
    expect(result.ok && result.agent).toMatchObject({ model: "inherit", tools: ["Read", "Bash"] });
    expect(parseAgent("agents/a", "---\ntools: []\n---\nDo it.\n")).toMatchObject({ ok: false, error: expect.stringMatching(/lists no tools/) as unknown });
  });

  it("refuses an agent without tools (D-079)", () => {
    const result = parseAgent("agents/a", "---\nmodel: m\n---\nDo it.\n");
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/no tools: line/) as unknown });
  });

  it("refuses an empty prompt, and links outside agents/ (D-078)", () => {
    expect(parseAgent("agents/x", "---\nmodel: m\n---\n\n").ok).toBe(false);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "agents-"));
    for (const bad of ["../etc/passwd", "docs/decisions", "agents/../x", "agents/a/b"]) expect(readAgent(root, bad).ok).toBe(false);
    expect(readAgent(root, "agents/missing")).toEqual({ ok: false, error: "agents/missing.md doesn't exist" });
    fs.rmSync(root, { recursive: true, force: true });
  });
});

describe("Quick reference", () => {
  const readme = "Intro.\n\n# Quick reference\n\n```\n# Run tests (required gate)\nmake test\nnpm run lint\n\n# Reset the database\n./scripts/reset.sh\n# Build (required gate)\nCI=1 cargo build\n```\n\n# Other\n";

  it("reads labels, commands and gates (D-020)", () => {
    const ref = parseQuickRef(readme);
    expect(ref?.entries).toEqual([
      { label: "Run tests", commands: ["make test", "npm run lint"], gate: true },
      { label: "Reset the database", commands: ["./scripts/reset.sh"], gate: false },
      { label: "Build", commands: ["CI=1 cargo build"], gate: true },
    ]);
    expect(ref?.text.startsWith("# Quick reference")).toBe(true);
    expect(ref?.text).not.toContain("# Other");
  });

  it("lists the programs the gates call", () => {
    const ref = parseQuickRef(readme);
    expect(ref && gatePrograms(ref)).toEqual(["make", "npm", "cargo"]);
  });

  it("closes a fence only with the same kind (CommonMark)", () => {
    const ref = parseQuickRef("# Quick reference\n\n```\n# Test (required gate)\nmake test\n~~~\nmake more\n```\n");
    expect(ref?.entries[0]?.commands).toEqual(["make test", "~~~", "make more"]);
  });

  it("is undefined without the section or its code block", () => {
    expect(parseQuickRef("# Readme\n")).toBeUndefined();
    expect(parseQuickRef("# Quick reference\n\nprose only\n")).toBeUndefined();
  });
});

describe("capability check", () => {
  it("puts only valid program names in the script", () => {
    const script = checkScript(["make", "rm -rf /", "$(evil)", "npm"]);
    expect(script).toContain("'gate:make'");
    expect(script).toContain("'gate:npm'");
    expect(script).not.toContain("evil");
    expect(script).not.toContain("rm -rf");
  });

  it("turns failures into specific messages", () => {
    const result = interpret(["claude=ok:2.1.310 (Claude Code)", "libc=fail:musl", "git=ok", "user=fail:root", "gate:cargo=fail:missing", "proxy=ok"].join("\n"));
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(/musl \(Alpine\)/);
    expect(result.problems.join("\n")).toMatch(/runs as root/);
    expect(result.problems.join("\n")).toMatch(/`cargo`/);
  });

  it("passes when everything is ok, and fails if the script never ran", () => {
    expect(interpret("claude=ok:2.1.310\ngit=ok\nuser=ok:1000").ok).toBe(true);
    expect(interpret("docker: no such image").ok).toBe(false);
  });
});

describe("derived image", () => {
  it("builds from pinned tags, never bare IDs (E-008)", () => {
    const text = derivedDockerfile(`sha256:${"d".repeat(64)}`, `sha256:${"b".repeat(64)}`);
    expect(text).toContain(`FROM ${pinnedTag(`sha256:${"b".repeat(64)}`)} AS claude`);
    expect(text).toContain(`FROM excaliharness-pinned:${"d".repeat(64)}`);
    expect(text).not.toMatch(/FROM sha256:/);
    expect(text.trim().endsWith("USER 1000:1000")).toBe(true);
  });
});

describe("cliCommand", () => {
  it("runs the CLI with the SDK's arguments in the task's project (E-006)", () => {
    const project = new TaskProject(() => Promise.reject(new Error("unused")), "/s", "/repo", "excaliharness-t-1", ["/repo/compose.yaml", "/state/override.yaml"]);
    expect(cliCommand(project, "dev", { args: ["--output-format", "stream-json"] })).toEqual([
      "compose", "--project-directory", "/repo", "-p", "excaliharness-t-1", "-f", "/repo/compose.yaml", "-f", "/state/override.yaml",
      "run", "--rm", "-i", "-T", "--no-deps", "dev", "claude", "--output-format", "stream-json",
    ]);
    expect(cliCommand(project, "dev", { args: ["/sdk/cli.js", "--verbose"] }).slice(-2)).toEqual(["claude", "--verbose"]);
  });
});

describe("Scheduler", () => {
  const task = (id: string, status: Task["status"]): Task => ({
    id,
    title: id,
    status,
    statusLine: 1,
    dependsOn: [],
    metadata: [],
    sections: [],
    questions: [],
    statusEntries: [],
  });

  it("starts ready tasks in id order up to the limit, resuming in-implementation ones first", async () => {
    const started: string[] = [];
    const finish: (() => void)[] = [];
    const scheduler = new Scheduler(
      (id) => {
        started.push(id);
        return new Promise<void>((r) => finish.push(r));
      },
      2,
      () => {},
    );
    scheduler.consider([task("T-10", "ready"), task("T-2", "ready"), task("T-5", "in-implementation"), task("T-1", "draft")]);
    expect(started).toEqual(["T-5", "T-2"]);
    // Running tasks are never started twice.
    scheduler.consider([task("T-5", "in-implementation"), task("T-2", "ready"), task("T-10", "ready")]);
    expect(started).toEqual(["T-5", "T-2"]);
    finish[0]?.();
    await new Promise((r) => setTimeout(r, 0));
    scheduler.consider([task("T-2", "ready"), task("T-10", "ready")]);
    expect(started).toEqual(["T-5", "T-2", "T-10"]);
  });

  it("aborts running tasks when stopped, and starts nothing after", () => {
    const aborts: AbortController[] = [];
    const scheduler = new Scheduler(
      (_id, abort) => {
        aborts.push(abort);
        return new Promise<void>(() => {});
      },
      2,
      () => {},
    );
    scheduler.consider([task("T-1", "ready")]);
    scheduler.stopAll();
    expect(aborts[0]?.signal.aborted).toBe(true);
    scheduler.consider([task("T-2", "ready")]);
    expect(aborts).toHaveLength(1);
  });

  it("aborts one task, and waits for running tasks to finish", async () => {
    const aborts = new Map<string, AbortController>();
    let finishT1!: () => void;
    const scheduler = new Scheduler(
      (id, abort) => {
        aborts.set(id, abort);
        return id === "T-1" ? new Promise<void>((r) => (finishT1 = r)) : Promise.resolve();
      },
      2,
      () => {},
    );
    scheduler.consider([task("T-1", "ready"), task("T-2", "ready")]);
    scheduler.abort("T-1", "status changed");
    expect(aborts.get("T-1")?.signal.reason).toBe("status changed");
    expect(aborts.get("T-2")?.signal.aborted).toBe(false);
    let idle = false;
    const waiting = scheduler.idle().then(() => (idle = true));
    await new Promise((r) => setTimeout(r, 0));
    expect(idle).toBe(false);
    finishT1();
    await waiting;
    expect(scheduler.runningIds).toEqual([]);
  });
});

describe("CLI error patterns", () => {
  it("recognizes a rejected token, as the CLI prints it", () => {
    expect(AUTH_FAILURE.test("Failed to authenticate. API Error: 401 OAuth access token is invalid.")).toBe(true);
    expect(AUTH_FAILURE.test("OAuth token has expired")).toBe(true);
    expect(AUTH_FAILURE.test("API Error: 529 overloaded")).toBe(false);
  });

  it("recognizes a session that can't be resumed, as the pinned CLI prints it", () => {
    expect(MISSING_SESSION.test("No conversation found with session ID: 1234")).toBe(true);
    expect(MISSING_SESSION.test("No session found with ID 1234.")).toBe(true);
    expect(MISSING_SESSION.test("Failed to authenticate. API Error: 401")).toBe(false);
  });
});

describe("task prompt", () => {
  it("fences the diff so a backtick run in it can't close the fence", () => {
    const task = { id: "T-1", title: "t", status: "ready", statusLine: 1, dependsOn: [], metadata: [], sections: [], questions: [], statusEntries: [] } as unknown as Task;
    const prompt = taskPrompt(task, "# T-1: t\n", "+```\n+evil\n");
    expect(prompt).toContain("````diff\n+```\n+evil\n\n````");
  });
});

describe("commitSubject", () => {
  it("takes the first sentence and cuts at a word", () => {
    expect(commitSubject("T-001", "Added hello.js. More detail.")).toBe("T-001: Added hello.js.");
    expect(commitSubject("T-001", "Tidied tests, e.g. the parser. Then more.")).toBe("T-001: Tidied tests, e.g. the parser.");
    const long = "Added /workspace/hello.js, which does console.log('hello') and also several other things that are long";
    const subject = commitSubject("T-001", long);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject).toMatch(/^T-001: Added \/workspace\/hello\.js, which does .*\S…$/);
    expect(long.startsWith(subject.slice(7, -1))).toBe(true);
  });
});

describe("round prompts (D-072, D-082)", () => {
  const task = { id: "T-1", title: "t", status: "ready", statusLine: 1, dependsOn: [], metadata: [], sections: [], questions: [{ checked: true, question: "Which?", answer: "This one", line: 5 }], statusEntries: [] } as unknown as Task;
  const failure = { label: "Run unit tests", commands: ["make test"], code: 1, timedOut: false, output: "1 failed" };
  const finding = { severity: "nit" as const, file: "a.ts", line: 3, summary: "rename x", reviewer: "agents/r" };

  it("gives a resumed implementer only what the last round left open", () => {
    const prompt = implementerPrompt({ task, text: "# T-1: t\n", diff: "", round: 2, failures: [failure], findings: [finding], resumed: true, answered: false });
    expect(prompt).not.toContain("# T-1: t");
    expect(prompt).toContain("Round 2: fix everything below, nits included");
    expect(prompt).toContain("`Run unit tests` failed (exit 1)");
    expect(prompt).toContain("nit · a.ts:3 · rename x (agents/r)");
  });

  it("gives a fresh implementer the task, and an answered question when resuming", () => {
    expect(implementerPrompt({ task, text: "# T-1: t\n", diff: "", round: 1, failures: [], findings: [], resumed: false, answered: false })).toContain("# T-1: t");
    expect(implementerPrompt({ task, text: "", diff: "", round: 1, failures: [], findings: [], resumed: true, answered: true })).toContain("The human answered:\n\n- Q: Which?\n  A: This one");
  });

  it("gives reviewers the whole change and last round's findings to check", () => {
    const prompt = reviewerPrompt({ task, text: "# T-1: t\n", diff: "+x", round: 2, previous: [finding] });
    expect(prompt).toContain("Review, round 2");
    expect(prompt).toContain("```diff\n+x\n```");
    expect(prompt).toContain("check these were fixed");
    const agent = { name: "agents/r", tools: ["Read"], prompt: "You review." };
    expect(systemPrompt(agent, "reviewer", undefined, undefined)).toContain("report_findings");
    expect(systemPrompt(agent, "implementer", undefined, undefined)).toContain("finish tool");
  });
});

describe("engine version (CVE-2024-29018)", () => {
  it.each([
    ["25.0.5", true],
    ["23.0.11", true],
    ["26.0.0", false],
    ["27.3.1", false],
    ["28.0.0-rc.1", false],
    ["", true],
  ])("%s too old: %s", (version, old) => {
    expect(engineTooOld(version)).toBe(old);
  });
});

describe("run", () => {
  it("stops a command on abort, killing it if it ignores SIGINT", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const pending = run("sh", ["-c", "trap '' INT; exec sleep 30"], { signal: abort.signal });
    setTimeout(() => abort.abort(), 50);
    const result = await pending;
    expect(result.code).toBeNull();
    expect(Date.now() - started).toBeLessThan(KILL_GRACE_MS + 5_000);
  }, KILL_GRACE_MS + 10_000);

  it("reports output beyond the capture limit as truncated", async () => {
    const result = await run("sh", ["-c", "head -c 5000000 /dev/zero"]);
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBe(4 * 1024 * 1024);
  });
});
