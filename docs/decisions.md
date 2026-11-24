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
- Amended 2026-10-24: containers run through the target's Compose with a
  generated override (D-059); worktree and branch details in D-069.

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
- Amended 2026-10-24: the loop is specified in D-072, notifications in D-077.

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
- Amended 2026-10-24: agent containers get the token through the egress proxy
  instead (D-066).

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
- Amended 2026-10-24: disallowed hand edits park the task (D-076).

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

## D-058 Target repos keep their Dockerfile and Compose file at the root
- Date: 2026-10-24
- Decision: The orchestrator looks for `Dockerfile` and one of `compose.yaml`,
  `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` at the repo root.
  If either is missing, tasks other than infrastructure tasks can't start, and
  the human is told which file is missing.
- Reason: Chosen by the human.
- Rejected: Searching subdirectories; a setting naming the files.

## D-059 Agents run through the target's Compose with a generated override
- Date: 2026-10-24
- Decision: The worker runs the task's services with the target's Compose file
  from the **main checkout** plus an override it generates outside the repo,
  built from `docker compose config --format json`. The override locks down
  the dev service (D-056's hardening, the task worktree as the only mount, no
  `env_file`, only declared environment variables). If the resolved config
  gives the dev service anything that can't be safely overridden (privileged,
  added capabilities or devices, host network/PID/IPC, the Docker socket or host
  paths outside the repo), the task doesn't start and the human is told why.
  Other services keep their own settings. Requires Compose 2.24 or later.
  Revises D-007's "inside the target project's Docker Compose dev container".
- Reason: Uses the project's own services without inheriting settings an agent
  must not have.
- Rejected: Running the target's Compose service as is; ignoring Compose and
  creating every container through the Engine API.

## D-060 Agent networking
- Date: 2026-10-24
- Decision: The override adds `excaliharness-internal-network` (internal: no
  route out) and `excaliharness-egress-network`. The dev service is only on the
  internal network; every other service also joins it (found from the resolved
  config; a service with `network_mode` set is reported). The
  `excaliharness-egress-proxy` service is on both and is the agent's only way
  out, forwarding only to Claude's API.
- Reason: Agents reach the project's services and Claude, and nothing else.
- Rejected: Docker's default bridge network; short names like `agents`.

## D-061 One Compose project per task; agent containers are labeled
- Date: 2026-10-24
- Decision: Each task runs as Compose project `excaliharness-t-nnn` with its own
  copy of the project's services. Agent containers carry
  `org.excaliharness.role=agent`.
- Reason: Tasks don't share state, and our containers are findable.
- Rejected: One shared set of services for all tasks.

## D-062 Dependencies come from the image; rebuild and resume between rounds
- Date: 2026-10-24
- Decision: Agents can't install packages (no registry access). Dependency
  changes go into the Dockerfile or manifests; between rounds the worker
  rebuilds and resumes the same agent session in a fresh container from the
  new image. Infrastructure tasks, which run in the base image, are checked on
  the host: the worker builds the dev and derived images, runs the capability
  check and the required gates, and returns failures as findings.
- Reason: Chosen by the human ("way out 1").
- Rejected: Dependency changes as separate infrastructure tasks; allowing
  package registries through the proxy.

## D-063 The dev service is the one built from the root Dockerfile
- Date: 2026-10-24
- Decision: The Compose service whose build uses the root `Dockerfile` is the
  dev environment. None or more than one refuses the start, with a message.
- Reason: No new convention for repos.
- Rejected: A fixed service name; a label.
- Amended 2026-10-30: when several services build from the root
  `Dockerfile` (a web service and a worker, or this repo's `dev` and
  `lock`), the one named `dev` is the dev service; with none named `dev`,
  the start is refused with a message saying to name one. Rejected: a
  label; changing only this repo's Compose file.

