// What a round found (D-072, D-083): reviewers' findings and failed gates,
// and how they are written into the task's Updates.
import * as path from "node:path";
import { inertLine, printable, printableLine } from "./clean";

export type Severity = "blocking" | "nit";

export interface Finding {
  severity: Severity;
  // Relative to the repository root.
  file?: string;
  line?: number;
  summary: string;
  detail?: string;
  // The agent that reported it, e.g. "agents/security-reviewer".
  reviewer: string;
}

export interface GateFailure {
  // The Quick reference label, e.g. "Run unit tests".
  label: string;
  commands: string[];
  code: number | null;
  timedOut: boolean;
  // The end of its output.
  output: string;
}

// A finding as a reviewer sent it, checked and cleaned: it is agent text.
export function cleanFinding(raw: { severity: string; file?: string | undefined; line?: number | undefined; summary: string; detail?: string | undefined }, reviewer: string): Finding {
  const finding: Finding = {
    severity: raw.severity === "blocking" ? "blocking" : "nit",
    summary: printableLine(raw.summary).slice(0, 300) || "(no summary)",
    reviewer,
  };
  // Plain relative paths only: they become links in the task file.
  const file = raw.file === undefined ? "" : printableLine(raw.file).replace(/^\/workspace\//, "").slice(0, 200);
  if (/^[A-Za-z0-9._/@+-]+$/.test(file) && !path.isAbsolute(file) && !file.split("/").includes("..")) finding.file = path.posix.normalize(file);
  if (finding.file && raw.line !== undefined && Number.isInteger(raw.line) && raw.line > 0) finding.line = raw.line;
  if (raw.detail) finding.detail = printable(raw.detail).slice(0, 2_000);
  return finding;
}

// A gate by its command when it has one, else its label.
const gateName = (f: GateFailure) => (f.commands.length === 1 && f.commands[0] ? f.commands[0] : f.label).replace(/`/g, "'").slice(0, 80);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// One Updates line per round: "round 2: `make test` failed; 3 findings (1 blocking)".
export function roundLine(round: number, failures: GateFailure[], findings: Finding[]): string {
  const gates = failures.length ? `${failures.map((f) => `\`${gateName(f)}\``).join(", ")} failed` : "gates passed";
  const blocking = findings.filter((f) => f.severity === "blocking").length;
  const found = findings.length ? `${plural(findings.length, "finding")} (${blocking} blocking)` : "no findings";
  return `round ${round}: ${gates}; ${found}`;
}

// The open failures and findings as Updates lines, each finding linking to
// its file in the worktree; at most `limit`, then "and N more" (D-083).
export function openLines(failures: GateFailure[], findings: Finding[], worktree: string, limit = 20): string[] {
  const lines = [
    ...failures.map((f) => `gate \`${gateName(f)}\` ${f.timedOut ? "ran over its time limit" : `failed (exit ${f.code ?? "?"})`}`),
    ...findings.map((f) => {
      // " - ", not " · ", which only status entries use (D-079).
      const where = f.file ? `[${f.file}${f.line ? `:${f.line}` : ""}](<${path.join(worktree, f.file)}${f.line ? `#L${f.line}` : ""}>) - ` : "";
      // The summary is agent text: escaped so it can't add links (D-079).
      return `${f.severity} - ${where}${inertLine(f.summary)} (${f.reviewer})`;
    }),
  ];
  return lines.length > limit ? [...lines.slice(0, limit), `and ${lines.length - limit} more`] : lines;
}
