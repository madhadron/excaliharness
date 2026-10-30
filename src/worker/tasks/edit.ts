// Pure line-range edits on task files and TASKS.md (D-030). Each function takes
// file text and returns new text; lines it doesn't target are left untouched.
import { parseSections } from "./parse";
import { insertLines, joinText, replaceLines, splitText } from "./text";

const STATUS_PREFIX = /^([ \t]*[*-][ \t]+status:)[ \t]*/;

export interface TaskEdit {
  // New value for the status line.
  status?: string;
  // Lines to append to ## Updates, in order.
  updates: string[];
  // Questions to add to ## Questions in the D-011 form, unanswered.
  questions?: string[];
}

// One unanswered question, as D-011 writes it.
export const questionLines = (question: string) => [`* [ ] Q: ${question}`, "  A:"];

// Applies every edit for one task file at once, so a status change and the
// Updates line recording it land in a single write.
export function editTask(text: string, statusLine: number, edit: TaskEdit): string {
  const file = splitText(text);
  if (edit.status !== undefined) {
    const line = file.lines[statusLine];
    const prefix = line === undefined ? undefined : STATUS_PREFIX.exec(line);
    if (!prefix?.[1]) throw new Error(`line ${statusLine} is not a status line`);
    replaceLines(file, statusLine, statusLine + 1, [`${prefix[1]} ${edit.status}`]);
  }
  if (edit.questions?.length) {
    const lines = edit.questions.flatMap((q, i) => [...(i ? [""] : []), ...questionLines(q)]);
    const sections = parseSections(file.lines);
    const questions = sections.find((s) => s.name === "Questions");
    if (questions) {
      let at = questions.end;
      while (at > questions.heading + 1 && file.lines[at - 1]?.trim() === "") at--;
      const lead = at > questions.heading + 1 ? [""] : [];
      insertLines(file, at, [...lead, ...lines]);
    } else {
      // Before ## Updates, where the task format puts it, or at the end.
      const updates = sections.find((s) => s.name === "Updates");
      const at = updates ? updates.heading : file.lines.length;
      const before = file.lines[at - 1];
      const lead = at === 0 || before === undefined || before.trim() === "" ? [] : [""];
      insertLines(file, at, [...lead, "## Questions", ...lines, ...(updates ? [""] : [])]);
    }
  }
  if (edit.updates.length > 0) {
    const updates = parseSections(file.lines).find((s) => s.name === "Updates");
    if (updates) {
      let at = updates.end;
      while (at > updates.heading + 1 && file.lines[at - 1]?.trim() === "") at--;
      insertLines(file, at, edit.updates);
    } else {
      const last = file.lines[file.lines.length - 1];
      const lead = last === undefined || last.trim() === "" ? [] : [""];
      insertLines(file, file.lines.length, [...lead, "## Updates", ...edit.updates]);
    }
  }
  return joinText(file);
}

// Replaces the body of ## Index with `entries`, adding the section at the end
// if it's missing. Returns the text unchanged if the body already matches.
export function replaceIndex(text: string, entries: string[]): string {
  const file = splitText(text);
  const index = parseSections(file.lines).find((s) => s.name === "Index");
  if (index) {
    // Keep one blank line before a following section.
    const body = index.end < file.lines.length ? [...entries, ""] : entries;
    const current = file.lines.slice(index.heading + 1, index.end);
    if (current.length === body.length && current.every((l, i) => l === body[i])) return text;
    if (body.length === 0) replaceLines(file, index.heading + 1, index.end, []);
    else if (index.end > index.heading + 1) replaceLines(file, index.heading + 1, index.end, body);
    else insertLines(file, index.heading + 1, body);
  } else {
    const last = file.lines[file.lines.length - 1];
    const lead = last === undefined || last.trim() === "" ? [] : [""];
    insertLines(file, file.lines.length, [...lead, "## Index", ...entries]);
  }
  return joinText(file);
}
