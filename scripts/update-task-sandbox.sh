#!/usr/bin/env bash
# update-task-sandbox.sh — widen a task worker's sandbox from OUTSIDE the task.
#
# A task can never widen its own sandbox (agents/** is denyWrite for both
# agents) — this script is the audited path, run from the root console.
# The worker session must be restarted for settings changes to apply.
#
# Usage:
#   update-task-sandbox.sh <TICKET_ID> --show
#   update-task-sandbox.sh <TICKET_ID> --add-domain <domain>       # allow network domain
#   update-task-sandbox.sh <TICKET_ID> --add-allow "Bash(...)"     # permissions.allow rule
#   update-task-sandbox.sh <TICKET_ID> --add-ask "Bash(...)"       # permissions.ask rule
#   update-task-sandbox.sh <TICKET_ID> --add-write <abs-path>      # sandbox write scope
#   update-task-sandbox.sh <TICKET_ID> --add-git-access            # git fetch config + SSH agent reads
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
require_cmd jq

TICKET_ID="${1:?usage: update-task-sandbox.sh <TICKET_ID> <action> [value]}"
ACTION="${2:?missing action (--show / --add-domain / --add-allow / --add-ask / --add-write / --add-git-access)}"
VALUE="${3:-}"

# Ticket id is interpolated into the settings path below — validate so this
# "audited escalation" path cannot be pointed at a file outside tasks/.
validate_ticket_id "$TICKET_ID"

WORKSPACE_ROOT="$(workspace_root)"
SETTINGS="$WORKSPACE_ROOT/tasks/$TICKET_ID/agents/worker/.claude/settings.json"
[ -f "$SETTINGS" ] || die "no worker settings for task $TICKET_ID"

apply() { # <jq-program> [--arg k v ...]
  local prog="$1"; shift
  local tmp
  tmp="$(mktemp)"
  jq "$@" "$prog" "$SETTINGS" > "$tmp"
  mv "$tmp" "$SETTINGS"
}

case "$ACTION" in
  --show)
    jq '{env, permissions: {allow: .permissions.allow, ask: .permissions.ask, deny: .permissions.deny},
         sandbox: {network: .sandbox.network, filesystem: .sandbox.filesystem,
                   excludedCommands: .sandbox.excludedCommands}}' "$SETTINGS"
    exit 0
    ;;
  --add-domain)
    [ -n "$VALUE" ] || die "--add-domain needs a domain"
    apply '.sandbox.network.allowedDomains = ((.sandbox.network.allowedDomains // []) + [$v] | unique)' --arg v "$VALUE"
    info "added network domain: $VALUE"
    ;;
  --add-allow)
    [ -n "$VALUE" ] || die "--add-allow needs a rule"
    apply '.permissions.allow = ((.permissions.allow // []) + [$v] | unique)' --arg v "$VALUE"
    info "added allow rule: $VALUE"
    ;;
  --add-ask)
    [ -n "$VALUE" ] || die "--add-ask needs a rule"
    apply '.permissions.ask = ((.permissions.ask // []) + [$v] | unique)' --arg v "$VALUE"
    info "added ask rule: $VALUE"
    ;;
  --add-write)
    [ -n "$VALUE" ] || die "--add-write needs an absolute path"
    case "$VALUE" in /*) : ;; *) die "--add-write path must be absolute" ;; esac
    apply '.sandbox.filesystem.allowWrite = ((.sandbox.filesystem.allowWrite // []) + [$v] | unique)' --arg v "$VALUE"
    info "added write scope: $VALUE"
    ;;
  --add-git-access)
    # Lets the sandboxed worker run git fetch/pull against remotes: read
    # access to git/ssh config plus the SSH agent socket. Push stays gated
    # through the orchestrator's push-create-pr.sh.
    if [ -z "${SSH_AUTH_SOCK:-}" ]; then
      die "--add-git-access needs a running ssh-agent (SSH_AUTH_SOCK is unset); start one and retry"
    fi
    apply '.sandbox.network.allowedDomains = ((.sandbox.network.allowedDomains // []) + ["github.com"] | unique)
         | .sandbox.network.allowUnixSockets = ((.sandbox.network.allowUnixSockets // []) + [$sock] | unique)
         | .permissions.allow = ((.permissions.allow // []) + ["Read(~/.gitconfig)"] | unique)
         | .permissions.ask = ((.permissions.ask // []) + ["Bash(git push*)"] | unique)' \
      --arg sock "$SSH_AUTH_SOCK"
    info "added git fetch access (github.com + SSH agent socket)"
    warn "this also makes the worker network-capable of reaching github.com, so"
    warn "'git push' is no longer physically blocked — it is only gated by an ask"
    warn "rule (bypassable in principle, e.g. 'git push --no-verify' skips the"
    warn "pre-push org/host hook). This weakens the orchestrator-only publish"
    warn "boundary from OS-enforced to advisory. Prefer leaving push to the"
    warn "orchestrator; grant this only when the worker genuinely needs to fetch."
    ;;
  *)
    die "unknown action: $ACTION"
    ;;
esac

log ""
log "Restart the worker Claude session in task $TICKET_ID for changes to apply."
