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

## E-007 Compose with a generated override
- Date: 2026-10-24
- Question: Does D-059/D-060/D-064's override work with real Compose
  (v5.5.0, Docker 29.8.2)?
- Setup: [experiments/compose-override/](../experiments/compose-override/): a
  stand-in target with `dev` (built from a Dockerfile, mounting `.:/app`, with
  an `env_file`), `db` (no networks listed) and `cache` (an explicit network),
  plus the override the worker would generate.
- Results:
    - `build: !reset null` with `image: sha256:<id>` runs that image;
      `pull_policy: never` with a missing ID fails with "No such image" instead
      of pulling.
    - `volumes: !override`, `networks: !override` and `env_file: !reset []`
      replace the target's lists: no `/app` mount, no env-file variables.
    - The dev service, only on `excaliharness-internal-network`, reaches `db`
      and `cache` by name but can't resolve `api.anthropic.com`. Root
      filesystem read-only, `/workspace` writable, uid 1000.
    - **Adding a network to a service that lists none replaces its implicit
      default network** instead of merging. A service with an explicit list
      merges as expected. So the generator must copy each service's networks
      from the resolved config of the target's file alone (where the implicit
      one appears as `default`) and append ours. With that, `db` keeps internet
      access and joins the internal network.

## E-005 / E-006 The CLI through a token-injecting proxy, driven by the SDK
- Date: 2026-10-24
- Setup: [experiments/compose-override/](../experiments/compose-override/):
  `proxy.cjs` (forwards only to `api.anthropic.com`, replacing
  `Authorization`; logs methods, paths and header names, never values) as
  `excaliharness-egress-proxy`; the CLI in the locked-down dev service with
  `ANTHROPIC_BASE_URL` and a placeholder token; `runner/` stands in for the
  worker with Agent SDK 0.3.310 and the Docker CLI.
- With a fake "real" token:
    - **E-005:** the CLI starts with the placeholder, sends only
      `POST /v1/messages` to the base URL (with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`),
      the proxy swaps the token, and Anthropic answers 401 "OAuth access token
      is invalid": the path works end to end.
    - **E-006:** `spawnClaudeCodeProcess` returning
      `spawn("docker", ["compose", …, "run", "--rm", "-i", "-T", "dev", "claude", ...args])`
      works with the SDK's arguments unchanged; the stream-json handshake
      completes and the worker's in-process tool appears in the container as
      `mcp__excaliharness__finish`.
- With a real token (`real-token.sh`, run by the human so the token never
  left their terminal and the proxy container):
    - **E-005: works.** The CLI answers `ok`; every request through the proxy
      returns 200. The injected token is accepted, so D-066 holds.
    - **E-006: works.** The agent calls the worker's in-process `finish` tool
      from inside the container and completes; D-067 and D-068 hold.
- Pitfall: the first real-token run failed with "401 Invalid bearer token"
  because the sign-in *code* from the browser was pasted instead of the token
  the CLI prints afterwards (`sk-ant-oat01-…`, 108 characters).
  [diagnose.sh](../experiments/compose-override/diagnose.sh) checks a token's
  shape without printing it.

## E-008 The native Claude Code binary, and building from local image IDs
- Date: 2026-10-24
- Native binary: releases are published at
  `https://downloads.claude.ai/claude-code-releases/<version>/<platform>/claude`
  with checksums in `<version>/manifest.json` (as the official `install.sh`
  uses). For 2.1.310: `linux-x64` sha256
  `b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56`,
  `linux-arm64` `9c64d9a7442436b65fcd7cc02c1aa0051bb5a7041e7788576ed3b5f29c447d54`.
  The downloaded `linux-x64` binary matches, runs (`2.1.310 (Claude Code)`) and
  links against glibc. The checksums are pinned in the Dockerfile rather than
  read from the manifest at build time.
- BuildKit does **not** treat a bare `sha256:` image ID as a local image, in
  `FROM` or `COPY --from`: it tries `docker.io` and fails. Tagging the exact ID
  as `excaliharness-pinned:<64 hex digits of the ID>` right before the build
  works: BuildKit uses the local image. A missing tag fails the build instead
  of fetching anything, and a single-word name maps to `docker.io/library/…`,
  where only Docker's official images can be published.

## E-009 Unit A with a real token
- Date: 2026-10-25
- Question: does the agent runner (D-058 to D-079) take a task from `ready` to
  `review` with a real Claude token: the agent edits files in its worktree
  through the proxy, and the host commits them?
- Setup: `experiments/runner-smoke/real-token.sh` (run by the human, so the
  token never reached the session): the real Orchestrator and TaskRunner in a
  container with the Docker CLI, on the stand-in repo's T-001 ("add
  hello.js"), with a fake leftover project to sweep.
- Result: **works.** The leftover project was stopped, T-001 went `ready` →
  `in-implementation` → `review` with the agent's summary, and one commit by
  "Excaliharness (implementer)" added `hello.js` (`console.log('hello');`).
  The proxy refused nothing, so the D-079 rules let the pinned CLI through;
  the token appeared nowhere in the log. The session ID was saved and its
  volume kept for the next round. No containers were left.
