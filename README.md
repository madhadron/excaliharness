Excaliharness is a VS Code extension for agentic coding where the human makes
the cross-cutting decisions early and reviews work in small, clean units.
Decisions live in [docs/decisions.md](docs/decisions.md); tasks live in
Markdown files that the orchestrator watches.

Development needs only Docker and VS Code on the host. Everything else runs in
the dev container defined in `Dockerfile` and `docker-compose.yml`. To try the
extension, press F5 in VS Code: it builds in the container and opens an
Extension Development Host on a fixture workspace.

# Quick reference

```
# Run type checking (required gate)
make typecheck
# Run lint (required gate)
make lint
# Run unit tests (required gate)
make test-unit
# Run VS Code integration tests (required gate)
make test-vscode
# Build the base agent image (required gate)
make agent-image

# Run every gate
make check
# Build the extension into dist/
make build
# Package the extension as a .vsix
make package
# Open a shell in the dev container
make shell
```

# Repository layout

The repository holds one VS Code extension, which contains the orchestrator,
plus everything needed to build, test and steer it. The code splits into the
extension (the UI side, running in VS Code's extension host) and the
orchestrator worker (a child process it starts), with two kinds of tests. The
Markdown under `docs/` is how humans and agents share context: agents read it
before working, and humans record decisions there. The build and test
infrastructure is all containers, so the host needs only Docker and VS Code.

* Source code (`src/`), bundled by esbuild into `dist/`
    * Extension: `src/extension.ts` (entry point) and the modules it wires up:
      `workerClient.ts` (starts, talks to and restarts the worker),
      `taskState.ts` (latest task snapshot), `links.ts` (wikilinks),
      `diagnostics.ts` (Problems panel), `statusLens.ts` and `commands.ts`
      (Mark ready / Mark done), `auth.ts` (Claude sign-in and the token),
      `editorText.ts` (pure text helpers)
    * Orchestrator worker: `src/worker/`, with `main.ts` as its entry point
        * `protocol.ts`: messages exchanged with the extension
        * `orchestrator.ts`: scans, applies status rules, writes, notifies
        * `store.ts`, `watch.ts`, `lock.ts`, `git.ts`: safe writes, file
          watching, the one-window-per-repo lock, reading git state
        * `docker.ts`, `agentImage.ts`, `signIn.ts`: the Docker Engine client,
          building the base agent image, and Claude sign-in
        * `tasks/`: the task file model, parser, edits, status rules and index
* Unit tests: `*.test.ts` next to the code they test (for example
  `src/worker/protocol.test.ts`), run by Vitest without VS Code
* VS Code integration tests: `src/test/`, run by `@vscode/test-cli` in a real,
  headless VS Code
    * `src/test/*.test.ts`: the tests
    * `src/test/fixtures/workspace/`: the workspace they open
* Context shared by humans and agents
    * `docs/decisions.md`: approved decisions; agents must follow them
    * `docs/task-format.md`: the task file and `TASKS.md` formats
    * `docs/experiments.md`: experiment results that decisions rely on
    * `docs/roadmap.md`: agreed future work and open constraints
    * `CLAUDE.md`: working rules for Claude sessions in this repository
    * This README's Quick reference: the commands used to do development
      tasks in this repository. Those marked as required gates must be run
      by all agents generating code and pass before the code is accepted.
* Build and test infrastructure
    * `Dockerfile`, `docker-compose.yml`: the dev container
    * `agent-image/`: the extension's base agent image, used for sign-in and
      for infrastructure tasks before a target repo has a dev image; other
      tasks run in an image derived from the target's own dev image (D-024)
    * `Makefile`: the commands in the Quick reference
    * `package.json`, `package-lock.json`: dependencies and npm scripts
    * `esbuild.mjs`, `tsconfig.json`, `eslint.config.mjs`, `vitest.config.mts`,
      `.vscode-test.mjs`: build, type-check, lint and test configuration
    * `.vscode/`: F5 launch and build task for debugging the extension
* Experiments: `experiments/`, throwaway code behind `docs/experiments.md`
