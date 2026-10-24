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

## D-006 Triggering: file watcher, status changes only
- Date: 2026-10-23
- Decision: The orchestrator watches the task files with a debounce, re-parses,
  and acts only on status changes (and on questions being checked off, D-011).
  A file that doesn't parse is reported in its Updates section, never acted on.
- Reason: Reacts immediately without half-finished edits launching agents.
- Rejected: Git post-commit hook; an explicit `start` command.

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
