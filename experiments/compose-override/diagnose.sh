#!/bin/sh
# Tells a bad paste from a proxy problem, without printing the token. Run:
#   sh experiments/compose-override/diagnose.sh
set -eu
cd "$(dirname "$0")"
printf 'Paste the same token (input hidden): '
stty -echo; read -r TOKEN; stty echo; echo
echo "== Shape (the token itself is never printed)"
printf '%s' "$TOKEN" | awk '{
  printf "length: %d (a setup-token token is 108)\n", length($0);
  printf "starts with sk-ant-oat01-: %s\n", (index($0, "sk-ant-oat01-") == 1 ? "yes" : "NO");
  printf "spaces or tabs inside: %s\n", ($0 ~ /[ \t]/ ? "YES" : "no");
  printf "other characters than A-Z a-z 0-9 _ -: %s\n", ($0 ~ /[^A-Za-z0-9_-]/ ? "YES" : "no");
}'
printf 'line breaks: %s\n' "$(printf '%s' "$TOKEN" | tr -cd '\r\n' | wc -c | tr -d ' ')"
IMAGE=$(docker image inspect excaliharness-agent-base:83aa8d13b324 --format '{{.Id}}')
echo "== Direct, no proxy (same hardening as the sign-in check)"
CLAUDE_CODE_OAUTH_TOKEN="$TOKEN" docker run --rm -e CLAUDE_CODE_OAUTH_TOKEN --read-only \
  --tmpfs /home/node:uid=1000,gid=1000,mode=700 --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  --user 1000:1000 "$IMAGE" timeout 120 claude -p "Reply with exactly: ok" </dev/null 2>&1 | tail -2
