# Dev container for building and testing the extension. VS Code integration
# tests run headless under xvfb, so this includes the libraries Electron needs.
FROM node:22-bookworm@sha256:63538dfe497cc29dfafdda25ada09b46db68a3f4cc205abf1f5d6bf0913f3384

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        xvfb xauth \
        libasound2 libatk-bridge2.0-0 libatk1.0-0 libdrm2 libgbm1 libgtk-3-0 \
        libnss3 libsecret-1-0 libxkbfile1 libxss1 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Mount points for the named volumes in docker-compose.yml, created here so
# the volumes start out owned by the unprivileged user.
RUN mkdir -p /workspace/node_modules /workspace/.vscode-test \
    && chown -R node:node /workspace

USER node
WORKDIR /workspace
