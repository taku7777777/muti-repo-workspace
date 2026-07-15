# Phase 0 coder image.
#
# Base ships Node 20 + a non-root `node` user (required: the CLI refuses
# --dangerously-skip-permissions / bypassPermissions as root). All package
# fetching happens HERE, at build time, on the default build network (which has
# internet). At RUNTIME the coder is on the internal-only network, so anything
# not baked in must come through the allowlisting proxy.
FROM mcr.microsoft.com/devcontainers/typescript-node:20

# --- OS tools: jq + gh (git & curl are already in the base) ---
RUN apt-get update \
 && apt-get install -y --no-install-recommends jq curl ca-certificates gnupg \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# --- Claude Code CLI (optional for the SDK pipeline; handy for interactive use).
# The SDK's query() also spawns this bundled CLI under the hood. Pinning the
# updater OFF keeps a locked build from reaching a not-yet-allowlisted host.
ENV DISABLE_AUTOUPDATER=1
RUN npm install -g @anthropic-ai/claude-code || true

# Harness npm dependencies are installed in postCreate (registry.npmjs.org is
# allowlisted), because the repo — including harness/ — is bind-mounted at
# runtime and would shadow anything COPYed to that path at build time.

USER node
