# Experiments

## E-001 `claude setup-token` without a host terminal
- Date: 2026-10-23
- Question: Can the extension drive `claude setup-token` inside a container,
  with no host terminal, relaying the sign-in URL and code to the human?
- Setup: [experiments/setup-token/](../experiments/setup-token/README.md),
  Claude Code 2.1.310 on `node:22-slim`.
- Result: **Yes, with the container's terminal created through the Docker
  Engine API (variant D).** No `node-pty` or host terminal needed.

Findings:
- In a container with no browser, the CLI prints a sign-in URL whose redirect is
  `platform.claude.com/oauth/code/callback` (the paste-the-code flow) and
  waits at "Paste code here if prompted >".
- A code sent over the attach stream followed by `\r` is accepted. The CLI
  prints the token on one line; at 1000 columns it is not wrapped (108 chars,
  `sk-ant-oat01-` prefix). The CLI then exits 0.
- The token works by itself: `claude -p` in a fresh container with only
  `CLAUDE_CODE_OAUTH_TOKEN` set succeeds.
- Input sent within ~2 s of the URL appearing is silently dropped. The CLI sends
  terminal capability queries at startup (`ESC[c`, `ESC[>0q`, `ESC[?u`) that
  get no answer; the extension should wait until the prompt is idle, or answer
  the queries, before sending the code.
- A wrong code does not exit: the CLI shows "OAuth error: Invalid code…" and
  "Press Enter to retry". The extension must detect that text, tell the human,
  and send Enter to get a fresh prompt.
- With no code, the CLI waits forever. The extension needs its own deadline and
  must remove the container when it passes.
- The CLI's output positions words with cursor-column escapes, not spaces; the
  parser must turn `ESC[nG` and `ESC[nC` into spaces before matching text.

Not tested: plain pipes (B) and `script` inside the container (C), skipped once
D passed. Each successful run minted a long-lived token (two in total: A and D).
