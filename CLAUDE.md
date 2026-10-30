# Excaliharness

- Follow [docs/decisions.md](docs/decisions.md). If a decision seems wrong for
  the task at hand, say so and ask instead of deviating. The task file format is
  in [docs/task-format.md](docs/task-format.md); experiment results are in
  [docs/experiments.md](docs/experiments.md); agreed future work is in
  [docs/roadmap.md](docs/roadmap.md).
- Commands for this repo are in the README's Quick reference. Run them through
  `make`; nothing gets installed on the host.

## Review rule (D-019, amended by D-086)
- Every unit of generated code goes to three separate reviewer subagents
  before the human sees it: (1) robustness to errors and crashes;
  (2) correctness and idiomatic TypeScript; (3) security, including any place
  where agents running under the orchestrator get more than the essential
  access outside their container. Code under `experiments/` is exempt.
- Give reviewers the threat model below and the unit's decisions, and scope
  them to the unit's diff.
- Follow-up rounds only for blocking or security fixes, scoped to the fix
  diff: the security reviewer plus whichever reviewer raised the item.
  Robustness and correctness reviewers may use a cheaper model.
- Stop when a round finds nothing blocking; remaining nits go on the
  roadmap.

## Threat model
- In scope: a prompt-injected agent in a benign target repo. Out of scope
  (roadmap): a malicious target repo.
- Untrusted: everything an agent can write or influence — worktree files,
  commits, Dockerfiles, Compose files, `.env`, CLI output and exit text,
  tool-call arguments, findings, questions, summaries, gate output.
- Every proposal states what runs on the host or with network access because
  of untrusted content, and how it is bounded, before any code.

## Handling untrusted content
- Never base a security decision on a regex over untrusted text; use a
  parser, an allowlist built by construction, or run the tool sandboxed. Any
  matcher on agent input must be linear-time.
- Agent text enters task files, logs and prompts only through
  `src/worker/runner/clean.ts`, applied where it enters, not where it's
  written.
- Host-side tools (git, docker, compose) read copies of commits, never the
  live worktree, and only after the agent's containers are gone.
- Paths from untrusted trees: check them with realpath (symlinks), and
  remember macOS is case-insensitive (`.GIT` is `.git`).

## Persisted state
- For any state saved across runs, the plan lists each crash point and what
  a restart does there. Save before side effects; clear only after the
  orchestrator has recorded the result.

## Experiments before decisions
- A decision that depends on how a tool behaves (cache keys, flags,
  defaults) gets an experiment in `experiments/` first; record it in
  `docs/experiments.md` and cite it in the decision.

## Working efficiently
- Units of work touch about 10 files or fewer; split bigger ones into
  separately reviewed units.
- Plans name files and functions; give line numbers only for edits to about
  5 files or fewer.
- While iterating, run `make typecheck lint test-unit`; run `make check` once
  before reporting a unit done.
- A command run by hand more than twice becomes a script or Make target (e.g.
  the runner smoke test), never a retyped pipeline.
- Start a new session per unit; the docs are the handoff.

## Code conventions
- Don't pass functions to `map`/`filter`/`forEach` by reference when they
  have optional parameters; use a lambda.
- Test fixtures use the documented formats exactly (e.g. Updates lines with
  `YYYY-MM-DD HH:MM`).
- Shell pipelines on the host must work with macOS tools (`grep` here is
  ugrep); prefer running them in the dev container.
