# Base agent image (D-024): runs the sign-in flow and infrastructure tasks.
# Promoted from experiments/setup-token (E-001).
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ARG CLAUDE_CODE_VERSION=2.1.310
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
    # Agents have no use for setuid/setgid programs (su, mount, passwd, ...).
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

# The CLI version is pinned above; it must not replace itself at run time.
ENV DISABLE_AUTOUPDATER=1

USER node
WORKDIR /home/node
