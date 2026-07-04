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

REPO="${1:?usage: push-create-pr.sh <repo> --title ... (--body ... | --body-file ...)}"
shift

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

WT="$TASK_DIR/repositories/$REPO"
[ -d "$WT/.git" ] || [ -f "$WT/.git" ] || { echo "ERROR: no worktree for '$REPO' in this task" >&2; exit 1; }

BRANCH="$(git -C "$WT" rev-parse --abbrev-ref HEAD)"
if [ "$BRANCH" = "HEAD" ]; then
  echo "ERROR: worktree is in detached HEAD state" >&2; exit 1
fi

if ! git -C "$WT" diff --quiet || ! git -C "$WT" diff --cached --quiet; then
  echo "ERROR: worktree has uncommitted changes — ask the worker to commit first." >&2
  exit 1
fi

echo "==> Pushing $REPO ($BRANCH)"
# The workspace pre-push hook (allowed_push_orgs) applies here.
git -C "$WT" push -u origin "$BRANCH"

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
