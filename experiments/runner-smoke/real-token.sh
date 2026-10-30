#!/bin/sh
# The gate loop with a real token: the real Orchestrator and TaskRunner take
# the stand-in repo's T-001 ("add hello.js") through the implementer, the
# required gate and a reviewer to review. Run from the repository root:
#   sh experiments/runner-smoke/real-token.sh
# It asks for a token (input hidden) and passes it only in the smoke
# container's environment, from where the worker gives it to the proxy. It
# prints the task's Updates, the commit and hello.js, never the token.
set -eu
repo=$(pwd)
w="$repo/experiments/runner-smoke/work"
printf 'Paste a Claude OAuth token (input hidden): '
stty -echo 2>/dev/null || true; read -r EXCALIHARNESS_SMOKE_TOKEN; stty echo 2>/dev/null || true; echo
export EXCALIHARNESS_SMOKE_TOKEN
docker compose run --rm -T dev sh -c 'node esbuild.mjs && npx esbuild experiments/runner-smoke/smoke.ts --bundle --platform=node --outfile=dist/runner-smoke.js --log-level=warning "--external:@anthropic-ai/claude-agent-sdk-*" "--banner:js=const __import_meta_url = require(\"node:url\").pathToFileURL(__filename).href;" "--define:import.meta.url=__import_meta_url"' >/dev/null 2>&1
rm -rf "$w" && mkdir -p "$w" && cp -R experiments/runner-smoke/target "$w/repo"
(cd "$w/repo" && git init -q -b main && git -c user.name=smoke -c user.email=s@l add -A && git -c user.name=smoke -c user.email=s@l commit -q -m init)
echo "== Running T-001 (a few minutes the first time: images are built)"
docker run --rm -e EXCALIHARNESS_SMOKE_TOKEN -v /var/run/docker.sock:/var/run/docker.sock -v "$repo":"$repo" -w "$repo" excaliharness-runner-smoke \
  node dist/runner-smoke.js "$repo" "$w" node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384 > "$w/smoke.log" 2>&1 || true
sed -E 's/sk-ant-[A-Za-z0-9_-]+/[token]/g' "$w/smoke.log" > "$w/smoke.redacted.log" && rm "$w/smoke.log"
grep -E 'FINAL|ATTENTION|gate |round [0-9]|proxy refused|agent agents|TOKEN|leftover after|task containers after|^\* ' "$w/smoke.redacted.log" | grep -v leftover\ before
echo "== Commit on task/T-001 (expect hello.js)"
git -C "$w/repo" log --format='%an: %s' --stat main..task/T-001 2>/dev/null || echo "(no task branch)"
echo "== hello.js"
git -C "$w/repo" show task/T-001:hello.js 2>/dev/null || echo "(not committed)"
echo "Full log, token removed: $w/smoke.redacted.log"
