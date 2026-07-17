#!/usr/bin/env bash
# verify-workspace.sh — smoke check for the tool_home / state_root split.
#
# Not a full test suite (see tests/run-tests.sh) — a quick sanity check to run
# after touching the state_root wiring (common.sh, host scripts, templates,
# compose). Prints resolved tool_home vs state_root and asserts:
#   1. the devcontainer compose file still parses.
#   2. render_template of task-orchestrator/claude-settings.json and CLAUDE.md
#      agree on TASK_DIR_H for the same sample task (byte-match spot check).
#
# Usage: scripts/verify-workspace.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
COMPOSE_PROJECT_NAME="$(compose_project_name)" || die "cannot resolve the compose project name (broken workspace config?)"
export COMPOSE_PROJECT_NAME

WORKSPACE_ROOT="$(workspace_root)"
STATE_ROOT="$(state_root)"
CONFIG_DIR="$(config_dir)"
CONFIG_MODE="$(config_mode)"

info "tool_home  = $WORKSPACE_ROOT"
info "state_root = $STATE_ROOT"
info "config_dir = $CONFIG_DIR ($CONFIG_MODE mode)"
info "compose project = $COMPOSE_PROJECT_NAME"
if [ "$STATE_ROOT" = "$WORKSPACE_ROOT" ]; then
  log "  (state_root unset in \$(config_dir)/workspace.json — legacy layout)"
fi

pass=true
check() { # <label> <command...>
  local label="$1"; shift
  if "$@" >/dev/null 2>&1; then
    log "  PASS: $label"
  else
    log "  FAIL: $label"
    pass=false
  fi
}

# --- 1. compose file parses -------------------------------------------------
if command -v docker >/dev/null 2>&1; then
  check "docker compose config parses" \
    bash -c "cd '$WORKSPACE_ROOT' && docker compose -f .devcontainer/docker-compose.yml config -q"
  check "mrw-telemetry network is internal" \
    bash -c "[ \"\$(docker network inspect -f '{{.Internal}}' mrw-telemetry 2>/dev/null)\" = true ]"
else
  warn "docker not found — skipping docker compose and telemetry-network checks"
fi

# --- 2. render_template TASK_DIR_H spot check -------------------------------
# A sample task under the CURRENT state_root — nothing is written to disk,
# render_template only reads templates and prints to stdout.
export WORKSPACE_ROOT STATE_ROOT
TASK_DIR="$STATE_ROOT/tasks/SMOKE-1"
TASK_DIR_H="$(to_home_path "$TASK_DIR")"
export TASK_DIR TASK_DIR_H
export TICKET_ID="SMOKE-1" PURPOSE="dev" BRANCH="feat/SMOKE-1" TITLE="" TICKET_URL="" REPOS_LIST=""

orch_settings="$(render_template "$WORKSPACE_ROOT/templates/task-orchestrator/claude-settings.json")"
orch_claude_md="$(render_template "$WORKSPACE_ROOT/templates/task-orchestrator/CLAUDE.md")"

if printf '%s' "$orch_settings" | grep -qF "$TASK_DIR_H" \
   && printf '%s' "$orch_claude_md" | grep -qF "$TASK_DIR_H"; then
  log "  PASS: rendered claude-settings.json + CLAUDE.md agree on TASK_DIR_H ($TASK_DIR_H)"
else
  log "  FAIL: rendered claude-settings.json + CLAUDE.md do not consistently contain TASK_DIR_H"
  pass=false
fi

log ""
if $pass; then
  info "verify-workspace: PASS"
else
  info "verify-workspace: FAIL"
  exit 1
fi
