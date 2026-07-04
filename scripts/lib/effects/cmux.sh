#!/usr/bin/env bash
# cmux side-effect helpers used by create-workspace.sh and lifecycle scripts.
# All functions echo IDs (UUIDs) on stdout and log to stderr.
#
# Verified against the cmux Unix-socket CLI (2026-07): new-workspace prints
# "OK workspace:N" (short ref only), so workspace UUIDs are resolved via
# `cmux workspace list --id-format both`; new-surface prints
# "OK surface:N (UUID) pane:N (UUID) workspace:N (UUID)".

export CMUX_QUIET=1

cmux_available() {
  command -v cmux >/dev/null 2>&1 && [ "$(cmux ping 2>/dev/null)" = "PONG" ]
}

# cmux_workspace_uuid_by_name <name> — newest workspace whose title matches.
cmux_workspace_uuid_by_name() {
  cmux workspace list --id-format both 2>/dev/null \
    | grep -F -- "$1" | tail -1 | sed 's/^[* ]*//' | awk '{print $2}'
}

# cmux_new_workspace <name> <cwd> <command> — echoes the workspace UUID.
cmux_new_workspace() {
  local name="$1" cwd="$2" command="$3" uuid
  cmux new-workspace --name "$name" --cwd "$cwd" --command "$command" \
    --focus false >/dev/null
  uuid="$(cmux_workspace_uuid_by_name "$name")"
  [ -n "$uuid" ] || return 1
  printf '%s' "$uuid"
}

# cmux_first_surface_uuid <workspace-uuid>
cmux_first_surface_uuid() {
  cmux list-pane-surfaces --workspace "$1" --id-format both 2>/dev/null \
    | head -1 | sed 's/^[* ]*//' | awk '{print $2}'
}

# cmux_new_tab <workspace-uuid> <title> — new terminal surface; echoes its UUID.
cmux_new_tab() {
  local ws="$1" title="$2" out uuid
  out="$(cmux new-surface --type terminal --workspace "$ws" --focus false --id-format both)"
  # "OK surface:N (UUID) pane:N (UUID) workspace:N (UUID)" — first parenthesized token.
  uuid="$(printf '%s' "$out" | sed -n 's/^OK surface:[0-9]* (\([A-F0-9-]*\)).*/\1/p')"
  [ -n "$uuid" ] || return 1
  cmux rename-tab --workspace "$ws" --surface "$uuid" "$title" >/dev/null
  printf '%s' "$uuid"
}

cmux_rename_tab() { # <workspace-uuid> <surface-uuid> <title>
  cmux rename-tab --workspace "$1" --surface "$2" "$3" >/dev/null
}

# cmux_send_line <workspace-uuid> <surface-uuid> <text>
# Sends text then a separate enter key — text alone is NOT submitted.
cmux_send_line() {
  cmux send --workspace "$1" --surface "$2" "$3" >/dev/null
  cmux send-key --workspace "$1" --surface "$2" enter >/dev/null
}

# cmux_read <workspace-uuid> <surface-uuid> <lines>
cmux_read() {
  cmux read-screen --workspace "$1" --surface "$2" --lines "$3" 2>/dev/null
}
