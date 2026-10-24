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

## E-002 Claude Code in a hardened container
- Date: 2026-10-24
- Question: Do `claude setup-token` and `claude -p` work with D-056's
  hardening: read-only root filesystem, tmpfs for `/home/node` (owned by uid
  1000) and `/tmp`, `--cap-drop ALL`, `no-new-privileges`, non-root user?
- Result: **Yes.** In the base agent image (Claude Code 2.1.310), `setup-token`
  reaches "Paste code here if prompted >" with no filesystem errors, and
  `claude -p` with a fake token fails only with "401 OAuth access token is
  invalid". Whatever the CLI writes goes to the tmpfs home directory.
- Not tested: completing a real sign-in under these settings; that is covered
  by the manual end-to-end run of the sign-in feature.

## E-003 `timeout` stops `setup-token` reading the code
- Date: 2026-10-24
- Found in the first manual sign-in: the prompt appeared, but the CLI never
  answered the pasted code.
- Cause: the sign-in container ran `timeout <s> claude setup-token`. Without
  `--foreground`, GNU `timeout` puts the command in its own process group,
  outside the terminal's foreground group, so it can write to the terminal but
  not read from it. Shown with `timeout 5 sh -c 'read x'` under `docker run -it`:
  the read never completes; with `--foreground` it does.
- Fix: `timeout --foreground`.
- Check: [experiments/sign-in-smoke/check.ts](../experiments/sign-in-smoke/check.ts)
  runs the real SignInService against the local Docker daemon and submits a
  wrong code; the CLI now answers it (`RESULT: invalid`). A short code alone
  missed the next problem, E-004. No token
  is created. The unit tests' fake terminal can't catch this kind of problem,
  so this check is worth rerunning whenever the sign-in container's command
  changes.

## E-004 Typing a long code into `setup-token`
- Date: 2026-10-24
- Found in the second manual sign-in: the code reached the CLI's input field
  (92 `*`) but was never submitted.
- Cause, shown with [experiments/sign-in-smoke/matrix.ts](../experiments/sign-in-smoke/matrix.ts)
  against the real CLI with a fake code:
    - Code and Enter in one write: the CLI takes the chunk as a paste and the
      Enter inside it doesn't submit. A short code happens to work.
    - Code, a pause, then Enter: submitted, with or without `timeout`, as a
      bracketed paste, or typed in pieces.
    - The worker did send Enter separately, but waited for "quiet" before the
      CLI had echoed anything, so the output was still quiet from before and
      Enter followed at once, arriving with the code.
- Also: the CLI answers a well-formed but wrong code with "OAuth error: Request
  failed with status code 400", not "Invalid code" (that's for malformed
  ones). Both say "Press Enter to retry".
- Fix: type the code, wait for its echo, wait for quiet, then press Enter;
  treat any "OAuth error" as a rejected code. The smoke check now uses a
  92-character code shaped like a real one and gets `RESULT: invalid`.
- Tools: [session.ts](../experiments/sign-in-smoke/session.ts) traces the real
  SignInSession with timings; [peek.cjs](../experiments/sign-in-smoke/peek.cjs)
  shows a running sign-in container's screen with tokens masked.
