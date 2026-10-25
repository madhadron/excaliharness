// The README's "# Quick reference" section (D-020): one fenced block in which
// each `# label` line names the command lines after it, up to the next label
// or blank line. Labels ending in " (required gate)" are gates (D-010).
import { findFences } from "./parse";
import { splitText } from "./text";

export interface QuickRefEntry {
  label: string;
  commands: string[];
  gate: boolean;
}

export interface QuickRef {
  // The section's text, for agent prompts (D-073).
  text: string;
  entries: QuickRefEntry[];
}

const GATE_SUFFIX = " (required gate)";

export function parseQuickRef(readme: string): QuickRef | undefined {
  const { lines } = splitText(readme);
  const fences = findFences(lines);
  const start = lines.findIndex((l, i) => !fences.inside.has(i) && /^# +Quick reference[ \t]*$/.test(l));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (!fences.inside.has(i) && /^# /.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  const open = lines.findIndex((l, i) => i > start && i < end && /^ {0,3}(`{3,}|~{3,})/.test(l));
  if (open < 0) return undefined;
  // Closed only by the same kind of fence, at least as long (CommonMark).
  const marker = /^ {0,3}(`{3,}|~{3,})/.exec(lines[open] ?? "")?.[1] ?? "```";
  const entries: QuickRefEntry[] = [];
  let current: QuickRefEntry | undefined;
  for (let i = open + 1; i < end; i++) {
    const line = lines[i] ?? "";
    const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
    if (close && close[0] === marker[0] && close.length >= marker.length) break;
    if (line.trim() === "") {
      current = undefined;
      continue;
    }
    const label = /^#\s*(.*?)\s*$/.exec(line);
    if (label) {
      const text = label[1] ?? "";
      const gate = text.endsWith(GATE_SUFFIX);
      current = { label: gate ? text.slice(0, -GATE_SUFFIX.length) : text, commands: [], gate };
      entries.push(current);
    } else if (current) {
      current.commands.push(line.trim());
    }
  }
  return { text: lines.slice(start, end).join("\n").trim(), entries: entries.filter((e) => e.commands.length > 0) };
}

// The programs the gates call (the first word of each command), for the
// capability check (D-065).
export function gatePrograms(ref: QuickRef): string[] {
  const programs = new Set<string>();
  for (const entry of ref.entries.filter((e) => e.gate)) {
    for (const command of entry.commands) {
      const first = command.replace(/^(\w+=\S*\s+)*/, "").split(/\s+/)[0];
      if (first && /^[\w./+-]+$/.test(first)) programs.add(first);
    }
  }
  return [...programs];
}
