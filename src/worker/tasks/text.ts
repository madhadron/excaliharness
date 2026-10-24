// A file split into lines, keeping each line's own terminator so that joining
// it again reproduces the original bytes: BOM, mixed or CRLF line endings and a
// missing final newline all survive an edit (D-030).

export interface TextFile {
  bom: boolean;
  lines: string[];
  // The terminator after each line: "\n", "\r\n", or "" for a last line with
  // no final newline.
  eols: string[];
  // Used for lines the orchestrator inserts.
  eol: "\n" | "\r\n";
}

export function splitText(text: string): TextFile {
  const bom = text.startsWith("\uFEFF");
  const body = bom ? text.slice(1) : text;
  const lines: string[] = [];
  const eols: string[] = [];
  const re = /\r?\n/g;
  let start = 0;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    lines.push(body.slice(start, m.index));
    eols.push(m[0]);
    start = m.index + m[0].length;
  }
  if (start < body.length) {
    lines.push(body.slice(start));
    eols.push("");
  }
  const crlf = eols.filter((e) => e === "\r\n").length;
  const lf = eols.filter((e) => e === "\n").length;
  return { bom, lines, eols, eol: crlf > lf ? "\r\n" : "\n" };
}

export function joinText(file: TextFile): string {
  if (file.lines.length !== file.eols.length) {
    throw new Error(`invalid TextFile: ${file.lines.length} lines but ${file.eols.length} line endings`);
  }
  let out = file.bom ? "\uFEFF" : "";
  for (let i = 0; i < file.lines.length; i++) out += file.lines[i] + (file.eols[i] ?? "");
  return out;
}

// Inserts lines before index `at`, terminated with the file's line ending.
// Appending after a last line that has no final newline moves the missing
// newline to the new last line, so the file keeps that property.
export function insertLines(file: TextFile, at: number, lines: string[]): void {
  if (lines.length === 0) return;
  const eols = lines.map((): string => file.eol);
  if (at > 0 && at === file.lines.length && file.eols[at - 1] === "") {
    file.eols[at - 1] = file.eol;
    eols[eols.length - 1] = "";
  }
  file.lines.splice(at, 0, ...lines);
  file.eols.splice(at, 0, ...eols);
}

// Replaces lines [start, end) with `lines`. The last new line takes the
// terminator of the last replaced line.
export function replaceLines(file: TextFile, start: number, end: number, lines: string[]): void {
  const lastEol = end > start ? (file.eols[end - 1] ?? file.eol) : file.eol;
  const eols = lines.map((_, i): string => (i === lines.length - 1 ? lastEol : file.eol));
  if (lines.length === 0 && end === file.lines.length && lastEol === "" && start > 0) file.eols[start - 1] = "";
  file.lines.splice(start, end - start, ...lines);
  file.eols.splice(start, end - start, ...eols);
}
