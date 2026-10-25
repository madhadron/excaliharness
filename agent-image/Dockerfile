# Base agent image (D-024): runs the sign-in flow and infrastructure tasks, and
# is where derived images copy Claude Code from (D-064). Claude Code is the
# pinned native binary, checksum-verified (E-008).
FROM node:22-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

ARG TARGETARCH
ARG CLAUDE_CODE_VERSION=2.1.310
ARG CLAUDE_CODE_SHA256_AMD64=b73676430af12f97316a798b8371f81d640f90a58bdcb8f3ce56a835bb47df56
ARG CLAUDE_CODE_SHA256_ARM64=9c64d9a7442436b65fcd7cc02c1aa0051bb5a7041e7788576ed3b5f29c447d54

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates curl \
    # TARGETARCH is set only by BuildKit; the legacy builder leaves it empty.
    && arch="${TARGETARCH:-$(dpkg --print-architecture)}" \
    && case "$arch" in \
         amd64) platform=linux-x64; sum=$CLAUDE_CODE_SHA256_AMD64 ;; \
         arm64) platform=linux-arm64; sum=$CLAUDE_CODE_SHA256_ARM64 ;; \
         *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL -o /usr/local/bin/claude "https://downloads.claude.ai/claude-code-releases/${CLAUDE_CODE_VERSION}/${platform}/claude" \
    && echo "${sum}  /usr/local/bin/claude" | sha256sum -c - \
    && chmod 755 /usr/local/bin/claude \
    && apt-get purge -y curl && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    # Agents have no use for setuid/setgid programs (su, mount, passwd, ...).
    && find / -xdev -type f -perm /6000 -exec chmod a-s {} +

# The CLI version is pinned above; it must not replace itself at run time.
ENV DISABLE_AUTOUPDATER=1

# Agents run with HOME=/home/agent; a new session volume mounted at its
# .claude copies this ownership, so the CLI can save its session (D-079).
RUN mkdir -p /home/agent/.claude && chown -R 1000:1000 /home/agent

USER node
WORKDIR /home/node
