# Thread B browser-approval image — the `serve` service (docker-compose.yml,
# profile-gated: `mrw serve up`). `mrw serve` renders the GitHub-PR-style
# approval page and relays a typed short-sha decision to the broker over the
# `approve-sock` named volume (see the `broker` and `serve` service comments
# in docker-compose.yml, and docs/browser-approval.md's trust model). It is
# TOKEN-LESS in the GitHub sense: it never sees BROKER_GITHUB_TOKEN and
# cannot push — the broker never trusts what this container says and
# re-verifies every submitted sha IN-PROCESS against the actual pending
# publish before anything is pushed.
#
# NO git/gh CREDENTIALS, repos, or remotes in this container (the base image
# does ship a git binary — irrelevant here): this process renders a page and
# relays a couple of small JSON ops over a unix socket — it has no repo to
# read, nothing to clone, and nothing to authenticate to a git host as, so
# "cannot push" rests on the absence of secrets and mounts, not of binaries.
#
# Same supply-chain reasoning as broker.Dockerfile / reviewer.Dockerfile:
# EVERYTHING this process executes is baked in at BUILD time — npm deps
# (zod only, see serve/package.json) AND the TypeScript source. Nothing the
# runtime broker/coder can write (the /workspaces tree, incl. serve/src on
# the host) influences serve execution; changing serve code requires an
# image rebuild, a trusted, human-initiated moment. The ONLY runtime-mutable
# input is the read-only SERVE_CONFIG_DIR bind (serve.json / serve.css — see
# docker-compose.yml's `serve` service volumes:), which is inert cosmetic/
# behavior data, never code (config/serve.json documents every field).
FROM mcr.microsoft.com/devcontainers/typescript-node:20

ENV DISABLE_AUTOUPDATER=1

# --- serve dependencies (build time) ---
WORKDIR /serve
COPY serve/package.json serve/package-lock.json ./
RUN npm ci

# --- serve SOURCE, baked in at build (same reasoning as reviewer.Dockerfile:
#     the host path lives inside the coder-writable workspace tree, so
#     bind-mounting it — even :ro — would let a tampered source execute on
#     the next serve restart). ---
COPY serve/tsconfig.json ./tsconfig.json
COPY serve/src ./src

# The `node` user runs serve and needs to write the tsx cache under /serve.
# The baked src is then stripped of write bits (read-only even inside the
# container).
RUN chown -R node:node /serve \
 && chmod -R a-w /serve/src /serve/tsconfig.json

# `/run/approve` (the approve-sock mountpoint) — unlike broker, serve only
# ever DIALS OUT on this socket (net.connect); it never binds/listens (the
# broker owns the listening end, see broker/src/approval-server.ts and this
# image's own service comment in docker-compose.yml), so this directory
# does not strictly need to be node-owned for serve's own use — a 0755 dir
# grants traverse to any uid, and the socket file itself is chmod 0666 by
# the broker that creates it. Pre-created node-owned here anyway, purely
# defensively, for the SAME reason reviewer.Dockerfile pre-creates its
# read-only `review-diffs` mount: whichever image's container mounts a
# fresh named volume FIRST determines its initial ownership, and leaving
# this root:root 0755 costs nothing to avoid.
RUN install -d -o node -g node -m 0755 /run/approve

USER node
CMD ["npm", "start"]
