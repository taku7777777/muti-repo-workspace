#!/usr/bin/env bash
# Add a repository worktree to this task, pin the new origin's git redirect
# surface (denyWrite) in the worker sandbox, and notify the worker. Commits
# need no write grant on the origin .git (S8-d). Runs OUTSIDE the sandbox via
# excludedCommands — this is a privileged script; keep changes audited.
set -euo pipefail

REPO="${1:?usage: add-repository.sh <repo-name>}"
case "$REPO" in
  --*) echo "ERROR: unexpected flag; usage: add-repository.sh <repo-name>" >&2; exit 2 ;;
esac

# Self-locating: <TASK_DIR>/agents/orchestrator/.claude/skills/add-repository-to-worker/scripts/
SKILLS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_DIR="$(cd "$SKILLS_DIR/../../../.." && pwd)"
TICKET_ID="$(basename "$TASK_DIR")"

# tool_home holds scripts/ + config/. In the unified container it is
# TASK_DIR/../.. ; with an externalized state_root on the native path it is
# NOT (that is state_root), so prefer a hint baked in at task-creation time
# and fall back to the container-unified derivation.
BAKED_TOOL_HOME="{{WORKSPACE_ROOT}}"
if [ -f "$BAKED_TOOL_HOME/scripts/lib/common.sh" ]; then
  TOOL_HOME="$BAKED_TOOL_HOME"
else
  TOOL_HOME="$(cd "$TASK_DIR/../.." && pwd)"
fi

# shellcheck source=/dev/null
. "$TOOL_HOME/scripts/lib/common.sh"
# shellcheck source=/dev/null
. "$TOOL_HOME/scripts/lib/effects/worktree.sh"

PURPOSE="unknown"
TASK_META="$TASK_DIR/.task-meta.json"
WORKER_SETTINGS="$TASK_DIR/agents/worker/.claude/settings.json"
if [ -f "$TASK_META" ]; then
  # Permanent metadata written by /open-task finalize (review Low-8).
  PURPOSE="$(json_get "$TASK_META" '.purpose' 'unknown')"
elif [ -f "$WORKER_SETTINGS" ]; then
  # Legacy fallback (tasks created before .task-meta.json existed): scrape
  # the OTEL env var. Fragile — a template change degrades this to 'unknown',
  # which turns knowledge-repo sparse checkouts into full checkouts.
  PURPOSE="$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES // ""' "$WORKER_SETTINGS" | sed -n 's/.*purpose=\([^,]*\).*/\1/p')"
  [ -n "$PURPOSE" ] || PURPOSE="unknown"
fi

BRANCH_PREFIX="$(json_get "$TOOL_HOME/config/workspace.json" '.branch_prefix' 'feat/')"
BRANCH="${BRANCH_PREFIX}${TICKET_ID}"

[ -n "$(repo_field "$REPO" name)" ] || die "'$REPO' is not defined in config/repos.json"

info "Adding worktree for $REPO (branch $BRANCH)"
create_worktree "$REPO" "$TICKET_ID" "$BRANCH" "$PURPOSE"

# Record the repo in the permanent task metadata (kept in sync for
# /list-task and future add-repository purpose resolution).
if [ -f "$TASK_META" ]; then
  tmp="$(mktemp)"
  jq --arg r "$REPO" '.repos = ((.repos // []) + [$r] | unique)' "$TASK_META" > "$tmp"
  mv "$tmp" "$TASK_META"
fi

# Pin the redirect surface of the new origin in the worker settings. Commits
# need NO allowWrite on the origin .git (S8-d, Claude Code >= 2.1.149); what
# we add is denyWrite pins — .git/config, .git/hooks and the per-worktree
# config.worktree (the C-2 redirect vector). denyWrite beats every allow,
# including settings.local.json drift (S2-n). The authoritative guard remains
# push time (push-create-pr.sh forces -c core.hooksPath).
if [ -f "$WORKER_SETTINGS" ]; then
  GIT_DIR_PATH="$(state_root)/repositories/$REPO/.git"
  WT_PIN=""
  if WT_GITDIR="$(worktree_gitdir "$REPO" "$TICKET_ID")"; then
    WT_PIN="$WT_GITDIR/config.worktree"
  else
    warn "could not resolve worktree gitdir for $REPO — config.worktree pin skipped"
  fi
  # Only meaningful for sandboxed workers (no-sandbox settings have no
  # sandbox block; a jq += there would fabricate a meaningless one).
  if jq -e '.sandbox.filesystem' "$WORKER_SETTINGS" >/dev/null 2>&1; then
    # Add each pin independently and idempotently (unique). Guarding the whole
    # block on config's presence would strand the config.worktree pin if a
    # prior run resolved WT_PIN="" — leaving the C-2 redirect vector unpinned.
    pins=("$GIT_DIR_PATH/config" "$GIT_DIR_PATH/hooks")
    [ -n "$WT_PIN" ] && pins+=("$WT_PIN")
    for p in "${pins[@]}"; do
      tmp="$(mktemp)"
      jq --arg p "$p" \
        '.sandbox.filesystem.denyWrite = ((.sandbox.filesystem.denyWrite // []) + [$p] | unique)' \
        "$WORKER_SETTINGS" > "$tmp"
      mv "$tmp" "$WORKER_SETTINGS"
    done
    info "Pinned $GIT_DIR_PATH/{config,hooks}${WT_PIN:+ and $WT_PIN} as denyWrite in worker settings"
  fi
  # Origin read access is deliberately NOT granted via additionalDirectories:
  # the worker works in the worktree under the task dir, and adding the origin
  # would also widen the OS write boundary to the shared clone (S2-o). See the
  # matching note in create-workspace.sh generate_agent_settings.
fi

# Notify the worker. Tolerate a closed/dead cmux workspace (review Low-11):
# by this point the worktree and settings updates are already done and must
# not be rolled back by set -e — degrade to a manual-notification warning.
TARGET_FILE="$SKILLS_DIR/.worker-target"
notified=false
if [ -f "$TARGET_FILE" ] && command -v cmux >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$TARGET_FILE"
  export CMUX_QUIET=1
  if cmux send --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" \
       "Repository '$REPO' has been added to this task at ../../repositories/$REPO (branch $BRANCH). Include it in your work as needed." >/dev/null 2>&1 \
     && cmux send-key --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" enter >/dev/null 2>&1; then
    notified=true
    info "Worker notified via cmux"
  fi
fi
if ! $notified; then
  warn "cmux notification failed or unavailable — tell the worker manually about ../../repositories/$REPO"
fi

echo "DONE repo=$REPO branch=$BRANCH"
