#!/usr/bin/env bash
# push-create-pr.sh — push a task worktree's branch and create a GitHub PR.
#
# This file is COPIED into tasks/<TICKET>/scripts/ by /open-task. There it is
# (a) executable by the task orchestrator via sandbox excludedCommands and
# (b) not writable by either agent (denyWrite) — it is the single, audited
# privilege escalation path for publishing work.
#
# Usage:
#   push-create-pr.sh <repo> --title "..." (--body "..." | --body-file <path>)
#                     [--base <branch>] [--draft]
set -euo pipefail

# Self-locating: this script lives at <TASK_DIR>/scripts/push-create-pr.sh.
TASK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE_ROOT="$(cd "$TASK_DIR/../.." && pwd)"

# This derivation assumes the task dir sits directly under the tool checkout
# (its `.githooks` lives here). In the container the whole tree is unified at
# /workspaces/muti-repo-workspace, so it holds; on the macOS path it holds when
# state_root == tool_home. If repositories/tasks were externalized to a
# state_root != tool_home, `$WORKSPACE_ROOT/.githooks` would be wrong and the
# forced hooksPath on the push below would silently skip the org/host guard.
# Fail CLOSED — never push without the audited pre-push hook present.
if [ ! -x "$WORKSPACE_ROOT/.githooks/pre-push" ]; then
  echo "ERROR: pre-push hook not found at $WORKSPACE_ROOT/.githooks/pre-push — refusing to push without the org/host guard (externalized state_root is not supported on this publish path yet)." >&2
  exit 1
fi

REPO="${1:?usage: push-create-pr.sh <repo> --title ... (--body ... | --body-file ...)}"
shift

# This script runs OUTSIDE the sandbox (orchestrator excludedCommands) with
# unrestricted network. REPO is interpolated into the worktree path below, so a
# value like '../../../other-repo' would point git at a repo outside the
# workspace where the pre-push hook does not apply. Constrain it to a bare name.
case "$REPO" in
  ""|-*)      echo "ERROR: repo must be a bare name (not a flag)" >&2; exit 2 ;;
  */*|*..*)   echo "ERROR: repo '$REPO' must be a bare directory name" >&2; exit 2 ;;
esac

TITLE=""
BODY=""
BODY_FILE=""
BASE=""
DRAFT=false
while [ $# -gt 0 ]; do
  case "$1" in
    --title) TITLE="${2:?--title needs a value}"; shift 2 ;;
    --body) BODY="${2:?--body needs a value}"; shift 2 ;;
    --body-file) BODY_FILE="${2:?--body-file needs a value}"; shift 2 ;;
    --base) BASE="${2:?--base needs a value}"; shift 2 ;;
    --draft) DRAFT=true; shift ;;
    *) echo "ERROR: unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "$TITLE" ] || { echo "ERROR: --title is required" >&2; exit 2; }
if [ -z "$BODY" ] && [ -z "$BODY_FILE" ]; then
  echo "ERROR: --body or --body-file is required" >&2; exit 2
fi

# --body-file is read by gh outside the sandbox, so an arbitrary path (e.g.
# ~/.aws/credentials) would leak into a public PR body. Confine it to the task.
if [ -n "$BODY_FILE" ]; then
  bf_dir="$(cd "$(dirname "$BODY_FILE")" 2>/dev/null && pwd)" \
    || { echo "ERROR: --body-file directory does not exist" >&2; exit 2; }
  bf_abs="$bf_dir/$(basename "$BODY_FILE")"
  case "$bf_abs" in
    "$TASK_DIR"/*) : ;;
    *) echo "ERROR: --body-file must be inside this task directory ($TASK_DIR)" >&2; exit 2 ;;
  esac
  BODY_FILE="$bf_abs"
fi

WT="$TASK_DIR/repositories/$REPO"
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || { echo "ERROR: no worktree for '$REPO' in this task" >&2; exit 1; }

BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: worktree is in detached HEAD state" >&2; exit 1
fi

# --porcelain (not diff --quiet) so untracked, never-added files also block —
# otherwise a new file the worker forgot to `git add` ships a PR silently
# missing it.
if [ -n "$(git -C "$WT" status --porcelain)" ]; then
  echo "ERROR: worktree has uncommitted or untracked changes — ask the worker to commit first." >&2
  exit 1
fi

echo "==> Pushing $REPO ($BRANCH)"
# Force the workspace pre-push hook on the command line so a per-worktree
# override (config.worktree core.hooksPath) cannot disable the org/host guard,
# and never pass --no-verify. This is the single audited publish path; the hook
# must run here regardless of what the worker may have written into .git.
git -C "$WT" -c core.hooksPath="$WORKSPACE_ROOT/.githooks" push -u origin "$BRANCH"

echo "==> Creating PR"
PR_ARGS=(--title "$TITLE" --head "$BRANCH")
if [ -n "$BODY_FILE" ]; then
  PR_ARGS+=(--body-file "$BODY_FILE")
else
  PR_ARGS+=(--body "$BODY")
fi
[ -n "$BASE" ] && PR_ARGS+=(--base "$BASE")
$DRAFT && PR_ARGS+=(--draft)

cd "$WT"
gh pr create "${PR_ARGS[@]}"
