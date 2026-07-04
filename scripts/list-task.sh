#!/usr/bin/env bash
# list-task.sh — one line of status per task workspace under tasks/.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

WORKSPACE_ROOT="$(workspace_root)"
TASKS_DIR="$WORKSPACE_ROOT/tasks"

found=false
for task in "$TASKS_DIR"/*/; do
  [ -d "$task" ] || continue
  found=true
  ticket="$(basename "$task")"

  purpose="-"
  settings="$task/agents/worker/.claude/settings.json"
  if [ -f "$settings" ]; then
    purpose="$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES // ""' "$settings" \
      | sed -n 's/.*purpose=\([^,]*\).*/\1/p')"
    [ -n "$purpose" ] || purpose="-"
  fi

  repos=""
  for wt in "$task"repositories/*/; do
    [ -d "$wt" ] && repos="${repos:+$repos,}$(basename "$wt")"
  done

  status="-"
  latest="$(ls "$task"docs/handoff/*_worker.md 2>/dev/null | sort | tail -1 || true)"
  if [ -n "$latest" ]; then
    status="$(sed -n 's/^status:[[:space:]]*//p' "$latest" | head -1)"
    [ -n "$status" ] || status="-"
  fi

  incomplete=""
  [ -f "$task/.workspace-meta.json" ] && incomplete=" [SETUP INCOMPLETE]"

  printf '%-16s purpose=%-10s status=%-14s repos=%s%s\n' \
    "$ticket" "$purpose" "$status" "${repos:-none}" "$incomplete"
done

$found || echo "(no tasks)"
