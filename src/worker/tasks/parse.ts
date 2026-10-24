// Line-based parser for task files and TASKS.md (D-030, docs/task-format.md).
import {
  isStatus,
  STATUSES,
  type Diagnostic,
  type MetadataItem,
  type ParseResult,
  type Pipeline,
  type Question,
  type Section,
  type StatusEntry,
  type Task,
  type TasksIndex,
} from "./model";
import { splitText } from "./text";

const TITLE = /^# (T-\d+):[ \t]*(.*?)[ \t]*$/;
const META = /^[*-][ \t]+([a-z][a-z_]*):[ \t]*(.*?)[ \t]*$/;
// A closing run of #s is not part of the heading text (CommonMark).
const HEADING = /^## +(.+?)(?:[ \t]+#+)?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const QUESTION = /^[*-][ \t]+\[([ xX])\][ \t]+Q:[ \t]*(.*?)[ \t]*$/;
const ANSWER = /^[ \t]+A:[ \t]?(.*?)[ \t]*$/;
const STATUS_ENTRY = /^[*-][ \t]+.* · .* · status: (\S+) → (\S+)(?: · .*)?$/;
const WIKILINK = /^\[\[([^\]\n]+)\]\]$/;
const TASK_ID = /^T-\d+$/;
const PIPELINE = /^[*-][ \t]+(\S.*?)[ \t]*$/;
const ROLE = /^[ \t]+[*-][ \t]+([a-z][a-z_-]*):[ \t]*(.*?)[ \t]*$/;
// Any list item, bulleted or numbered, for spotting near-misses.
const LIST_ITEM = /^[ \t]*(?:[*+-]|\d+[.)])[ \t]/;

export interface Fence {
  // A fenced code block or HTML comment that never closes, if any.
  unclosed?: { line: number; message: string };
  // Lines inside fenced code blocks and HTML comments, including the lines
  // that open and close them.
  inside: Set<number>;
}

// Finds the lines whose Markdown syntax doesn't count: fenced code blocks and
// HTML comments. A fence closes only with the same character, at least as
// many of them, and nothing else on the line (CommonMark).
export function findFences(lines: string[]): Fence {
  const inside = new Set<number>();
  let open: { marker: string; line: number } | undefined;
  lines.forEach((line, i) => {
    if (open) {
      inside.add(i);
      if (open.marker === "<!--") {
        if (line.includes("-->")) open = undefined;
        return;
      }
      const f = FENCE.exec(line);
      const closes = f?.[1] && f[1][0] === open.marker[0] && f[1].length >= open.marker.length && (f[2] ?? "").trim() === "";
      if (closes) open = undefined;
      return;
    }
    if (/^ {0,3}<!--/.test(line)) {
      inside.add(i);
      if (!line.slice(line.indexOf("<!--") + 4).includes("-->")) open = { marker: "<!--", line: i };
      return;
    }
    const f = FENCE.exec(line);
    if (f?.[1] && !(f[1][0] === "`" && (f[2] ?? "").includes("`"))) {
      open = { marker: f[1], line: i };
      inside.add(i);
    }
  });
  if (!open) return { inside };
  const what = open.marker === "<!--" ? "HTML comment is never closed; close it with -->" : "code block is never closed; close it with a matching fence";
  return { unclosed: { line: open.line, message: `This ${what}.` }, inside };
}

export function parseSections(lines: string[], fences: Fence = findFences(lines)): Section[] {
  const sections: Section[] = [];
  lines.forEach((line, i) => {
    if (fences.inside.has(i)) return;
    const h = HEADING.exec(line);
    if (h?.[1]) {
      const previous = sections[sections.length - 1];
      if (previous) previous.end = i;
      sections.push({ name: h[1], heading: i, end: lines.length });
    }
  });
  return sections;
}

// Splits a comma-separated list of wikilinks, returning the targets, or the
// first entry that isn't one.
export function parseWikilinkList(value: string): { targets: string[] } | { bad: string } {
  const targets: string[] = [];
  for (const raw of value.split(",")) {
    const entry = raw.trim();
    if (entry === "") continue;
    const m = WIKILINK.exec(entry);
    if (!m?.[1]) return { bad: entry };
    targets.push(m[1].trim());
  }
  return { targets };
}

