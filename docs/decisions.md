# Decisions

Each entry: date, decision, reason, alternatives rejected. Agents receive this
file as context and must follow it; a new cross-cutting decision is raised as a
question (see D-011) rather than made unilaterally.

## D-001 Agent runtime: Claude Agent SDK
- Date: 2026-10-23
- Decision: Agents run on the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`,
  the TypeScript package, per D-021).
- Reason: Subagents, hooks, tool permissions and sessions come built in.
- Rejected: Running the `claude -p` CLI headless; our own loop on the Messages API.

## D-002 Languages: Python orchestrator, TypeScript VS Code extension
- Status: Removed, superseded by D-021.

## D-003 Process shape: local orchestrator daemon + thin VS Code extension
- Status: Removed, superseded by D-021.

## D-004 State storage: git-tracked Markdown only
- Date: 2026-10-23
- Decision: Task files, decisions and agent definitions in the repo are the only
  source of truth. The orchestrator may keep a gitignored cache that can be
  rebuilt from them at any time.
- Reason: Human-editable, and every state change is a reviewable diff.
- Rejected: SQLite with a Markdown export.

## D-005 Task file layout: one file per task + central index
- Date: 2026-10-23
- Decision: Each task lives in `tasks/T-NNN.md`. `TASKS.md` is the central index:
  one `[[T-NNN]]` link per task, plus the pipeline definitions. Task metadata is
  an unordered list of `key: value` items, never YAML blocks:

  ```markdown
  # T-007: Password reset flow

  * status: waiting-for-dependencies
  * depends_on: [T-001, T-004]
  * pipeline: ui
  * design: https://figma.com/file/...

  ## Description
  ## Context
  ## Issue
  ## Expectation
  ## Questions
  ## Updates
  ```

  The orchestrator is the only writer of `status` and `## Updates`, and it
  rewrites one section at a time; humans may edit anything else.
- Reason: Per-task files avoid edit collisions when tasks run in parallel; the
  index keeps a single place to see every task. Lists instead of YAML were the
  human's choice.
- Rejected: One `TASKS.md` holding every task; YAML metadata blocks.
- Amended 2026-10-23: references in metadata are wikilinks (D-031); TASKS.md
  sections are fixed by D-033 and D-034.

## D-006 Triggering: file watcher, status changes only
- Date: 2026-10-23
- Decision: The orchestrator watches the task files with a debounce, re-parses,
  and acts only on status changes (and on questions being checked off, D-011).
  A file that doesn't parse is reported in its Updates section, never acted on.
- Reason: Reacts immediately without half-finished edits launching agents.
- Rejected: Git post-commit hook; an explicit `start` command.
- Amended 2026-10-23: parse errors are reported as diagnostics (D-038).

## D-007 Task isolation: worktree per task, agents in containers
- Date: 2026-10-23
- Decision: Each task gets a git worktree and a `task/T-NNN` branch. Agents run
  in containers: the base agent image or an image derived from the target's dev
  image (D-024).
- Reason: Tasks can run in parallel, each produces one reviewable diff, and it
  follows the containerized-first rule.
- Rejected: A shared checkout with tasks run one at a time.
- Amended 2026-10-23: originally "inside the target project's Docker Compose
  dev container"; D-024 replaced that with the base and derived images.

## D-008 Agent definitions: `agents/*.md`, named by pipelines
- Date: 2026-10-23
- Decision: Agents are defined in `agents/*.md` using the Claude Code subagent
  format (frontmatter for model and tools, body is the role prompt). `TASKS.md`
  defines named pipelines (design / implement / review agents); each task picks
  one with `pipeline:` and may override individual agents.
- Reason: Keeps task files readable and lets tasks reuse reviewers.
- Rejected: Agent prompts written inline in the task files.

## D-009 Statuses
- Date: 2026-10-23
- Decision: `waiting-for-dependencies`, `ready`, `in-ui-development`,
  `in-implementation`, `review`, `done`, `needs-decision`, `needs-human`.
- Reason: The original five lacked an end state and states for "blocked on a
  person".
- Rejected: Only the original five.
- Amended 2026-10-23: `draft` added (D-047).

