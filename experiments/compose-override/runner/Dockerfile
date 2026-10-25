# Throwaway (E-006): stands in for the worker on the host — Node, the Agent SDK,
# and the Docker CLI with Compose.
FROM docker:29-cli AS docker
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d
COPY --from=docker /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /runner
RUN npm init -y >/dev/null && npm install @anthropic-ai/claude-agent-sdk@0.3.310 zod >/dev/null 2>&1
