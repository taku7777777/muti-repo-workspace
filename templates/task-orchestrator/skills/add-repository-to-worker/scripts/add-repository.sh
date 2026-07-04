#!/usr/bin/env bash
# Add a repository worktree to this task, grant the worker commit access to
# the new origin .git, and notify the worker. Runs OUTSIDE the sandbox via
# excludedCommands — this is a privileged script; keep changes audited.
set -euo pipefail

REPO="${1:?usage: add-repository.sh <repo-name>}"
case "$REPO" in
  --*) echo "ERROR: unexpected flag; usage: add-repository.sh <repo-name>" >&2; exit 2 ;;
esac

# Self-locating: <TASK_DIR>/agents/orchestrator/.claude/skills/add-repository-to-worker/scripts/
SKILLS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TASK_DIR="$(cd "$SKILLS_DIR/../../../.." && pwd)"
WORKSPACE_ROOT="$(cd "$TASK_DIR/../.." && pwd)"
TICKET_ID="$(basename "$TASK_DIR")"

# shellcheck source=/dev/null
. "$WORKSPACE_ROOT/scripts/lib/common.sh"
# shellcheck source=/dev/null
. "$WORKSPACE_ROOT/scripts/lib/effects/worktree.sh"

PURPOSE="unknown"
WORKER_SETTINGS="$TASK_DIR/agents/worker/.claude/settings.json"
if [ -f "$WORKER_SETTINGS" ]; then
  PURPOSE="$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES // ""' "$WORKER_SETTINGS" | sed -n 's/.*purpose=\([^,]*\).*/\1/p')"
  [ -n "$PURPOSE" ] || PURPOSE="unknown"
fi

BRANCH_PREFIX="$(json_get "$WORKSPACE_ROOT/config/workspace.json" '.branch_prefix' 'feat/')"
BRANCH="${BRANCH_PREFIX}${TICKET_ID}"

[ -n "$(repo_field "$REPO" name)" ] || die "'$REPO' is not defined in config/repos.json"

info "Adding worktree for $REPO (branch $BRANCH)"
create_worktree "$REPO" "$TICKET_ID" "$BRANCH" "$PURPOSE"

# Grant the worker commit access: worktree commits write into the origin
# repo's .git directory.
if [ -f "$WORKER_SETTINGS" ]; then
  GIT_DIR_PATH="$WORKSPACE_ROOT/repositories/$REPO/.git"
  if ! jq -e --arg p "$GIT_DIR_PATH" '.sandbox.filesystem.allowWrite | index($p)' "$WORKER_SETTINGS" >/dev/null; then
    tmp="$(mktemp)"
    # Grant commit access but keep .git/config and .git/hooks read-only (denyWrite
    # wins) so the worker can't disable the pre-push guard or redirect the remote.
    jq --arg p "$GIT_DIR_PATH" \
      '.sandbox.filesystem.allowWrite += [$p]
       | .sandbox.filesystem.denyWrite += [($p + "/config"), ($p + "/hooks")]' \
      "$WORKER_SETTINGS" > "$tmp"
    mv "$tmp" "$WORKER_SETTINGS"
    info "Injected commit access ($GIT_DIR_PATH) into worker settings"
  fi
fi

# Notify the worker.
TARGET_FILE="$SKILLS_DIR/.worker-target"
if [ -f "$TARGET_FILE" ] && command -v cmux >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$TARGET_FILE"
  export CMUX_QUIET=1
  cmux send --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" \
    "Repository '$REPO' has been added to this task at ../../repositories/$REPO (branch $BRANCH). Include it in your work as needed." >/dev/null
  cmux send-key --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" enter >/dev/null
  info "Worker notified via cmux"
else
  warn "cmux/.worker-target unavailable — tell the worker manually about ../../repositories/$REPO"
fi

echo "DONE repo=$REPO branch=$BRANCH"