## D-010 "Ready for human" gate and notification
- Date: 2026-10-23
- Decision: Loop: implement → lint/typecheck/tests → reviewer agents label
  findings blocking or nit → implementer fixes. When clean, the status becomes
  `review`; after 3 rounds the status becomes `needs-human`, with the open
  findings listed. On either change, the VS Code extension shows a notification
  with an "Open review" button and speaks "Task T-NNN is ready for review" (or
  "needs you") through macOS `say` on the host.
- Reason: The human only sees clean work, the loop can't run forever, and the
  human notices without watching. (Since D-021 the orchestrator is the
  extension, so it speaks on the host directly.)
- Rejected: Showing the human the first pass with findings attached; a separate
  host-side notifier process.

## D-011 Questions and answers in task files
- Date: 2026-10-23
- Decision: When an agent hits a decision that isn't covered by this file, it
  stops, adds a question to the task's `## Questions` section, and the status
  becomes `needs-decision`. Form:

  ```markdown
  * [ ] Q: The question goes here

        A:
  ```

  The human writes the answer after `A:` and checks the box. When every question
  in the task is checked, the orchestrator resumes the task with the answers as
  context. Answers that are cross-cutting decisions get appended here.
- Reason: Same rule the human applies to their own agents; a checkbox makes
  "answered" unambiguous.
- Rejected: Agents pick a default and flag it.

## D-012 Infrastructure first
- Date: 2026-10-23
- Decision: A new target project starts with infrastructure tasks (stack, dev
  environment, database). Every other task implicitly depends on them, and the
  orchestrator won't start one until they're `done`.
- Reason: Required by the project goals.
- Rejected: A warning only.

## D-013 UI flow: design before implementation
- Date: 2026-10-23
- Decision: UI tasks go through `in-ui-development`. A designer agent drafts from
  the description plus `docs/design-rules.md` into Figma (through its MCP server)
  or Claude Design. The human iterates there and approves by setting `design:`.
  The implementer reads the design through Figma's Dev Mode MCP server.
- Reason: Required by the project goals. Claude Design's programmatic access
  still needs checking before relying on it; Figma is the known-good path.
- Rejected: HTML mockups committed to the repo.

## D-014 Review interface: VS Code extension
- Date: 2026-10-23
- Decision: The task worktree opens as a workspace folder for direct editing.
  Line comments use the VS Code Comments API, a chat participant
  (`@task T-NNN ...`) takes larger change requests, and an Approve button
  merges the branch.
- Reason: Covers direct editing, chat and line comments; editing works the
  usual VS Code way.
- Rejected: GitHub PR review as the interface; a custom web UI.

## D-015 Wikilinks: followed by our extension
- Date: 2026-10-23
- Decision: The extension registers a document link provider so `[[T-NNN]]`
  in Markdown opens `tasks/T-NNN.md` on Cmd+click.
- Reason: VS Code doesn't follow `[[ ]]` links natively; about 30 lines with no
  extra dependency.
- Rejected: The Foam extension; plain Markdown links.
- Amended 2026-10-23: link targets extended by D-032.

## D-016 Parsing and IPC: orchestrator owns the files
- Status: Removed, superseded by D-021.

## D-017 Python tooling
- Status: Removed, superseded by D-025 and D-026.

## D-018 Authentication: OAuth token, obtained at orchestrator startup
- Status: Removed, superseded by D-022 (which keeps OAuth over API keys).

## D-019 Review of generated code by three subagents
- Date: 2026-10-23
- Decision: Every unit of code Claude generates for this repo is reviewed by
  three separate subagents before it's shown to the human: (1) robustness to
  errors and crashes; (2) correctness and idiomatic code (TypeScript, per
  D-021); (3) security, including any place where agents running under the
  orchestrator get more than the essential access outside their container.
- Reason: Chosen by the human.
- Rejected: A single combined review.
- Exception (2026-10-23): throwaway code under `experiments/` gets no reviewer
  pass. It never becomes product code; anything kept is rewritten and reviewed.

## D-020 Target repos document their commands in README.md "Quick reference"
- Date: 2026-10-23
- Decision: Every repo the orchestrator works on (this one included) has a
  `README.md` with a `# Quick reference` section containing one fenced code
  block. In that block, each `# comment` line labels the command line(s) after
  it, up to the next comment or blank line. A label ending with ` (required gate)` marks
  a gate command that must pass in D-010:

  ````markdown
  # Quick reference

  ```
  # Run unit tests (required gate)
  cargo test
  # Run end to end tests (required gate)
  cargo leptos e2e

  # Reset local development database
  ./scripts/reset_db.sh
  ```
  ````

  The whole section goes to every agent as context. If the README or the
  section is missing, the orchestrator creates an infrastructure task to write
  it, and other tasks wait on it (D-012).
