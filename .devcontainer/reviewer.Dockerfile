# M3 advisory reviewer image — an OPTIONAL, ADVISORY-ONLY consult the broker
# may make before the sha-typed human gate (see broker/src/reviewer.ts,
# broker/src/approve.ts, and docs/agent-orchestration.md's "Broker-side
# reviewer" section). This container never pushes, never mutates a worktree,
# and is never depended-on by the broker's healthcheck (see
# docker-compose.yml's `broker` service comment) — if it is down, slow, or
# malformed, the broker renders "no verdict" and publishing proceeds exactly
# as if this image did not exist.
#
# NO gh, NO git in this image, unlike broker.Dockerfile / coder.Dockerfile.
# This process reads a diff FILE (or a small inline payload) the broker
# already rendered from git objects, and calls the LLM once — it has no repo
# to read, nothing to clone, and nothing to authenticate to a git host as.
#
# Same supply-chain reasoning as broker.Dockerfile: EVERYTHING this process
# executes is baked in at BUILD time — npm deps AND the TypeScript source.
# Nothing the runtime broker/coder can write (the /workspaces tree) influences
# reviewer execution; changing reviewer code requires an image rebuild, a
# trusted, human-initiated moment.
FROM mcr.microsoft.com/devcontainers/typescript-node:20

ENV DISABLE_AUTOUPDATER=1

# --- Reviewer dependencies (build time) ---
WORKDIR /reviewer
COPY reviewer/package.json reviewer/package-lock.json ./
RUN npm ci

# --- Reviewer SOURCE, baked in at build (same reasoning as broker.Dockerfile:
#     the host path lives inside the coder-writable workspace tree, so
#     bind-mounting it — even :ro — would let a tampered source execute on
#     the next reviewer restart). ---
COPY reviewer/tsconfig.json ./tsconfig.json
COPY reviewer/src ./src

# The `node` user runs the reviewer and needs to write the tsx cache under
# /reviewer. The baked src is then stripped of write bits (read-only even
# inside the container).
RUN chown -R node:node /reviewer \
 && chmod -R a-w /reviewer/src /reviewer/tsconfig.json

# Socket dir (shared with the broker via the `reviewer-sock` named volume)
# and the diff-file mountpoint (`review-diffs`, mounted :ro here — the
# broker owns writes) must be node-owned BEFORE the fresh named volumes
# mount over them: an empty named volume inherits the mountpoint's
# ownership, and Docker creates the mountpoint root:root 0755, so `node`
# binding the socket / reading the mount would get EACCES and the process
# would exit(1). Pre-creating both node-owned makes the fresh volumes
# node-owned (same EACCES lesson as broker.Dockerfile's /run/broker).
RUN install -d -o node -g node -m 0755 /run/reviewer /var/mrw/review-diffs

USER node
CMD ["npm", "start"]
