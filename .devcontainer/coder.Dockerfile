# M1 coder image — now shared by BOTH the `worker` and `orchestrator` compose
# services (see docker-compose.yml). The two services diverge entirely at the
# compose layer (mounts, env, command); the image itself stays one build so the
# egress-proxy wiring, CLI install, and OS tooling below are identical in both
# cages and there is only one Dockerfile to keep in sync.
#
# Base ships Node 20 + a non-root `node` user (required: the CLI refuses
# --dangerously-skip-permissions / bypassPermissions as root). All package
# fetching happens HERE, at build time, on the default build network (which has
# internet). At RUNTIME both services are on internal-only networks, so anything
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

# Socket/notes mountpoints must be node-owned BEFORE the fresh named volumes
# mount over them: an empty named volume inherits the mountpoint's ownership,
# and Docker creates the mountpoint root:root 0755, so `node` binding a socket
# (worker's workerd.sock) or writing notes (orchestrator's MRW_STATE_DIR) there
# would get EACCES and the service would exit(1). Pre-creating both node-owned
# makes the fresh volumes node-owned (same EACCES lesson as broker.Dockerfile's
# /run/broker; one RUN covers both services since they share this image).
RUN install -d -o node -g node -m 0755 /run/worker /var/mrw/notes

USER node