- Reason: One place for humans and agents to learn the repo's commands, and the
  gate is deterministic.
- Rejected: Pipelines in TASKS.md listing check labels; letting the agent decide
  what to run; refusing to start when the section is missing.

## D-021 All-TypeScript orchestrator distributed as a VS Code extension
- Date: 2026-10-23
- Decision: The orchestrator is written entirely in TypeScript and ships as one
  VS Code extension (`.vsix`), using `@anthropic-ai/claude-agent-sdk`.
  - The extension starts a Node child process (the orchestrator worker) that
    owns all task-file parsing and writing, git worktrees and container
    control. The extension UI talks to it over Node IPC.
  - Agent loops run inside containers (D-024), so they keep running when
    VS Code closes. Orchestration (status changes, gate, notifications)
    pauses with the window and catches up from the Markdown files on reopen (D-004).
  - The worker drives `git` and `docker` on the host directly; no container gets
    the Docker socket.
  - One orchestrator per VS Code window, which means one per repo. A lock file in
    the repo's gitignored cache stops two windows from both orchestrating.
  - The orchestrator's only expectation of a target repo is D-020's Quick
    reference; it doesn't use the target's Makefile or scripts otherwise.
- Reason: One codebase and one parser, no host toolchain beyond VS Code and
  Docker, no Docker socket inside a container, and the review UI is in the
  same place.
- Rejected: Python daemon in a container plus a thin TypeScript extension (D-002,
  D-003, D-016, D-017).

## D-022 OAuth sign-in through the extension, token in SecretStorage
- Date: 2026-10-23
- Decision: Agents authenticate with a Claude OAuth token, not an API key. When
  the orchestrator has no working token, it runs `claude setup-token` in the
  base agent image, attached through the Docker Engine API (D-024). The
  extension shows a notification that opens the sign-in URL in the browser,
  then asks for the resulting code in a password input box and passes it back
  to the CLI. The captured token is stored in VS Code SecretStorage (the macOS
  Keychain) and handed to agent containers only as the
  `CLAUDE_CODE_OAUTH_TOKEN` environment variable when they start. A "Sign in"
  command restarts the flow, and a rejected token triggers it again.
- Reason: OAuth was the human's choice; the flow is entirely internal to the
  orchestrator after it starts, with no plaintext token file. Experiment E-001
  confirmed `setup-token` supports the paste-the-code sign-in this needs.
- Rejected: API keys (`ANTHROPIC_API_KEY`); a `.env` file; a terminal-only
  flow; a localhost web page; a host pseudo-terminal (`node-pty`).

## D-023 Design principle: every reference is a link
- Date: 2026-10-23
- Decision: Any important view of tasks, agents, or other entities the
  orchestrator deals with links every reference to another entity, so the human
  can jump between them quickly: task to its dependencies, its agents, its
  review, its questions; agent to its task; and so on. This applies to the
  Markdown files and to every extension view.
- Reason: Chosen by the human.
- Rejected: Plain-text references.

## D-024 Agent images: extension-owned base image + derived task images
- Date: 2026-10-23
- Decision: The extension owns a base agent image (Claude Code pinned, git,
  shell tools, non-root user). It runs the sign-in flow (D-022) and the
  infrastructure tasks (D-012). Once a target repo has a dev image, its other
  tasks run in an image built `FROM` that dev image plus Claude Code. Sign-in
  attaches to the container through the Docker Engine API with `Tty: true` and
  a wide console (1000 columns); no `node-pty`, so the extension is pure
  JavaScript. Per E-001, the flow waits for the prompt to go idle before
  sending the code, handles "Invalid code / Press Enter to retry", and
  enforces its own deadline.
- Reason: Experiment E-001 (docs/experiments.md) showed this works; target repos
  need no changes, and infrastructure tasks have somewhere to run before a dev
  image exists.
- Rejected: Requiring target dev containers to include Claude Code; running
  every task in the base image with Docker access; `node-pty` on the host.

