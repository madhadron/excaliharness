# Prototype of the base agent image: Claude Code, git, and `script` (util-linux,
# already in node:22-slim) for the in-container pseudo-terminal variant.
FROM node:22-slim

ARG CLAUDE_CODE_VERSION=2.1.310
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

USER node
WORKDIR /home/node