function firstSection(sections: Section[], name: string, warnings: Diagnostic[]): Section | undefined {
  const matching = sections.filter((s) => s.name === name);
  for (const near of sections.filter((s) => s.name !== name && s.name.toLowerCase() === name.toLowerCase())) {
    warnings.push({ line: near.heading, severity: "warning", message: `Section names are case-sensitive: "## ${near.name}" isn't read as "## ${name}".` });
  }
  for (const extra of matching.slice(1)) {
    warnings.push({ line: extra.heading, severity: "warning", message: `Duplicate "## ${name}" section; only the first is used.` });
  }
  return matching[0];
}

export function parseTask(text: string, expectedId: string): ParseResult<Task> {
  const { lines } = splitText(text);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const error = (line: number, message: string) => errors.push({ line, severity: "error", message });

  const title = TITLE.exec(lines[0] ?? "");
  if (!title?.[1]) {
    error(0, `The first line must be "# ${expectedId}: Title".`);
    return { ok: false, errors };
  }
  if (title[1] !== expectedId) error(0, `The title says ${title[1]}, but the file is ${expectedId}.md.`);
  if (!title[2]) error(0, `The title is empty; write it as "# ${expectedId}: Title".`);

  const fences = findFences(lines);
  if (fences.unclosed) {
    // Everything after it would be hidden, including ## Updates, and the
    // orchestrator would keep appending a new one inside it.
    error(fences.unclosed.line, fences.unclosed.message);
    return { ok: false, errors };
  }
  const sections = parseSections(lines, fences);
  const metadataEnd = sections[0]?.heading ?? lines.length;
  const metadata: MetadataItem[] = [];
  let i = 1;
  while (i < metadataEnd && lines[i]?.trim() === "") i++;
  for (; i < metadataEnd; i++) {
    const m = META.exec(lines[i] ?? "");
    if (!m?.[1]) break;
    metadata.push({ key: m[1], value: m[2] ?? "", line: i });
  }
  for (let j = i; j < metadataEnd; j++) {
    const m = META.exec(lines[j] ?? "");
    if (m?.[1] && !fences.inside.has(j)) {
      warnings.push({ line: j, severity: "warning", message: `"${m[1]}" looks like metadata but isn't read: the metadata list must come right after the title, with no blank lines or text inside it.` });
      break;
    }
  }

  const byKey = new Map<string, MetadataItem>();
  for (const item of metadata) {
    if (byKey.has(item.key)) error(item.line, `Duplicate metadata key "${item.key}".`);
    else byKey.set(item.key, item);
  }

  const statusItem = byKey.get("status");
  if (!statusItem) {
    // Point at a line that was probably meant to be the status, if any.
    let near = -1;
    for (let l = 1; l < metadataEnd; l++) {
      if (!fences.inside.has(l) && /status/i.test(lines[l] ?? "")) {
        near = l;
        break;
      }
    }
    if (near >= 0) error(near, `This isn't read as the status. Write it as "* status: draft" in the list right after the title.`);
    else error(1, `Missing "* status: ..." in the metadata list after the title.`);
  }
  else if (!isStatus(statusItem.value)) {
    error(statusItem.line, `Unknown status "${statusItem.value}". Use one of: ${STATUSES.join(", ")}.`);
  }

  let dependsOn: string[] = [];
  const depsItem = byKey.get("depends_on");
  if (depsItem) {
    const parsed = parseWikilinkList(depsItem.value);
    if ("bad" in parsed) error(depsItem.line, `depends_on entries must be task links like [[T-001]]; got "${parsed.bad}".`);
    else {
      for (const target of parsed.targets) {
        if (!TASK_ID.test(target)) error(depsItem.line, `depends_on entries must be task links like [[T-001]]; got "[[${target}]]".`);
        else if (target === expectedId) error(depsItem.line, `${expectedId} can't depend on itself.`);
      }
      dependsOn = [...new Set(parsed.targets)];
      if (dependsOn.length < parsed.targets.length) {
        warnings.push({ line: depsItem.line, severity: "warning", message: "depends_on lists the same task more than once." });
      }
    }
  }

  const kindItem = byKey.get("kind");
  if (kindItem && kindItem.value !== "infrastructure") {
    error(kindItem.line, `Unknown kind "${kindItem.value}". The only kind is "infrastructure".`);
  }

  const questions: Question[] = [];
  const questionSection = firstSection(sections, "Questions", warnings);
  if (questionSection) {
    let current: Question | undefined;
    let answering = false;
    for (let l = questionSection.heading + 1; l < questionSection.end; l++) {
      if (fences.inside.has(l)) continue;
      const line = lines[l] ?? "";
      const q = QUESTION.exec(line);
      if (q) {
        current = { checked: q[1] !== " ", question: q[2] ?? "", answer: "", line: l };
        questions.push(current);
        answering = false;
        continue;
      }
      if (LIST_ITEM.test(line) && /\bQ:|\[.?\]/.test(line)) {
        warnings.push({ line: l, severity: "warning", message: 'This looks like a question but isn\'t read as one, so nothing waits for it. Write it as "* [ ] Q: ...".' });
        continue;
      }
      if (current && !answering && /^A:/.test(line)) {
        warnings.push({ line: l, severity: "warning", message: "Indent the answer so it belongs to the question above it." });
        continue;
      }
      if (!current) continue;
      const a = ANSWER.exec(line);
      if (a && !answering) {
        current.answer = a[1] ?? "";
        answering = true;
      } else if (answering && /^[ \t]+\S/.test(line)) {
        // Indented lines after "A:" continue the answer.
        current.answer = current.answer ? `${current.answer}\n${line.trim()}` : line.trim();
      }
    }
  }

  const statusEntries: StatusEntry[] = [];
  const updates = firstSection(sections, "Updates", warnings);
  if (updates) {
    for (let l = updates.heading + 1; l < updates.end; l++) {
      if (fences.inside.has(l)) continue;
      const m = STATUS_ENTRY.exec(lines[l] ?? "");
      if (m?.[1] && m[2]) statusEntries.push({ from: m[1], to: m[2], line: l });
    }
  }

  if (errors.length > 0 || !statusItem || !isStatus(statusItem.value)) return { ok: false, errors };
  const task: Task = {
    id: expectedId,
    title: title[2] ?? "",
    status: statusItem.value,
    statusLine: statusItem.line,
    dependsOn,
    metadata,
    sections,
    questions,
    statusEntries,
  };
  if (kindItem) task.kind = "infrastructure";
  const pipeline = byKey.get("pipeline")?.value;
  if (pipeline) task.pipeline = pipeline;
  return { ok: true, value: task, warnings };
}

