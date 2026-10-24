# Experiment: `claude setup-token` without a host terminal

Question: can the extension drive `claude setup-token` inside a container,
with no host terminal, relaying the sign-in URL and code? See the plan in the
session and the outcome in [docs/experiments.md](../../docs/experiments.md).

Claude Code version under test: **2.1.310** (pinned in the Dockerfile).

## Setup

```
docker compose -f experiments/setup-token/compose.yml build agent
```

## Runs

Each successful run mints a real long-lived token on your account. The driver
redacts tokens in everything it prints or saves; transcripts go to `runs/`.

```
# A. Manual baseline (real terminal; you see the token, nothing is saved)
docker compose -f experiments/setup-token/compose.yml run --rm agent claude setup-token

# D. Tty created through the Docker API
docker compose -f experiments/setup-token/compose.yml run --rm driver --variant D

# C. `script` pseudo-terminal inside the container, plain pipes outside
docker compose -f experiments/setup-token/compose.yml run --rm driver --variant C

# B. Plain pipes, no terminal anywhere
docker compose -f experiments/setup-token/compose.yml run --rm driver --variant B

# Failure modes (on the winning variant; no token minted)
docker compose -f experiments/setup-token/compose.yml run --rm driver --variant D --bad-code
docker compose -f experiments/setup-token/compose.yml run --rm driver --variant D --timeout-ms 120000
```

While the driver runs, each line you type is sent to the CLI followed by
Enter. `:enter`, `:up`, `:down`, `:esc` and `:ctrl-c` send those keys.

## Results

| Variant | Mode | URL shown | Code accepted | Token intact | `claude -p` works | Exit | Notes |
|---|---|---|---|---|---|---|---|
| A | normal | yes | yes | yes (as seen) | not run | | Reported by the human |
| D | normal | yes | yes (input masked as `*`) | yes, 108 chars, no wrap at 1000 cols | yes ("ok") | 0 | |
| C | normal | | | | | | Skipped: D passed |
| B | normal | | | | | | Skipped: D passed |
| D | bad code, sent 2 s after URL | yes | input ignored | n/a | n/a | none (hung) | Nothing echoed; early input is swallowed |
| D | bad code, sent 15 s after URL | yes | rejected | n/a | n/a | none (waits) | "OAuth error: Invalid code…", "Press Enter to retry" |
| D | timeout 120 s | yes | n/a | n/a | n/a | none (waits) | No built-in timeout |