## D-025 Extension build tooling
- Date: 2026-10-23
- Decision: npm for packages; esbuild bundles two entry points (extension and
  worker); `tsc --noEmit` type checks; ESLint with typescript-eslint lints;
  `@vscode/vsce` packages.
- Reason: The VS Code-recommended path, fast, with little config.
- Rejected: pnpm; tsup, Rollup, Rolldown, webpack, Vite; no bundler.
- Amended 2026-10-23: TypeScript is pinned to 6.0.3, the last JavaScript-based
  compiler. TypeScript 7 (the native compiler) is now `latest` on npm, but
  typescript-eslint 8.72 supports only `<6.1`. Move to 7 when typescript-eslint
  does. Rejected: TS 7 alongside TS 6 for linting only; TS 7 with a different
  linter.

## D-026 Test frameworks
- Date: 2026-10-23
- Decision: Vitest for the worker and other logic that doesn't need VS Code;
  `@vscode/test-cli` (Mocha) for tests that need a real VS Code instance.
- Reason: Most tests stay fast; only integration tests pay VS Code's startup.
- Rejected: Mocha for everything.

## D-027 Links to a task's review
- Date: 2026-10-23
- Decision: When a task enters `review`, the orchestrator adds
  `* review: [Open review](vscode://<publisher>.excaliharness/review/T-NNN)` to
  its metadata list; the extension's URI handler opens the worktree, diff and
  comment threads. The editor also shows an "Open review" CodeLens above the
  status line and on the task's `TASKS.md` entry.
- Reason: D-023; the link works from anywhere, the CodeLens is one click in
  the editor.
- Rejected: Only one of the two.

## D-028 Extension publisher id: `madhadron`
- Date: 2026-10-23
- Decision: The extension id is `madhadron.excaliharness`, so review links are
  `vscode://madhadron.excaliharness/review/T-NNN` (D-027).
- Reason: Chosen by the human. Fixed early because SecretStorage, settings and
  links written into task files are all keyed on the extension id.
- Rejected: `fred`.

## D-029 Base agent image is built locally from the shipped Dockerfile
- Date: 2026-10-23
- Decision: The `.vsix` includes `agent-image/Dockerfile`. The first time the
  extension needs the base agent image (D-024), for sign-in or an
  infrastructure task, it builds the image with the local Docker and reuses it
  afterwards; a changed Dockerfile in a new extension version triggers a rebuild.
- Reason: Chosen by the human; nothing to publish or maintain outside the
  extension.
- Rejected: Publishing the image to a registry and pulling it.

## D-030 Task files are parsed line by line, and edited by line range
- Date: 2026-10-23
- Decision: A hand-written, line-based parser reads the constrained task
  format (title, metadata list, `##` sections, Q/A items), skipping fenced code
  blocks. Writes replace exact line ranges, leaving every other byte untouched.
- Reason: No dependencies, and human formatting survives exactly.
- Rejected: `remark`/mdast editing by source position; `remark` with re-stringify.

## D-031 References in task metadata are wikilinks
- Date: 2026-10-23
- Decision: Metadata that refers to other entities uses wikilinks, e.g.
  `* depends_on: [[T-001]], [[T-004]]`. This revises the example in D-005.
- Reason: D-023.
- Rejected: D-005's `[T-001, T-004]`.

## D-032 Wikilink targets
- Date: 2026-10-23
- Decision: `[[T-NNN]]` resolves to `tasks/T-NNN.md`; `[[path/name]]` resolves
  to `path/name.md` from the repo root (agents, docs). Extends D-015.
- Reason: Pipelines link to agents, and D-023 wants links everywhere.
- Rejected: Task ids only.

## D-033 Pipelines in TASKS.md are a nested list
- Date: 2026-10-23
- Decision: `TASKS.md` has a `## Pipelines` section: each top-level item is a
  pipeline name; its sub-items are `role: [[agents/name]], ...`. Fixes the
  format D-008 left open.

  ```markdown
  ## Pipelines
  * default
      * implement: [[agents/implementer]]
      * review: [[agents/test-reviewer]], [[agents/security-reviewer]]
  ```
- Reason: Same list-based, no-YAML style as task metadata (D-005).
- Rejected: A YAML block; one file per pipeline.

## D-034 The orchestrator maintains the TASKS.md index
- Date: 2026-10-23
- Decision: `TASKS.md` has a `## Index` section with one line per task file,
  `* [[T-NNN]] Title · status`. The orchestrator adds and updates these lines;
  everything else in the file is left alone.
