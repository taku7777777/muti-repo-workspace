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

  # Per-task parsing failures (corrupt/half-written meta) must not abort the
  # whole listing under set -e/pipefail — swallow jq errors and fall back to
  # "-" so every task still gets its line.
  purpose="-"
  if [ -f "$task/.task-meta.json" ]; then
    # Permanent metadata written by /open-task finalize (review Low-8).
    purpose="$(jq -r 'if (.purpose // "") == "" then "-" else .purpose end' "$task/.task-meta.json" 2>/dev/null || true)"
    [ -n "$purpose" ] || purpose="-"
  else
    # Legacy fallback (pre-.task-meta.json tasks): scrape the OTEL env var.
    settings="$task/agents/worker/.claude/settings.json"
    if [ -f "$settings" ]; then
      purpose="$(jq -r '.env.OTEL_RESOURCE_ATTRIBUTES // ""' "$settings" 2>/dev/null \
        | sed -n 's/.*purpose=\([^,]*\).*/\1/p' || true)"
      [ -n "$purpose" ] || purpose="-"
    fi
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
