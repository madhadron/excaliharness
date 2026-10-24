# Roadmap

Features agreed for later iterations. Not in scope until they are planned as
tasks.

## Agents pane
- Added: 2026-10-23
- A pane in the extension listing every running agent the orchestrator knows
  about, showing for each one: task, role (designer, implementer, reviewer),
  status, token usage, context window size, and so on.

## Security constraints for the agent runner
- Added: 2026-10-23, from the security review of the dev environment (D-019).
- Not yet decided; each needs the human's approval when the agent runner is
  planned. Listed roughly by severity.
- **Host git on agent-written worktrees.** A worktree's `.git` file points at the
  main repo's `.git`. Never mount the main `.git` into agent containers, and run
  host git on agent output with hooks, fsmonitor and other config-driven
  commands disabled (`-c core.hooksPath=/dev/null -c core.fsmonitor=false`,
  `GIT_CONFIG_NOSYSTEM=1`), or bring changes back as patches.
- **Target dev environments may be privileged.** A target's Compose file or dev
  image may run as root, have sudo, mount the Docker socket or use host
  networking. The worker should create agent containers through the Engine API
  with its own fixed HostConfig (`--cap-drop=ALL`, `no-new-privileges`,
  read-only root, tmpfs home, forced non-root user) and never `docker compose
  run` the target's file. Affects D-007 and D-024.
- **The OAuth token is readable inside agent containers** (D-022) and visible
  through `docker inspect`. With open network egress a prompt-injected agent
  could send it out. Option: a credential-injecting proxy on the host
  (`ANTHROPIC_BASE_URL`), with agent egress restricted to it.
- **Token in logs.** The worker forwards its stdout/stderr to a VS Code log
  channel, and setup-token prints the token. Redact in the worker before
  anything is logged (as experiments/setup-token/drive.mjs does).
- **Config read from agent-writable places.** Mounts, images and tool lists must
  come from the main checkout's `TASKS.md` and `agents/*.md`, never from a
  task worktree an agent can edit (D-008).
- **The worker holds host Docker access**, which is root-equivalent. Every Engine
  API field it sets comes from an allowlist, never from agent output.
- **Supply chain for the agent image.** Claude Code is pinned by version but not
  by integrity hash, and its install scripts run at build time.

## Worker restart
- Added: 2026-10-23, from the robustness review.
- Nothing restarts the orchestrator worker if it crashes; until the window
  reloads, every request fails with "worker is not running". Decide whether the
  extension restarts it (with backoff) when the worker gains real state.