- Reason: The index stays correct and readable outside VS Code.
- Rejected: Human-maintained index that the orchestrator checks; no index in
  the file (extension tree view only).

## D-035 Writes are atomic with an optimistic check
- Date: 2026-10-23
- Decision: The worker reads a file, applies its line-range edit, and writes it
  atomically (temp file + rename) only if the file is unchanged since the read;
  otherwise it re-reads and retries. VS Code reloads unmodified buffers and
  warns on save for modified ones.
- Reason: Keeps the worker the only writer (D-021) and testable without VS Code.
- Rejected: Writing through the extension with `WorkspaceEdit`.

## D-036 The worker watches task files with fs.watch
- Date: 2026-10-23
- Decision: The worker watches `TASKS.md` and `tasks/` with `fs.watch`,
  debounced at 500 ms, and ignores its own writes by comparing content hashes.
- Reason: Watching stays next to the logic and works in unit tests.
- Rejected: VS Code's FileSystemWatcher forwarding events over IPC.
- Amended 2026-10-23: watching a file follows its inode, so it goes deaf after
  the first atomic rename. The worker watches the repo root (non-recursive,
  filtered to `TASKS.md`) and the `tasks/` directory, re-arms if `tasks/` is
  deleted or recreated, treats every event as a hint to rescan all task files,
  and also rescans every 30 s for dropped events. Rejected: polling only.

## D-037 Who changes which status
- Date: 2026-10-23
- Decision: The human sets `ready` (start work) and `done` (accept). The
  orchestrator sets everything else, including `waiting-for-dependencies` ↔
  `ready` from dependencies and infrastructure tasks (D-012), and
  `needs-decision` ↔ resuming from Q/A checkboxes (D-011). A change that isn't
  allowed is noted in the task's Updates and otherwise ignored; the
  orchestrator never reverts human edits.
- Reason: Human edits are never fought over, and nothing starts by accident.
- Rejected: Reverting disallowed changes; allowing any change.

## D-038 Parse errors are reported as VS Code diagnostics
- Date: 2026-10-23
- Decision: A task file that doesn't parse gets a diagnostic in the Problems
  panel on the offending line, plus an Updates entry only when the Updates
  section can still be found. Revises D-006's "reported in its Updates section".
- Reason: Writing into a file that doesn't parse is risky; a squiggle points at
  the exact line.
- Rejected: An Updates entry only.

## D-039 The worker pushes notifications to the extension
- Date: 2026-10-23
- Decision: Besides requests with an `id` (e.g. `tasks/list`), the IPC
  protocol has notifications from the worker without an `id`
  (`tasks/changed`, `tasks/diagnostics`).
- Reason: The worker learns about changes first.
- Rejected: The extension polling with requests.

## D-040 Worker module layout for tasks
- Date: 2026-10-23
- Decision: `src/worker/tasks/` holds `model.ts`, `parse.ts`, `edit.ts` and
  `transitions.ts`; `src/worker/watch.ts` does the watching; `src/links.ts` is
  the extension's link provider.
- Reason: Parsing, editing and transition rules can each be tested in isolation.
- Rejected: A single `tasks.ts`.

## D-041 Design principle: every capability is discoverable
- Date: 2026-10-23
- Decision: Every capability the extension or orchestrator offers has an
  affordance that makes it discoverable where the human is working (a CodeLens,
  command palette entry, context menu, hover, button or link), rather than
  depending on the human knowing a file format, key or command name.
- Reason: Chosen by the human.
- Rejected: Capabilities reachable only by editing files or remembering commands.

## D-042 Infrastructure tasks are marked in metadata
- Date: 2026-10-23
- Decision: An infrastructure task (D-012) has `* kind: infrastructure` in its
  metadata list; without the key a task is a normal task.
- Reason: Explicit, per task, and easy to show in the index.
- Rejected: Inferring it from `pipeline: infrastructure`; an `## Infrastructure`
  section in TASKS.md.