## D-064 A thin derived image adds Claude Code
- Date: 2026-10-24
- Decision: `docker compose build` builds the target's dev image as the project
  defines it; the worker then builds a thin image `FROM` its ID adding the
  pinned Claude Code native binary (checksum-verified, glibc or musl build to
  match), git if missing, stripped setuid bits and numeric user 1000. It is
  labeled with the dev image ID and a hash of the layer's Dockerfile, built
  with `--pull=false`, and used by ID. The override sets `image: sha256:…`,
  `build: !reset null` and `pull_policy: never`. Details D-024 left open.
- Reason: The CLI version stays the extension's, not in files an agent edits,
  and the native binary needs no Node.
- Rejected: Requiring the dev image to include Claude Code; the npm package.
- Amended 2026-10-24: the derived build names its inputs as
  `excaliharness-pinned:<ID hex>` tags created for the exact image IDs just
  before building, since BuildKit won't take a bare ID (E-008). Claude Code is
  the pinned native binary, copied from the base agent image.
- Amended 2026-10-24: only glibc (Debian or Ubuntu-based) dev images are
  supported. A musl (Alpine) dev image fails the capability check (D-065)
  with a message saying so. Rejected: supporting musl.

## D-065 Capability check per image
- Date: 2026-10-24
- Decision: Once per derived image ID, a hardened throwaway container checks:
  the CLI runs, git and a shell exist, the user isn't root, home and
  `/workspace` are writable, each required-gate program exists, and the proxy
  is reachable. Each failure is a specific message; the result is cached by
  image ID.
- Reason: Problems surface before an agent wastes a round.
- Rejected: Letting runs fail.

## D-066 Only the egress proxy holds the token
- Date: 2026-10-24
- Decision: Agent containers get
  `ANTHROPIC_BASE_URL=http://excaliharness-egress-proxy:8080` and a placeholder
  token; the proxy adds the real one and forwards only to Claude's API. The
  proxy is ours, built and run by ID like the base image. Supersedes D-022's
  environment variable for agent containers (sign-in and token-check
  containers keep it). Subject to experiment E-005.
- Reason: Nothing an agent runs can read the token or send data elsewhere.
- Rejected: Environment variable; stdin.

## D-067 The agent loop runs in the worker
- Date: 2026-10-24
- Decision: The Agent SDK runs in the worker on the host and spawns the CLI
  through `docker compose run` in the task's project. Subject to experiment
  E-006.
- Reason: The orchestrator's tools and state stay out of the agent's reach.
- Rejected: Running the SDK inside the container.

## D-068 Agents talk to the orchestrator through tools
- Date: 2026-10-24
- Decision: The worker gives agents SDK tools: `ask_question` (writes a D-011
  question to the main task file and sets `needs-decision`),
  `report_findings` (reviewers), `finish` (round summary). `tasks/`,
  `TASKS.md`, `agents/` and `docs/decisions.md` are mounted read-only over the
  worktree.
- Reason: Agents can't forge status history; the worker stays the only writer.
- Rejected: Agents editing task files directly.

## D-069 Git stays on the host
- Date: 2026-10-24
- Decision: Each task has worktree `.worktrees/T-NNN` on branch `task/T-NNN`,
  started from `main`'s current commit. Containers get no `.git`. The worker
  commits after each round on the host with hooks, fsmonitor and system config
  disabled, authored "Excaliharness (<agent role>)". Round prompts include the
  diff so far.
- Reason: Removes the highest-severity roadmap risk; agents don't need git to
  edit.
- Rejected: Giving agents a repository; returning patches.
- Amended 2026-10-24: worktrees live at `.excaliharness/worktrees/T-NNN`,
  inside the cache directory that ignores itself, so the target's `.gitignore`
  is never touched. Rejected: `.worktrees/T-NNN`.

## D-070 Rebuild between every round
- Date: 2026-10-24
- Decision: Between rounds the worker always runs `docker compose build` and
  the derived build; Docker's cache makes this a no-op when nothing changed.
- Reason: Catches every kind of change with nothing to maintain.
- Rejected: A list of files that trigger a rebuild.

