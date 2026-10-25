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
