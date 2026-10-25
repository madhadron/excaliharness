// Derives the whole ## Index of TASKS.md from the task files (D-034). It is
// rebuilt on every pass rather than patched, so a crash can't leave it stale.

export interface IndexEntry {
  id: string;
  // Absent when the task file doesn't parse.
  title?: string;
  status?: string;
  parked?: boolean;
}

export function taskNumber(id: string): number {
  return Number(id.slice(2));
}

export function indexLines(entries: IndexEntry[]): string[] {
  return [...entries]
    .sort((a, b) => taskNumber(a.id) - taskNumber(b.id) || a.id.localeCompare(b.id))
    .map((e) => (e.status === undefined ? `* [[${e.id}]] · does not parse` : `* [[${e.id}]]${e.title ? ` ${e.title}` : ""} · ${e.parked ? `parked (${e.status})` : e.status}`));
}