## D-071 Agent sessions persist per task
- Date: 2026-10-24
- Decision: Volume `excaliharness-t-nnn-session` is mounted as the agent's
  `~/.claude`, so each round resumes the same session.
- Reason: The agent keeps its context across rebuilds (D-062).
- Rejected: A new session each round with a summary.

## D-072 The gate loop
- Date: 2026-10-24
- Decision: A round: implementer turn, commit, the README's required gates in a
  fresh container, then each review agent in its own container with the
  worktree mounted read-only (Bash allowed for running things; frontmatter may
  restrict tools further). If a gate fails or anything is reported, the next
  round gets the failures and findings. Clean means no failures and no
  findings, nits included. After 3 rounds the task becomes `needs-human` with
  the open findings in Updates. Makes D-010 concrete.
- Reason: The human sees work with no nits, lints or failing tests left; a
  read-only mount is enforced by the kernel, not just by tool settings.
- Rejected: Fixing only blocking findings; reviewers in the implementer's
  container with tool restrictions alone.

## D-073 Prompts are built from reviewable files
- Date: 2026-10-24
- Decision: System prompt: the agent's `agents/*.md` body (main checkout),
  `docs/decisions.md`, the README Quick reference, and the task-format rules.
  User prompt: the task's Context, Issue and Expectation, answered questions,
  and the previous round's results. Model and tools from the agent's
  frontmatter.
- Reason: D-008, D-020; everything agents see is in files the human reviews.
- Rejected: A fixed built-in prompt.

## D-074 At most two tasks run at once
- Date: 2026-10-24
- Decision: Setting `excaliharness.maxParallelTasks`, default 2; waiting tasks
  start in task-id order.
- Reason: Caps Docker load and token spend.
- Rejected: One at a time; no limit.

## D-075 Side effects are named per task and idempotent
- Date: 2026-10-24
- Decision: Compose project, worktree, branch and session volume are named
  after the task. Before starting, the worker removes the project's leftover
  containers and reuses an existing worktree and branch. A running task is
  never started twice.
- Reason: A restart or a reverted save can't create a second agent.
- Rejected: —

