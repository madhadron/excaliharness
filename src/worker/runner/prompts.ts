// What an agent is told (D-073): everything comes from files the human can
// review in the main checkout, plus the task's own sections and what the
// last round found.
import type { AgentDef } from "../agents/agentDefs";
import type { Task } from "../tasks/model";
import { splitText } from "../tasks/text";
import type { Finding, GateFailure } from "./findings";
import type { Role } from "./session";

const COMMON = `- tasks/, TASKS.md, agents/ and docs/decisions.md are read-only. Don't try to change task statuses or decisions.
- You can't install packages or reach the internet.
- Follow the project decisions below. If the work needs a decision they don't cover, call the ask_question tool with one clear question and stop, instead of guessing.`;

const RULES: Record<Role, string> = {
  implementer: `## How you work here
- You are working on one task in /workspace, a copy of the project on the task's own branch. Edit files there; the orchestrator commits your changes after your turn. /workspace isn't a git repository (its .git is an empty read-only file), so don't run git there, and don't create nested repositories.
${COMMON}
- If the work needs a new dependency, add it to the Dockerfile or the project's dependency files; the human approves the rebuild before your next turn.
- After your turn the project's required gates run and reviewers look at your changes. Everything they report must be fixed, nits included.
- When you have finished this turn's work, call the finish tool with a summary, then stop.`,
  reviewer: `## How you work here
- You are reviewing one task's changes. /workspace is the project with those changes, read-only: you can read and run things, but not change them.
${COMMON}
- Report every problem you find, blocking or nit, with the file (relative to /workspace) and line where you can. A nit is anything you would still want changed before merging.
- When you have finished, call the report_findings tool once with all of them (an empty list if there are none), then stop.`,
};

export function systemPrompt(agent: AgentDef, role: Role, decisions: string | undefined, quickRef: string | undefined): string {
  return [
    agent.prompt,
    RULES[role],
    decisions ? `## Project decisions (docs/decisions.md)\n\n${decisions}` : "",
    quickRef ? `## Commands for this project (README)\n\n${quickRef}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function section(lines: string[], task: Task, name: string): string {
  const s = task.sections.find((x) => x.name === name);
  return s ? lines.slice(s.heading + 1, s.end).join("\n").trim() : "";
}

// A code block that nothing in `text` can close early.
function fenced(text: string, info: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = "`".repeat(longest + 1);
  return `${fence}${info}\n${text}\n${fence}`;
}

// The task itself: its sections and answered questions.
export function taskPrompt(task: Task, text: string, diffSoFar: string): string {
  const { lines } = splitText(text);
  const parts = [`# ${task.id}: ${task.title}`];
  for (const name of ["Description", "Context", "Issue", "Expectation"]) {
    const body = section(lines, task, name);
    if (body) parts.push(`## ${name}\n\n${body}`);
  }
  const answered = task.questions.filter((q) => q.checked);
  if (answered.length) parts.push(`## Answered questions\n\n${answered.map((q) => `- Q: ${q.question}\n  A: ${q.answer}`).join("\n")}`);
  if (diffSoFar.trim()) parts.push(`## Changes made on this task so far\n\n${fenced(diffSoFar, "diff")}`);
  return parts.join("\n\n");
}

function failureText(failures: GateFailure[]): string {
  return failures
    .map((f) => `### \`${f.label}\` ${f.timedOut ? "ran over its time limit" : `failed (exit ${f.code ?? "?"})`}\n\nCommands: ${f.commands.map((c) => `\`${c}\``).join(", ")}\n\n${fenced(f.output, "")}`)
    .join("\n\n");
}

function findingText(findings: Finding[]): string {
  return findings
    .map((f) => `- ${f.severity}${f.file ? ` · ${f.file}${f.line ? `:${f.line}` : ""}` : ""} · ${f.summary} (${f.reviewer})${f.detail ? `\n  ${f.detail.replace(/\n/g, "\n  ")}` : ""}`)
    .join("\n");
}

// What the implementer is asked to do this round: the task the first time,
// then what the last round's gates and reviewers left open (D-072).
export function implementerPrompt(options: { task: Task; text: string; diff: string; round: number; failures: GateFailure[]; findings: Finding[]; resumed: boolean; answered: boolean }): string {
  const parts: string[] = [];
  if (!options.resumed) parts.push(taskPrompt(options.task, options.text, options.diff));
  if (options.answered) {
    const answered = options.task.questions.filter((q) => q.checked);
    parts.push(`The human answered:\n\n${answered.map((q) => `- Q: ${q.question}\n  A: ${q.answer}`).join("\n")}\n\nContinue the task with these answers.`);
  }
  if (options.failures.length || options.findings.length) {
    parts.push(`# Round ${options.round}: fix everything below, nits included`);
    if (options.failures.length) parts.push(`## Required gates that failed\n\n${failureText(options.failures)}`);
    if (options.findings.length) parts.push(`## Reviewers' findings\n\n${findingText(options.findings)}`);
  } else if (options.resumed && !options.answered) {
    parts.push(`# Round ${options.round}\n\nContinue the task.`);
  }
  return parts.join("\n\n");
}

// What a reviewer is given: the task, the whole change so far, and what the
// last round found, only to check it was fixed (D-082).
export function reviewerPrompt(options: { task: Task; text: string; diff: string; round: number; previous: Finding[] }): string {
  const parts = [taskPrompt(options.task, options.text, ""), `# Review, round ${options.round}`, `## The task's changes\n\n${fenced(options.diff || "(no changes)", "diff")}`];
  if (options.previous.length) parts.push(`## Found in the last round (check these were fixed; report any that weren't)\n\n${findingText(options.previous)}`);
  return parts.join("\n\n");
}
