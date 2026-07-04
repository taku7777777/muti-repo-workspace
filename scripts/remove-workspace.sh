#!/usr/bin/env bash
# remove-workspace.sh — tear down a task workspace (/close-task backend).
#
# Refuses to delete work that is not pushed unless --force:
#   - uncommitted changes in any worktree
#   - commits not pushed to the upstream branch
# Worktrees are detached properly (git worktree remove + prune); local
# branches are kept (they are cheap and may hold pushed history).
#
# Usage: remove-workspace.sh <TICKET_ID> [--force]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/effects/worktree.sh
. "$SCRIPT_DIR/lib/effects/worktree.sh"
# shellcheck source=lib/effects/cmux.sh
. "$SCRIPT_DIR/lib/effects/cmux.sh"

TICKET_ID="${1:?usage: remove-workspace.sh <TICKET_ID> [--force]}"
FORCE=false
[ "${2:-}" = "--force" ] && FORCE=true

WORKSPACE_ROOT="$(workspace_root)"
TASK_DIR="$WORKSPACE_ROOT/tasks/$TICKET_ID"
[ -d "$TASK_DIR" ] || die "no such task: $TICKET_ID"

# --- safety checks -----------------------------------------------------------
blockers=""
for wt in "$TASK_DIR/repositories"/*/; do
  [ -d "$wt" ] || continue
  repo="$(basename "$wt")"
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    blockers="$blockers
  - $repo: uncommitted changes"
  fi
  upstream="$(git -C "$wt" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}' 2>/dev/null || true)"
  if [ -z "$upstream" ]; then
    if [ -n "$(git -C "$wt" log --oneline -1 2>/dev/null)" ] \
       && [ -n "$(git -C "$wt" log --oneline "$(git -C "$wt" rev-parse --abbrev-ref HEAD)" --not --remotes 2>/dev/null | head -1)" ]; then
      blockers="$blockers
  - $repo: branch was never pushed (local-only commits)"
    fi
  else
    ahead="$(git -C "$wt" rev-list --count "$upstream..HEAD" 2>/dev/null || echo 0)"
    [ "$ahead" -gt 0 ] && blockers="$blockers
  - $repo: $ahead commit(s) not pushed to $upstream"
  fi
done

if [ -n "$blockers" ] && ! $FORCE; then
  die "refusing to remove $TICKET_ID — unpushed work:$blockers

push first (create-pr) or re-run with --force to discard."
fi

# --- teardown ----------------------------------------------------------------
info "Removing worktrees for $TICKET_ID"
remove_worktrees "$TICKET_ID"

if cmux_available; then
  # Exact-title match (shared helper) so closing ABC-1 never tears down ABC-12.
  ws_uuid="$(cmux_workspace_uuid_by_name "$TICKET_ID")"
  if [ -n "$ws_uuid" ]; then
    info "Closing cmux workspace $TICKET_ID"
    cmux close-workspace --workspace "$ws_uuid" >/dev/null 2>&1 \
      || warn "could not close cmux workspace (close it manually)"
  fi
fi

info "Deleting $TASK_DIR"
rm -rf "$TASK_DIR"
info "Task $TICKET_ID removed. (Local branches were kept; delete with: git -C repositories/<repo> branch -D <branch>)"
