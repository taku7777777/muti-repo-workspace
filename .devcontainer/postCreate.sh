#!/usr/bin/env bash
# Runs INSIDE the caged coder, after create. cwd = workspaceFolder.
#   1. wire proxy-aware tools to the gateway (usability; topology enforces security)
#   2. install harness deps (registry.npmjs.org is allowlisted)
#   3. prove the egress boundary — fail the build if it is broken/open
set -euo pipefail

echo "[postCreate] wiring dev tools to the egress proxy"
if [ -n "${HTTP_PROXY:-}" ]; then
  # npm env-proxy support is inconsistent across versions; set config explicitly.
  npm config set proxy "$HTTP_PROXY"          || true
  npm config set https-proxy "${HTTPS_PROXY:-$HTTP_PROXY}" || true
  # git over HTTPS honors this (git over SSH would NOT — use HTTPS remotes).
  git config --global http.proxy "$HTTP_PROXY" || true
fi

echo "[postCreate] installing harness dependencies"
if [ -f harness/package-lock.json ]; then
  ( cd harness && npm ci )
else
  ( cd harness && npm install )
fi

echo "[postCreate] proving the egress boundary"
bash scripts/egress-selfcheck.sh

echo "[postCreate] done — boundary verified."
