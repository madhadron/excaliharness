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
- **Status history can be forged by agents.** The recorded status is the last
  `status: a → b` line in Updates, whoever wrote it, and statuses arriving
  through git are accepted. An agent that edits its task file, or whose commit
  is merged, could mark tasks `done` or `ready`. Accept status only from the
  main checkout and treat worktree task-file changes as proposals.
- **Pipelines from agent-editable files.** `pipeline:` in a task file, and the
  agent links in `TASKS.md`, must be read from the main checkout and resolved
  with the same `..`, absolute-path and symlink checks as wikilinks.
- **Supply chain for the agent image.** Claude Code is pinned by version but not
  by integrity hash, its dependencies aren't pinned, and its install scripts
  run at build time; apt packages aren't pinned either. Options: install from
  a shipped package-lock with `npm ci`, and snapshot apt sources.
- **Container network reach.** Containers get Docker's default bridge network,
  which on Docker Desktop reaches `host.docker.internal` (services listening on
  the Mac's loopback) and the LAN, and on Linux cloud metadata addresses. Agent
  containers should get a network that only reaches what they need.

## Idempotent agent side effects
- Added: 2026-10-23, from the robustness review of the task-file plan.
- When transitions start agents, a restart or a reverted save can re-run
  `ready → in-implementation`. Side effects must use deterministic names
  (container and branch per task) and check for or remove existing ones first,
  so a task never gets two agents.

## New task from TASKS.md
- Added: 2026-10-23
- A "New task" CodeLens above the `## Index` section of `TASKS.md` (D-041)
  that asks for the task's name, takes the next free id, creates
  `tasks/T-NNN.md` with the title, `* status: draft` and every section header
  from docs/task-format.md, and opens a chat session to plan the task with the
  human. The index line and link appear when the orchestrator regenerates the
  index (D-034), so the scaffold only needs to create the file.

## Hand edits into orchestrator-managed statuses
- Added: 2026-10-23, from the correctness review of the task-file feature.
- D-037 notes a hand edit that isn't allowed and leaves it. The orchestrator
  skips acting on it in the same step, but afterwards treats the new status
  normally: hand-editing a draft to `waiting-for-dependencies` lets it become
  `ready` once its dependencies are done, which D-047 meant to prevent. Decide
  whether such a task should stay parked until the human sets an allowed
  status.