## D-076 Hand edits into orchestrator-managed statuses park the task
- Date: 2026-10-24
- Decision: A task hand-edited into a status only the orchestrator sets is
  parked: no automatic transitions until the human sets `ready`, `done` (if it
  was in `review`) or `draft`. A parked task gets an error diagnostic on its
  status line ("T-007 is parked: its status was set by hand to …, which only
  the orchestrator sets. Mark it ready, done or draft to continue."), its index
  line reads `· parked (<status>)`, and the CodeLens offers "Mark ready",
  "Back to draft" and, if it was in review, "Mark done". "Back to draft" is a
  human change allowed only for parked tasks. Amends D-037.
- Reason: Prevents accidental starts and makes the state visible (D-041).
- Rejected: Noting the edit and acting on the new status later.

## D-077 Notifications when work is ready
- Date: 2026-10-24
- Decision: On `review` or `needs-human`, a VS Code notification ("Task T-007
  is ready for review" / "Task T-007 needs you") with "Open review", which
  opens the task's worktree folder until the review UI exists, plus macOS
  `say`. Implements D-010's notification.
- Reason: D-010.
- Rejected: Notifications without speech.

## D-078 Pipelines must name existing agents
- Date: 2026-10-24
- Decision: A pipeline naming an `agents/*.md` that doesn't exist is a
  diagnostic and the task doesn't start. No built-in default agents.
- Reason: Agents stay explicit and reviewable; a command to create defaults can
  come later.
- Rejected: Shipping default agents.

## D-079 Fixes from the unit A reviews
- Date: 2026-10-24
- Decision: Amendments and additions from the three D-019 reviews of the agent
  runner:
  - D-061 amended: projects are named `excaliharness-<repo hash>-t-nnn`
    (the first 8 hex digits of the SHA-256 of the repository's path), so two
    windows on different repositories never share a project. At start-up the
    worker stops leftover projects with its own prefix.
  - D-071 amended: the session volume is named
    `excaliharness-<repo hash>-t-nnn-session`, and the images create
    `/home/agent/.claude` owned by uid 1000 so a new volume is writable.
  - D-069 amended: worktrees live in the extension's per-workspace storage,
    `<stateDir>/worktrees/T-NNN`, outside the repository, so builds and the
    editor never pick them up. Every host git call names the worktree's git
    directory and work tree itself, so a `.git` file the agent rewrote is
    never read; the container's `/workspace/.git` is an empty read-only file.
    Changes under the read-only paths (D-068) are never committed.
  - D-073 amended: the system prompt is Claude Code's own (fixed by the pinned
    CLI version) with ours appended.
  - D-059 extended: the dev service is also refused for any `network_mode`,
    `cgroup`/`uts: host`, or `pid`/`ipc` naming another container; any service
    whose image is named `excaliharness-*` is refused. The agent's environment
    replaces the dev service's, and Compose gets only `PATH`, `HOME`,
    `DOCKER_CONFIG` and `TMPDIR` from the worker's environment, plus
    `DOCKER_HOST`. Services are started with
    `--no-deps`; other services with `build:` are built too.
  - D-060 amended: other services keep their own networks. Accepted risk: an
    agent can use them to reach the internet.
  - D-066 extended: the proxy forwards only `POST /v1/messages` and
    `/v1/messages/count_tokens`, and refuses bodies with `mcp_servers`,
    `container` or non-custom tools, and betas for MCP, code execution,
    Files, web fetch or computer use.
  - An agent file without `tools:` is an error; the task doesn't start.
  - A round stops after 60 minutes or 100 turns and the task goes to
    `needs-human` with the reason.
  - When Claude rejects the token, the worker drops it and asks the human to
    sign in again; the task stays `in-implementation` and resumes.
  - Tasks need Docker Engine 26.0.0 or later (CVE-2024-29018).
  - Malicious target repositories are out of scope for now (roadmap).
- Reason: The reviews' blocking and should-fix findings.
- Rejected: Internal-only networks for other services; path-only proxy
  rules; keeping worktrees in `.excaliharness`; inheriting all tools when
  `tools:` is missing; 200 turns.
- Amended 2026-10-25, after the second round of reviews:
  - D-076 amended: any hand edit that isn't allowed parks the task, not only
    one into an orchestrator-only status. Its message names where it came
    from: "T-007 is parked: its status was set by hand to done, which isn't
    allowed from draft. Mark it ready or draft to continue." Rejected:
    parking only orchestrator-only statuses, which would let a hand-made
    draft → done unblock dependent tasks.
  - Agents and the capability check run through the dev image's entrypoint;
    a failing check says the entrypoint must run the command it is given.
    Rejected: always bypassing it with `--entrypoint`.
  - Host git refuses a worktree holding a nested repository, never looks
    into submodules, and never commits gitlinks.
  - The proxy also refuses content blocks whose source isn't inline (URL or
    file sources, at any depth), forwards the body as it was checked, refuses
    bodies nested deeper than 64 levels, and matches betas
    case-insensitively (adding `skills`).
  - After the third review round: a task parked in `done`, or hand-edited
    into `done` against the rules, doesn't count as done for its dependents.
    The worker commits only after the task's containers are down, and puts
    the worktree's `.git` file back as git wrote it before every git call
    (on macOS an agent can reach it as `.GIT`). A rejected token is believed
    only when the proxy saw Claude answer 401, since the CLI's output can be
    forged. Agent-written text is stripped of control and bidirectional
    characters where it enters the worker. Losing the lock stops running
    tasks.


- Amended 2026-10-25 (unit B): the 60-minute and 100-turn limits apply to
  each agent turn (the implementer's, or each reviewer's), not to a whole
  round, which now also holds rebuilds, gates (D-081) and reviewers.
  Rejected: one 60-minute limit per round.

## D-080 Rebuilds run offline first
- Date: 2026-10-25
- Decision: Between rounds (D-062, D-070) the dev and derived images are
  rebuilt from the worktree with the build's network off. If that build
  fails, the task goes to `needs-human` with the diff of the Dockerfile and
  dependency files since the last image; marking it `ready` allows one build
  with the network on.
- Reason: Agent-written build steps never reach the network without the
  human seeing them; cached and offline steps need no prompt.
- Rejected: Always building online; never building online.
- Amended 2026-10-25 after E-010 (BuildKit doesn't reuse layers built with
  the network on once it is off, so offline-first would ask every round):
  the images are rebuilt only when a round changed a build input: the
  Dockerfile, `.dockerignore`, a file the Dockerfile copies by name, or a
  known dependency manifest or lockfile. Source changes need no rebuild,
  since agents and gates work on the mounted worktree or commit. When a
  build input changed, the task goes to `needs-human` listing those files,
  and marking it `ready` runs one build with the network on (which also
  runs any build steps after `COPY . .`). The first build, from the commit
  the task started at, needs no approval. Amends D-070. Rejected: a
  registry-only network for builds; always building online.
- Amended 2026-10-25 after the unit B reviews: a build with the network on
  runs without approval only for a commit already trusted (the one the task
  started from, or one built before); any other commit only after the human
  approved exactly that commit, and an attempt uses the approval up. Builds
  read a copy of the commit, never the worktree. The detected build inputs
  (manifests, Dockerfiles and Compose files by name, and what each build's
  Dockerfile copies) only decide whether the image is stale. An
  infrastructure task's Compose file is the agent's: every service in it
  gets the dev service's refusals plus none of secrets, configs,
  `volumes_from`, build `ssh`/`secrets`/`additional_contexts`/
  `entitlements`/`network`/`privileged`, or a build context outside the
  repository. Agent text written into task files (questions, findings,
  summaries) has Markdown escaped, and " · " is kept for status entries,
  which must start with their date and time.
- Amended 2026-10-25: accepted risk, stated in the approval message: an
  approved build runs on the human's Docker daemon, where its steps can read
  the human's other local images and share their build cache. Rejected: a
  dedicated buildx builder, which needs a pulled BuildKit image (D-052).

## D-081 Gates run on a copy of the round's commit
- Date: 2026-10-25
- Decision: The worker exports the round's commit into a throwaway folder
  and runs the README's required gates there, read-write, in a fresh
  container of the agent image (same lockdown and networks). All gates
  together get 20 minutes; running over is a gate failure.
- Reason: Gates test exactly what was committed, and nothing they write
  reaches the worktree or a commit.
- Rejected: Running gates in the worktree; only the round's 60-minute limit.

## D-082 Reviewers start fresh each round and run at once
- Date: 2026-10-25
- Decision: Each round's reviewers get new sessions, the current diff from
  the main checkout's branch, and the previous round's findings only to check
  they were fixed. A pipeline's reviewers run at the same time, each in its
  own one-off container; they don't count against `maxParallelTasks`. A
  reviewer must call `report_findings` (an empty list means clean); ending
  without it counts as a finding.
- Reason: Reviewers judge the work as it is, not anchored to earlier rounds;
  rounds finish sooner.
- Rejected: Resuming reviewer sessions; reviewers one after another.

## D-083 Questions pause the round; rounds and findings in Updates
- Date: 2026-10-25
- Decision: An `ask_question` from any agent pauses the round; once answered,
  that round resumes and the count carries on. Only marking a `needs-human`
  task `ready` starts the count again. Each round adds one Updates line
  ("round 2: `make test` failed; 3 findings (1 blocking)"). On `needs-human`,
  each open finding gets an Updates line linking to the file in the
  worktree, up to 20, then "and N more".
- Reason: Questions can't get around the limit (D-072); the task file stays
  the one place to look (D-041).
- Rejected: Resetting the count on every answer; a `## Findings` section.

## D-084 Spoken notifications are a setting
- Date: 2026-10-25
- Decision: `excaliharness.speakNotifications` (default true) controls
  D-077's `say`; the visual notification always shows. "Open review" opens
  the worktree folder, which VS Code's Workspace Trust leaves untrusted, so
  its tasks and workspace settings don't run. Amends D-077.
- Reason: Speech isn't always welcome; trust keeps an agent's `.vscode`
  files inert.
- Rejected: Always speaking.
- Amended 2026-10-25: every status that needs the human notifies and
  speaks: `review` ("Task T-007 is ready for review"), every way into
  `needs-human` ("Task T-007 needs you"), and `needs-decision` ("Task T-007
  has a question for you", with "Open task" opening the task file at
  `## Questions` instead of "Open review"). Amends D-077.
- Amended 2026-10-30: speech says the task's number plainly ("Task 1 is
  ready for review"), since `say` reads "T-001" as letters and digits; the
  visual notification keeps the ID.

## D-085 Infrastructure tasks run only their dev service
- Date: 2026-10-25
- Decision: For an infrastructure task, the worker takes only the dev
  service's build settings from the agent's Compose file (context,
  Dockerfile, build args and target). The context and Dockerfile must be
  inside the repository with no symlinks on the way; any other build
  setting, `image:` or a reserved `excaliharness-*` name is refused. It
  builds and runs that service from a Compose file it writes itself, beside
  its own egress proxy. The agent's other services, volumes and networks
  never run until the human merges the task into the main checkout. Narrows
  D-062.
- Reason: The agent's Compose file is untrusted, like a malicious repo's
  (roadmap); running only what an allowlist builds closes the token,
  host-mount and network routes the reviews found.
- Rejected: Starting every service behind an allowlist of Compose settings;
  starting every service with the specific holes patched.
- Amended 2026-10-25 after review: before Compose reads the agent's file, a
  file mentioning `include`, `extends`, `env_file` or `label_file`, or using
  backslashes, YAML tags or explicit keys, is refused; Compose gets an empty
  env file of ours instead of the agent's `.env`. The task's reviewers run
  in the base agent image, not the one its Dockerfile built. Agent
  containers get empty `NODE_OPTIONS`, `LD_PRELOAD` and `LD_LIBRARY_PATH`.

## D-086 Follow-up review rounds are scoped
- Date: 2026-10-30
- Decision: A unit's first review is all three D-019 reviewers, given the
  threat model and the unit's decisions and scoped to its diff. Later rounds
  happen only for blocking or security fixes, scoped to the fix diff: the
  security reviewer plus whichever reviewer raised the item; robustness and
  correctness reviewers may use a cheaper model. Review stops when a round
  finds nothing blocking; remaining nits go on the roadmap. Amends D-019.
- Reason: Units A and B used 21 reviewer runs; after the first round, most
  findings outside security were nits, while each run cost 100–170k tokens.
- Rejected: Three full reviewers for every fix round.

## D-087 One JSON reviewer agent replaces the three focused reviewers
- Date: 2026-10-30
- Decision: Code review uses one global `reviewer` subagent
  (`~/.claude/agents/reviewer.md`, `model: opus`), run once per unit and
  covering robustness, correctness and security together. It returns only
  JSON: `{"findings":[{where:{file,line,symbol?},what,suggested_fix,severity}]}`
  with severity `blocking`, `guardrail` (may be fine in context but needs a
  guardrail to ensure it) or `nit`; `symbol` is a Serena name path. JSON-only
  is asked for in the prompt; nothing enforces it. Tools: Read, Grep, Glob,
  Serena and Thenwise MCP tools. A global `review` skill tells Claude to run
  it proactively when programming. Callers still pass the threat model and
  the unit's decisions and scope it to the diff. D-086's scoping of follow-up
  rounds still holds, and a follow-up round may pass a cheaper model as
  D-086 allows. Amends D-019 and D-086.
- Reason: Chosen by the human.
- Rejected: Three runs, one per focus; a SubagentStop hook that checks the
  JSON with jq; a read-only toolset without Serena; a project-only agent.