export function parseTasksIndex(text: string): ParseResult<TasksIndex> {
  const { lines } = splitText(text);
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const fences = findFences(lines);
  if (fences.unclosed) {
    return { ok: false, errors: [{ line: fences.unclosed.line, severity: "error", message: fences.unclosed.message }] };
  }
  const sections = parseSections(lines, fences);
  const pipelines: Pipeline[] = [];

  const pipelineSection = firstSection(sections, "Pipelines", warnings);
  if (pipelineSection) {
    let current: Pipeline | undefined;
    for (let l = pipelineSection.heading + 1; l < pipelineSection.end; l++) {
      const line = lines[l] ?? "";
      if (line.trim() === "" || fences.inside.has(l)) continue;
      const role = ROLE.exec(line);
      if (role?.[1]) {
        if (!current) {
          errors.push({ line: l, severity: "error", message: "A role must be nested under a pipeline name." });
          continue;
        }
        const parsed = parseWikilinkList(role[2] ?? "");
        if ("bad" in parsed) {
          errors.push({ line: l, severity: "error", message: `Agents must be links like [[agents/implementer]]; got "${parsed.bad}".` });
          continue;
        }
        if (parsed.targets.length === 0) {
          errors.push({ line: l, severity: "error", message: `The ${role[1]} role names no agents.` });
          continue;
        }
        const outside = parsed.targets.find((t) => t.startsWith("/") || t.split(/[\\/]/).includes(".."));
        if (outside) {
          errors.push({ line: l, severity: "error", message: `Agent links must stay inside the repository; got "[[${outside}]]".` });
          continue;
        }
        current.roles.push({ role: role[1], agents: parsed.targets, line: l });
        continue;
      }
      const name = PIPELINE.exec(line);
      if (name?.[1]) {
        if (pipelines.some((p) => p.name === name[1])) {
          errors.push({ line: l, severity: "error", message: `There is already a pipeline named "${name[1]}".` });
        }
        current = { name: name[1], roles: [], line: l };
        pipelines.push(current);
        continue;
      }
      errors.push({ line: l, severity: "error", message: `Expected "* pipeline-name" or an indented "* role: [[agents/name]]".` });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  const value: TasksIndex = { pipelines };
  const index = firstSection(sections, "Index", warnings);
  if (index) value.index = index;
  return { ok: true, value, warnings };
}
