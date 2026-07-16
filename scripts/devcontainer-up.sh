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

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

export COMPOSE_PROJECT_NAME="$(compose_project_name)"

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

# Point the compose state binds at the configured state_root (repositories/ +
# tasks/ + chat/). Unset ⇒ compose falls back to `..` (the tool checkout) =
# legacy — chat/ there is covered by the tracked chat/.gitkeep (.gitignore),
# same as tasks/repositories's own .gitkeep files.
_state_root="$(state_root)"
_ticket_registry="$(canonicalize_path "$_state_root/broker-tickets")"
reject_tasks_path "$_ticket_registry"
mkdir -p "$_ticket_registry"
if [ "$_state_root" != "$(workspace_root)" ]; then
  export MRW_STATE_ROOT="$_state_root"
  # chat/ (docs/mrw-chat.md Phase C3, scripts/chat-up.sh's render target)
  # MUST pre-exist here too: an externalized state_root has no tracked
  # chat/.gitkeep of its own, so without this the nested bind mount's source
  # would be missing at `docker compose up` time and Docker would auto-create
  # it itself — root-owned on native Linux hosts, which would then make
  # chat-up.sh's own (non-root) `mkdir -p "$CHAT_DIR/.claude"` fail EACCES.
  mkdir -p "$_state_root/tasks" "$_state_root/repositories" "$_state_root/chat"
fi

# Point the compose broker-policy bind at the active config_dir (workspace.json
# / repos.json / purposes/ / broker-policy.json). Unset ⇒ compose falls back
# to `../config` (the tool checkout) = legacy, byte-identical to Phase 1.
_config_dir="$(config_dir)"
_policy_file="$_config_dir/broker-policy.json"
[ -e "$_policy_file" ] || die "broker policy not found: $_policy_file"
[ -f "$_policy_file" ] || die "broker policy must be a regular file (not a directory): $_policy_file"
require_cmd jq
jq empty "$_policy_file" >/dev/null 2>&1 || die "invalid JSON in broker policy: $_policy_file"
if [ "$_config_dir" != "$(workspace_root)/config" ]; then
  case "$_config_dir" in
    /*) export MRW_CONFIG_DIR="$_config_dir" ;;
    *)  die "config_dir ('$_config_dir') must be an absolute path to be used as a container bind source (got a relative MRW_CONFIG_DIR?)" ;;
  esac
fi

# Idempotent: the `telemetry` network is `external: true` in the compose
# file (shared with the sibling claude-code-monitoring stack), so compose up
# fails outright if it doesn't exist yet — create it here, internal-only,
# same fail-closed shape as `caged` (docs/devcontainer-status.md item 10).
docker network create --internal mrw-telemetry 2>/dev/null || true
_telemetry_internal="$(docker network inspect -f '{{.Internal}}' mrw-telemetry 2>/dev/null || true)"
[ "$_telemetry_internal" = "true" ] \
  || die "mrw-telemetry network exists but is NOT internal (Internal='$_telemetry_internal') — refusing to start with a non-isolated telemetry network. Fix: docker network rm mrw-telemetry && docker network create --internal mrw-telemetry"

exec docker compose -f .devcontainer/docker-compose.yml up -d "$@"
