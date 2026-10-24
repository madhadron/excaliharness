// Pure helpers the extension uses on document text; kept free of the vscode
// module so they can be unit tested.
import * as path from "node:path";
import { parseTask } from "./worker/tasks/parse";

// Bounded and without nested brackets, so a line of "[[[[..." can't make the
// match quadratic and stall the extension host.
const WIKILINK = /\[\[([^[\]\n]{1,200})\]\]/g;
const TASK_FILE = /^(T-\d+)\.md$/;
// Documents larger than this aren't scanned for links.
export const MAX_LINK_SCAN_CHARS = 1024 * 1024;

export interface WikilinkMatch {
  line: number;
  start: number;
  end: number;
  target: string;
}

export function findWikilinks(text: string): WikilinkMatch[] {
  const found: WikilinkMatch[] = [];
  if (text.length > MAX_LINK_SCAN_CHARS) return found;
  text.split(/\r?\n/).forEach((line, i) => {
    for (const m of line.matchAll(WIKILINK)) {
      if (m[1] === undefined) continue;
      found.push({ line: i, start: m.index, end: m.index + m[0].length, target: m[1].trim() });
    }
  });
  return found;
}

// D-032: [[T-NNN]] is tasks/T-NNN.md; [[path/name]] is path/name.md from the
// repo root. Targets that would leave the repo resolve to nothing.
export function resolveWikilink(root: string, target: string): string | undefined {
  if (/^T-\d+$/.test(target)) return path.join(root, "tasks", `${target}.md`);
  if (target === "" || path.isAbsolute(target) || target.split(/[\\/]/).includes("..")) return undefined;
  return path.join(root, `${target}.md`);
}

// The task's status and its line, read with the worker's own parser so the
// extension never disagrees with it. Undefined if the file doesn't parse.
export function statusOf(text: string, id: string): { line: number; value: string } | undefined {
  const parsed = parseTask(text, id);
  return parsed.ok ? { line: parsed.value.statusLine, value: parsed.value.status } : undefined;
}

// The task id if `file` is tasks/T-NNN.md directly under `root`.
export function taskIdOf(root: string, file: string): string | undefined {
  if (path.dirname(file) !== path.join(root, "tasks")) return undefined;
  return TASK_FILE.exec(path.basename(file))?.[1];
}
