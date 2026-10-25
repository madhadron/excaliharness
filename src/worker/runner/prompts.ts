// What an agent is told (D-073): everything comes from files the human can
// review in the main checkout, plus the task's own sections.
import type { AgentDef } from "../agents/agentDefs";
import type { Task } from "../tasks/model";
import { splitText } from "../tasks/text";

const RULES = `## How you work here
- You are working on one task in /workspace, a copy of the project on the task's own branch. Edit files there; the orchestrator commits your changes after your turn. /workspace isn't a git repository (its .git is an empty read-only file), so don't run git there, and don't create nested repositories.
- tasks/, TASKS.md, agents/ and docs/decisions.md are read-only. Don't try to change task statuses or decisions.
- You can't install packages or reach the internet. If the work needs a new dependency, add it to the Dockerfile or the project's dependency files; the image is rebuilt before your next turn.
- Follow the project decisions below. If something needs a decision they don't cover, say so in your summary instead of guessing.
- When you have finished this turn's work, call the finish tool with a summary, then stop.`;

export function systemPrompt(agent: AgentDef, decisions: string | undefined, quickRef: string | undefined): string {
  return [
    agent.prompt,
    RULES,
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

export function taskPrompt(task: Task, text: string, diffSoFar: string): string {
  const { lines } = splitText(text);
  const parts = [`# ${task.id}: ${task.title}`];
  for (const name of ["Description", "Context", "Issue", "Expectation"]) {
    const body = section(lines, task, name);
    if (body) parts.push(`## ${name}\n\n${body}`);
  }
  const answered = task.questions.filter((q) => q.checked);
  if (answered.length) parts.push(`## Answered questions\n\n${answered.map((q) => `- Q: ${q.question}\n  A: ${q.answer}`).join("\n")}`);
  if (diffSoFar.trim()) {
    // A fence longer than any backtick run in the diff, so it can't close early.
    const longest = Math.max(2, ...[...diffSoFar.matchAll(/`+/g)].map((m) => m[0].length));
    const fence = "`".repeat(longest + 1);
    parts.push(`## Changes made on this task so far\n\n${fence}diff\n${diffSoFar}\n${fence}`);
  }
  return parts.join("\n\n");
}
