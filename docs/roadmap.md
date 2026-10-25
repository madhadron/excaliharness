# Roadmap

Features agreed for later iterations. Not in scope until they are planned as
tasks.

## Agents pane
- Added: 2026-10-23
- A pane in the extension listing every running agent the orchestrator knows
  about, showing for each one: task, role (designer, implementer, reviewer),
  status, token usage, context window size, and so on.

## Security constraints for the agent runner
- Added: 2026-10-23, from the security reviews (D-019); updated 2026-10-24
  once the runner's decisions were made.
- Addressed by the runner's design:
    - Host git on agent-written worktrees: no `.git` in containers; host git
      runs with hooks, fsmonitor and system/global config disabled, and names
      the worktree's git directory itself (D-069, D-079).
    - Privileged target environments: the dev service is locked down by a
      generated override, and unsafe settings refuse the start (D-059).
    - The token inside agent containers: only the egress proxy holds it
      (D-066), and agents can reach nothing else (D-060).
    - Config from agent-writable places: agents, pipelines, decisions and task
      files come from the main checkout, mounted read-only (D-068, D-073).
    - Status history forged through task files: agents can't write task files
      (D-068); statuses still arriving through git are accepted (open below).
    - Container network reach: agents are on an internal network (D-060).
    - Supply chain: Claude Code is the pinned, checksum-verified native binary
      (E-008).
- Still open:
    - **Token in logs.** The worker forwards its stdout/stderr to a VS Code log
      channel. Nothing in the worker logs the token today; a redacting filter
      on that channel would make sure.
    - **The worker holds host Docker access**, which is root-equivalent. Every
      Engine API field it sets must come from code, never from agent output.
    - **Statuses arriving through git.** A merged branch whose task files
      changed status is accepted as is (D-047's git rule). Matters once agents'
      branches are merged (the review UI).
    - **Agent-written Dockerfiles.** Rebuilding between rounds (D-070) runs
      `RUN` steps an agent wrote, with network access, in Docker's builder.
    - **apt packages** in the base image aren't pinned.
    - **Malicious target repositories** (out of scope for now, D-079): build
      the dev service from an allowlist of settings instead of resetting known
      ones (`secrets`/`configs` with host files, `volumes_from`, `group_add`,
      `sysctls`, `runtime`, GPUs, `entrypoint`, ...); lock down `build.*`
      (`ssh`, `secrets`, `additional_contexts`, `network: host`); start the
      proxy outside the target's Compose interpolation, so no target service
      can name `${EXCALIHARNESS_PROXY_TOKEN}`; keep other services from
      mounting the session volume. Today other services keep their own
      settings (D-059), so a malicious repo can already reach the Docker
      socket through them.
    - **Docker's `proxies` config.** Compose reads `~/.docker/config.json`
      (D-079 passes `HOME` and `DOCKER_CONFIG`); its `proxies` section may be
      added to containers as `HTTP(S)_PROXY`, leaking the host proxy URL and
      any credentials in it to agents. Check with `docker inspect`.
    - **Filters the human's own repo config defines** (git-lfs, git-crypt)
      still run on agent-written files on the host when `.gitattributes`
      names them. They are programs the human trusts; low risk.
    - **The SDK path's process tree.** `docker compose run` for the agent is
      stopped by the SDK with one signal; a Compose plugin that survives it
      could keep the round from ending.
    - **Other services as relays.** They keep their own networks, so an agent
      could reach the internet through, e.g., a database's `COPY ... TO
      PROGRAM` (accepted risk, D-079).
    - **Opening a worktree for review** (D-077) must not run its
      `.vscode/tasks.json` or apply its workspace settings, and a review UI
      must not follow symbolic links in it.
    - **The CLI's output is forgeable** by anything the agent runs (same uid),
      so the session ID and summary are untrusted; host-side SDK callbacks
      stay minimal.

## Runner housekeeping
- Added: 2026-10-24, from the unit A reviews (D-019).
- Remove old `excaliharness-pinned:*` and `excaliharness-derived:*` images and
  the session volumes of finished tasks.
- The capability check's cache is keyed by image, but its workspace and proxy
  checks depend on the run; split them.
- Decide whether agents and the capability check bypass the dev image's
  `ENTRYPOINT`.
- Two tasks building a dev image with the same `image:` name at once can
  swap the tag between build and inspect; build to an ID instead.
- The nested-repository scan walks the whole worktree synchronously (twice
  a round); with large `node_modules` trees, make it asynchronous or skip
  directories git ignores. Vendored trees that contain `.git` block a task.
- Waiting for a sign-in in the pre-start check can't be cancelled, so a
  shutdown during it waits its full 30 s.
- The CLI warns that `~/.claude.json` is missing on every round, since
  `/home/agent` is a fresh tmpfs; check that nothing depends on it.

## New task from TASKS.md
- Added: 2026-10-23
- A "New task" CodeLens above the `## Index` section of `TASKS.md` (D-041)
  that asks for the task's name, takes the next free id, creates
  `tasks/T-NNN.md` with the title, `* status: draft` and every section header
  from docs/task-format.md, and opens a chat session to plan the task with the
  human. The index line and link appear when the orchestrator regenerates the
  index (D-034), so the scaffold only needs to create the file.

## Setting the number of parallel tasks from the extension
- Added: 2026-10-24
- A way to change `excaliharness.maxParallelTasks` (D-074) from the extension's
  UI, e.g. a status bar item or a command, rather than only in settings.
