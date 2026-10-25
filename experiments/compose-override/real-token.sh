#!/bin/sh
# E-005/E-006 with a real token. Run from the repository root:
#   sh experiments/compose-override/real-token.sh
# It asks for a token (input hidden), gives it only to the proxy container,
# prints results but never the token, and removes everything afterwards.
set -eu
cd "$(dirname "$0")"
printf 'Paste a Claude OAuth token (input hidden): '
stty -echo; read -r PROXY_TOKEN; stty echo; echo
export PROXY_TOKEN
c() { docker compose -p excaliharness-e005r -f compose.yaml -f override.yaml "$@"; }
trap 'c down -v >/dev/null 2>&1 || true' EXIT
c up -d excaliharness-egress-proxy >/dev/null 2>&1
sleep 2
echo "== E-005: the CLI through the proxy (expect: ok)"
c run --rm -T dev timeout 120 claude -p "Reply with exactly: ok" </dev/null 2>&1 | grep -v -E 'Creat|Start|Container' | tail -3
echo "== E-006: the SDK driving the CLI in the container (expect: TOOL finish called, then done)"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock -v "$PWD":"$PWD" -v "$PWD/runner/run.mjs":/runner/run.mjs:ro -w "$PWD" \
  excaliharness-e006-runner node /runner/run.mjs "$PWD" 2>&1 | grep -E 'TOOL|result:|threw' | sed -E 's/sk-ant-[A-Za-z0-9_-]+/[token]/g'
echo "== Proxy log (status codes only)"
c logs --no-log-prefix excaliharness-egress-proxy 2>&1 | grep -E '^<-' | sort | uniq -c
