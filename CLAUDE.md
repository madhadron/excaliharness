# Excaliharness

- Follow [docs/decisions.md](docs/decisions.md). If a decision seems wrong for
  the task at hand, say so and ask instead of deviating. The task file format is
  in [docs/task-format.md](docs/task-format.md); experiment results are in
  [docs/experiments.md](docs/experiments.md); agreed future work is in
  [docs/roadmap.md](docs/roadmap.md).
- Commands for this repo are in the README's Quick reference. Run them through
  `make`; nothing gets installed on the host.
- Review rule (D-019): every unit of generated code goes to three separate
  reviewer subagents before the human sees it: (1) robustness to errors and
  crashes; (2) correctness and idiomatic TypeScript; (3) security, including
  any place where agents running under the orchestrator get more than the
  essential access outside their container. Code under `experiments/` is exempt.
