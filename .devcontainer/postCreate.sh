#!/usr/bin/env bash
# Runs INSIDE the caged orchestrator (see devcontainer.json's `service`), after
# create. cwd = workspaceFolder. The worker has no postCreate — its own `npm
# ci` + daemon start is baked into its compose `command` instead (see
# docker-compose.yml), since it has no dev-container attach step to hang a
# postCreate off of.
#   1. wire proxy-aware tools to the gateway (usability; topology enforces security)
#   2. prepare the container-local harness copy + deps (the workspace mount is
#      :ro — see scripts/prepare-harness-run.sh for why we copy instead of
#      layering a named volume over the bind). Idempotent if the orchestrator's
#      compose `command` already ran it.
#   3. prove the egress boundary AND the orchestrator/worker role boundaries —
#      fail the build if either is broken/open
set -euo pipefail

echo "[postCreate] wiring dev tools to the egress proxy"
if [ -n "${HTTP_PROXY:-}" ]; then
  # npm env-proxy support is inconsistent across versions; set config explicitly.
  npm config set proxy "$HTTP_PROXY"          || true
  npm config set https-proxy "${HTTPS_PROXY:-$HTTP_PROXY}" || true
  # git over HTTPS honors this (git over SSH would NOT — use HTTPS remotes).
  git config --global http.proxy "$HTTP_PROXY" || true
fi

echo "[postCreate] preparing the container-local harness copy"
bash scripts/prepare-harness-run.sh

echo "[postCreate] proving the egress + role boundaries"
ROLE=orchestrator bash scripts/egress-selfcheck-role.sh

echo "[postCreate] done — boundary verified."
