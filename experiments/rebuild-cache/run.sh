#!/bin/sh
# E-010. Run from this folder. Uses a scratch copy so the files stay clean.
set -u
w=$(mktemp -d)
cp Dockerfile compose.yaml offline.yaml "$w"/
cd "$w"
echo '{"name":"e010","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}' > package.json
echo 'console.log(require("left-pad")("a", 3))' > index.js
c() { docker compose -p excaliharness-e010 "$@"; }
step() { printf '\n== %s\n' "$1"; }
step "1. online build (fills the cache)"
c -f compose.yaml build --progress plain dev 2>&1 | grep -E 'npm install|CACHED|DONE|ERROR' | tail -6; echo "exit: $?"
step "2. offline, nothing changed"
c -f compose.yaml -f offline.yaml build --progress plain dev 2>&1 | grep -E 'npm install|CACHED|ERROR|exit code' | tail -6
echo "exit: $(c -f compose.yaml -f offline.yaml build -q dev >/dev/null 2>&1; echo $?)"
step "3. offline, source changed (index.js)"
echo 'console.log(require("left-pad")("b", 3))' > index.js
c -f compose.yaml -f offline.yaml build --progress plain dev 2>&1 | grep -E 'npm install|CACHED|ERROR|exit code|node index' | tail -8
echo "exit: $(c -f compose.yaml -f offline.yaml build -q dev >/dev/null 2>&1; echo $?)"
step "4. offline, dependency changed (package.json)"
echo '{"name":"e010","version":"1.0.0","dependencies":{"left-pad":"1.2.0"}}' > package.json
c -f compose.yaml -f offline.yaml build --progress plain dev 2>&1 | grep -E 'npm install|CACHED|ERROR|exit code|ENOTFOUND|EAI_AGAIN|network' | tail -8
echo "exit: $(c -f compose.yaml -f offline.yaml build -q dev >/dev/null 2>&1; echo $?)"
step "5. config: the offline override resolves to"
c -f compose.yaml -f offline.yaml config --format json | grep -o '"network": *"[^"]*"'
docker image rm excaliharness-e010-dev >/dev/null 2>&1
rm -rf "$w"
