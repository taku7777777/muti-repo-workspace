#!/usr/bin/env bash
# cmux-state.sh — derive the state of a Claude session running in a cmux
# surface. Installed to ~/.cmux-state.sh by setup-workspace.sh; internal
# dependency of ~/.cmux-wait.sh (not called directly by agents).
#
# Usage: cmux-state.sh <workspace-id> <surface-id>
# Output (stdout): running | idle | dead
#
# Heuristic:
#   dead    — the surface no longer exists / read-screen fails
#   running — the Claude Code TUI shows its in-progress indicator
#             ("esc to interrupt" / "ctrl+b to run in background")
#   idle    — anything else (prompt is waiting for input)
#
# This intentionally reads only the visible screen: it needs no hooks inside
# the observed session and works for any TUI state. If a future Claude Code
# version changes its indicator text, update RUNNING_PATTERN below.
set -euo pipefail

WS="${1:?usage: cmux-state.sh <workspace-id> <surface-id>}"
SURF="${2:?usage: cmux-state.sh <workspace-id> <surface-id>}"

export CMUX_QUIET=1

RUNNING_PATTERN='esc to interrupt|ctrl\+b to run in background|Compacting conversation'

screen="$(cmux read-screen --workspace "$WS" --surface "$SURF" --lines 40 2>/dev/null)" || {
  echo "dead"
  exit 0
}

if printf '%s' "$screen" | grep -qiE "$RUNNING_PATTERN"; then
  echo "running"
else
  echo "idle"
fi