## D-043 Status changes from the editor: CodeLens and commands
- Date: 2026-10-23
- Decision: Above a task's `status:` line, a CodeLens offers "Mark ready" and
  "Mark done", each shown only when D-037 allows that change from the current
  status. The command palette has the same actions ("Excaliharness: Mark Task
  Ready", "Excaliharness: Mark Task Done") for the task in the active editor.
  Both send `tasks/setStatus` to the worker, which checks the rule and writes.
- Reason: D-041; editing the status line by hand is error-prone and hard to
  discover.
- Rejected: A quick pick of allowed statuses; leaving it for later.

## D-044 A second window on the same repo is read-only
- Date: 2026-10-23
- Decision: The worker holding the D-021 lock orchestrates; a worker in another
  window on the same repo runs read-only. Links, diagnostics and CodeLens still
  work there; writes (Mark ready/done) are disabled with a message saying
  another window is orchestrating, and it takes over when the lock is released
  or found stale.
- Reason: Two writers would fight over the same files.
- Rejected: Leaving the second window inactive.

## D-045 Marking a task with unsaved edits
- Date: 2026-10-23
- Decision: When Mark ready/done is used on a task file with unsaved changes,
  the extension refuses and shows a message with a "Save and mark ready" (or
  "Save and mark done") button. Nothing is saved without that click.
- Reason: The worker writes to disk, and a later save of the stale buffer would
  overwrite its change.
- Rejected: Saving automatically; refusing without the button.

## D-046 The extension restarts a crashed worker
- Date: 2026-10-23
- Decision: If the worker exits unexpectedly, the extension restarts it after
  1 s, 2 s, 4 s and so on, up to 30 s. After 5 crashes within 5 minutes it
  stops and shows an error with a "Restart worker" button and a link to the
  log. Each start reconciles from the files (D-004).
- Reason: The watcher lives in the worker, so a crash would otherwise stop all
  orchestration silently.
- Rejected: No automatic restart.

## D-047 New tasks start as `draft`
- Date: 2026-10-23
- Decision: D-009 gains `draft`, the status of a task the human is still
  writing; the orchestrator never changes a draft. "Mark ready" moves `draft`
  (or `needs-human`) to `ready`; the orchestrator then moves `ready` to
  `waiting-for-dependencies` while dependencies aren't done, and back when they
  are. A task file seen for the first time with no recorded status change is
  treated as coming from `draft`.
- Reason: Otherwise a task could be promoted, and later started, while the
  human is still editing it.
- Rejected: No new status, with new tasks starting in waiting-for-dependencies.

## D-048 The orchestrator lock has a heartbeat
- Date: 2026-10-24
- Decision: The worker holding the lock (D-021, D-044) touches the lock file
  every 10 s. A lock not touched for 60 s is stale whatever host it names; on
  the same host, a lock whose pid is dead or belongs to another program is
  stale at once. The heartbeat also checks the lock still holds the worker's
  record and switches it to read-only if not.
- Reason: Without it, a lock naming another host was never stale, so a
  hostname change (common on macOS) after a crash, or a lock file committed to
  the repo, left every window read-only for good.
- Rejected: Never taking over a lock from another host; ignoring the host and
  relying on the pid check alone.

## D-049 Sign-in starts when first needed, and is always reachable
- Date: 2026-10-24
- Decision: Sign-in (D-022) starts the first time something needs a token. A
  "Sign In to Claude" command and a status bar item ("Claude: signed in" /
  "Claude: sign in", clickable) make it reachable at any time (D-041).
- Reason: No prompt before anything needs it, but always visible.
- Rejected: Prompting at every activation without a token.

## D-050 The worker runs Docker; the extension holds the token
- Date: 2026-10-24
- Decision: The worker builds the base image and runs the sign-in container.
  The extension shows the sign-in UI and keeps the token in SecretStorage,
  handing it to the worker over IPC only when needed; the worker keeps it in
  memory and never logs it.
- Reason: Docker access stays in one process; SecretStorage only exists in the
  extension.
- Rejected: The extension driving Docker itself.

## D-051 Docker: CLI for builds, Engine API for containers
- Date: 2026-10-24
- Decision: Images are built with `docker build`. Containers are created,
  attached to and removed through the Docker Engine API over its Unix socket,
  using Node built-ins only (as in E-001).
- Reason: Building through the API means streaming the context as a tar;
  attaching to a container's terminal needs the API, and E-001 showed it works
  without a dependency.
- Rejected: The `dockerode` library; the CLI for everything.

## D-052 The base image is identified by ID and never pulled
- Date: 2026-10-24
- Decision: The base image is built with `--pull=false`, labeled
  `org.excaliharness.dockerfile-sha256=<hash of its Dockerfile>`, and tagged
  `excaliharness-agent-base:<first 12 hex digits of that hash>` for people to
  read. Containers are created from the image ID (`sha256:…`) written by
  `--iidfile`, never from a name, and the worker never pulls an image. An image
  found under the tag is reused only if its label matches; otherwise it is
  rebuilt. The only network fetch in the build is the base image, pinned by
  digest. A progress notification with "Show log" covers the build.
- Reason: A name can never bring in someone else's image from a registry, and
  a changed Dockerfile is rebuilt automatically (D-029).
- Rejected: Running by tag; tagging with the extension version.
- Amended 2026-10-24, from the security review:
  - The build fetches more than the base image: `apt-get` packages and the
    pinned Claude Code npm package (with its unpinned dependencies and install
    scripts). The base image itself is fetched only if missing, and its
    digest is verified.
  - The label guards against a stale image, not tampering: anyone who can run
    Docker on the machine could forge it, and they are root-equivalent anyway.
  - The build is sent to the same daemon as the API calls (`docker -H
    unix://<socket>`, with DOCKER_HOST, DOCKER_CONTEXT and BUILDX_BUILDER
    cleared).
  - VS Code's progress notifications can't have buttons, so "Show log" is
    offered when sign-in fails rather than during the build.

## D-053 The token is checked once, after sign-in
- Date: 2026-10-24
- Decision: Right after sign-in, the worker runs `claude -p "Reply with
  exactly: ok"` in a fresh container with only the token; after that the token
  is trusted until an agent run rejects it, which starts sign-in again (D-022).
- Reason: Catches a bad paste while the human is there, at no recurring cost.
- Rejected: Checking at every start; never checking.

## D-054 Sign-in UI
- Date: 2026-10-24
- Decision: A notification with "Open sign-in page", then a password input box
  titled "Paste the code shown after you sign in". A rejected code shows "That
  code didn't work" and a new input box. After 10 minutes: "Sign-in timed out"
  with a Retry button.
- Reason: Native VS Code UI, covering the cases E-001 found.
- Rejected: A webview panel.
- Amended 2026-10-24, from the first successful manual sign-in: after Enter
  the code box stays open, greyed out and disabled, with VS Code's progress bar
  (no extra spinner, at the human's request), while the code is checked ("Checking
  the code with Claude…") and then the new token ("Code accepted. Checking the
  new token…"). It closes when sign-in finishes; a rejected code makes it
  editable again with "That code didn't work." under it.

## D-055 Docker availability is checked before use
- Date: 2026-10-24
- Decision: Before building or running anything, the worker checks the Docker
  socket. If Docker can't be reached, the extension shows "Docker isn't running"
  with a Retry button.
- Reason: A clear message at the moment it matters.
- Rejected: Failing partway through a build.

## D-056 Sign-in containers are hardened
- Date: 2026-10-24
- Decision: Sign-in and token-check containers run with `CapDrop: ALL`,
  `no-new-privileges`, a read-only root filesystem with tmpfs for the home
  directory and /tmp, a non-root user, no mounts, and are removed when done.
- Reason: They need nothing but network access to claude.ai.
- Rejected: Docker's defaults.
- Amended 2026-10-24, from the security and robustness reviews: also a
  numeric user (1000:1000), private IPC, a 256-process limit, 1 GB of memory,
  size-limited tmpfs mounts with noexec, nosuid and nodev, and a role label so
  leftovers from a crashed worker are removed before each sign-in. The sign-in
  container keeps no log on the daemon (its output contains the token), is
  removed automatically when it exits, and runs under `timeout` so it ends
  even if the worker is gone.

## D-057 Signed-in status bar offers sign in again or sign out
- Date: 2026-10-24
- Decision: Clicking "Claude: signed in" opens a dialog, "Excaliharness is
  signed in to Claude.", with "Sign in again" (replaces the stored token) and
  "Sign out" (removes it from VS Code). The dialog says the token stays valid
  until revoked on claude.ai. "Sign Out of Claude" is also in the command
  palette while signed in (D-041). Clicking "Claude: sign in" still signs in
  directly.
- Reason: Chosen by the human; a click on "signed in" shouldn't silently start
  a new sign-in.
- Rejected: Always starting a new sign-in on click.
