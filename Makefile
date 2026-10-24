# Every target runs inside the dev container (docker-compose.yml), except
# agent-image, which is a plain `docker build`. Nothing is installed on the host.

RUN = docker compose run --rm dev sh -c

# Targets share one node_modules volume, so they must not run concurrently.
.NOTPARALLEL:
.PHONY: check deps lock typecheck lint test-unit test-vscode agent-image build package shell

check: typecheck lint test-unit test-vscode agent-image

# Installs exactly what package-lock.json says, without running dependency
# install scripts; skipped when the volume already matches the lockfile.
deps:
	$(RUN) '[ node_modules/.deps-stamp -nt package-lock.json ] || { npm ci --ignore-scripts --no-audit --no-fund --loglevel=error && touch node_modules/.deps-stamp; }'

# Updates package-lock.json after editing package.json; review the diff.
lock:
	docker compose run --rm lock npm install --package-lock-only --ignore-scripts --no-audit --no-fund

typecheck: deps
	$(RUN) 'npm run typecheck'

lint: deps
	$(RUN) 'npm run lint'

test-unit: deps
	$(RUN) 'npm run test:unit'

test-vscode: deps
	$(RUN) 'npm run test:vscode'

agent-image:
	docker build -t excaliharness-agent-base:dev agent-image

build: deps
	$(RUN) 'npm run build'

package: deps
	$(RUN) 'npm run package'

shell:
	docker compose run --rm dev bash
