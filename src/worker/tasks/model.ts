// Parsed form of task files and TASKS.md (docs/task-format.md). Line numbers
// are 0-based indexes into the file's lines, so edits can target them (D-030).

export const STATUSES = [
  "draft",
  "waiting-for-dependencies",
  "ready",
  "in-ui-development",
  "in-implementation",
  "review",
  "done",
  "needs-decision",
  "needs-human",
] as const;

export type Status = (typeof STATUSES)[number];

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export interface MetadataItem {
  key: string;
  value: string;
  line: number;
}

export interface Section {
  name: string;
  // The heading line; the body runs from heading + 1 up to `end` (exclusive).
  heading: number;
  end: number;
}

export interface Question {
  checked: boolean;
  question: string;
  answer: string;
  line: number;
}

export interface StatusEntry {
  from: string;
  to: string;
  line: number;
}

export interface Task {
  id: string;
  title: string;
  status: Status;
  statusLine: number;
  dependsOn: string[];
  kind?: "infrastructure";
  pipeline?: string;
  metadata: MetadataItem[];
  sections: Section[];
  questions: Question[];
  // Status changes recorded in ## Updates, oldest first.
  statusEntries: StatusEntry[];
}

export interface Pipeline {
  name: string;
  roles: { role: string; agents: string[]; line: number }[];
  line: number;
}

export interface TasksIndex {
  pipelines: Pipeline[];
  // The ## Index section, if present.
  index?: Section;
}

export type Severity = "error" | "warning";

export interface Diagnostic {
  line: number;
  severity: Severity;
  message: string;
}

export type ParseResult<T> = { ok: true; value: T; warnings: Diagnostic[] } | { ok: false; errors: Diagnostic[] };
