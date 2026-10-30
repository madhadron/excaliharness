// Agent-controlled text (summaries, errors, file names) is cleaned once,
// where it enters the worker: no control characters, which could forge log
// lines or drive a terminal, and no bidirectional overrides, which could
// disguise it (D-079).

// C0 controls except tab and newline, DEL, C1 controls, and the bidi
// embedding, override and isolate characters.
// eslint-disable-next-line no-control-regex
const UNPRINTABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

export function printable(text: string): string {
  return text.replace(UNPRINTABLE, "");
}

// One line: newlines and tabs too become spaces.
export function printableLine(text: string): string {
  return printable(text).replace(/\s+/g, " ").trim();
}

// Agent text written into a task file: one line, at most `max` characters,
// with what makes Markdown links, images (which a preview would load, D-060)
// and HTML escaped, and no " · " separators, so it can't pass for a status
// entry in Updates (D-079). Other Markdown is left alone, since humans read
// these files raw. Bare URLs still become links in a preview, but load
// nothing.
export function inertLine(text: string, max = 2_000): string {
  return printableLine(text)
    .slice(0, max)
    .replace(/·/g, "-")
    .replace(/[\\[\]<>]/g, "\\$&");
}
