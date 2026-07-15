# Phase 2 broker image — the ONLY component that can push.
#
# Trust split: this container runs on the `egress` network (github access) and
# holds the short-lived GitHub token in ITS env; the coder never does. It talks to
# the coder ONLY through the shared unix socket (a Docker named volume).
#
# It shares the coder image's base (Node 20 + a non-root `node` user + git), and
# adds the GitHub CLI. EVERYTHING the broker executes is baked in at BUILD time —
# npm deps (zod, tsx, typescript), the policy, AND the TypeScript source. Nothing
# the runtime coder can write (the /workspaces tree, incl. broker/src on the host)
# influences broker execution; changing broker code requires an image rebuild,
# which is a trusted, human-initiated moment.
FROM mcr.microsoft.com/devcontainers/typescript-node:20

# --- GitHub CLI (for `gh pr create`) ---
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates gnupg git \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

ENV DISABLE_AUTOUPDATER=1

# --- Broker dependencies (build time) ---
WORKDIR /broker
COPY broker/package.json broker/package-lock.json ./
RUN npm ci

# --- Broker SOURCE, baked in at build (same reasoning as the policy below).
#     Previously bind-mounted :ro from ../broker/src — but that host path lives
#     inside the coder-writable workspace tree, so a prompt-injected coder could
#     tamper the source and have it execute (with the token) on the next broker
#     restart. Baking closes that restart-time supply path. ---
COPY broker/tsconfig.json ./tsconfig.json
COPY broker/src ./src

# --- TRUSTED policy, baked in at build (a trusted moment) so the RUNTIME coder
#     cannot alter it. Root-owned + world-read: the broker reads it, no one in the
#     container can rewrite it, and it lives OUTSIDE the coder-writable /workspaces
#     mount so the broker's F2 containment check accepts it. Override at runtime by
#     bind-mounting a host file (OUTSIDE the workspace) over this path. ---
RUN install -d -m 0755 /etc/mrw-broker
COPY config/broker-policy.json /etc/mrw-broker/policy.json
RUN chmod 0444 /etc/mrw-broker/policy.json

# The `node` user runs the broker and needs to write the tsx cache under /broker.
# The baked src is then stripped of write bits (read-only even inside the
# container); the baked policy in /etc stays root-owned.
RUN chown -R node:node /broker \
 && chmod -R a-w /broker/src /broker/tsconfig.json

# Socket dir must be node-owned BEFORE the fresh `broker-sock` named volume mounts
# over it: an empty named volume inherits the mountpoint's ownership, and Docker
# creates the mountpoint root:root 0755, so `node` binding the socket there would
# get EACCES and the broker would exit(1). Pre-creating it node-owned makes the
# fresh volume node-owned. (The coder side only needs traverse + the 0666 socket.)
#
# /var/mrw/review-diffs (M3) is the SAME lesson applied to the `review-diffs`
# named volume: the broker writes diff files here (rw) for the OPTIONAL
# advisory reviewer to read (ro, see reviewer.Dockerfile) — pre-created
# node-owned so the fresh volume mount doesn't leave it root:root 0755.
RUN install -d -o node -g node -m 0755 /run/broker /var/mrw/review-diffs

USER node
CMD ["npm", "start"]
