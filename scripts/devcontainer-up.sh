#!/usr/bin/env bash
# Boot the devcontainer stack (coder + broker + egress-proxy) with Anthropic
# auth injected from the macOS Keychain via the shell environment.
#
# The credential is NEVER written into the worktree: docker-compose.yml uses
# null-value passthrough (`CLAUDE_CODE_OAUTH_TOKEN:`), so the token exists only
# in the Keychain and, transiently, in this process's environment.
#
# One-time setup (Pro/Max subscription):
#   claude setup-token   # mint a 1-year OAuth token (browser required, once)
#   security add-generic-password -a "$USER" -s claude-code-oauth-token -w '<token>'
#
# Alternatively export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY yourself
# before running this script — an already-set variable takes precedence.
#
# Extra args are forwarded to `docker compose up` (e.g. --build).
set -euo pipefail
cd "$(dirname "$0")/.."

KEYCHAIN_SERVICE="claude-code-oauth-token"

if [[ -z "${CLAUDE_CODE_OAUTH_TOKEN:-}" && -z "${ANTHROPIC_API_KEY:-}" ]]; then
  if token="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null)"; then
    export CLAUDE_CODE_OAUTH_TOKEN="$token"
  else
    echo "error: no Anthropic credential available." >&2
    echo "  Store one in the Keychain:" >&2
    echo "    security add-generic-password -a \"\$USER\" -s $KEYCHAIN_SERVICE -w '<token>'" >&2
    echo "  or export CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_API_KEY before running this script." >&2
    exit 1
  fi
fi

# Idempotent: the `telemetry` network is `external: true` in the compose
# file (shared with the sibling claude-code-monitoring stack), so compose up
# fails outright if it doesn't exist yet — create it here, internal-only,
# same fail-closed shape as `caged` (docs/devcontainer-status.md item 10).
docker network create --internal mrw-telemetry 2>/dev/null || true

exec docker compose -f .devcontainer/docker-compose.yml up -d "$@"
