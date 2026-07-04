#!/usr/bin/env bash
# cmux-wait.sh — block until the Claude session in a cmux surface settles
# (running → idle) or dies, then print a single RESULT line plus the tail of
# the pane. Installed to ~/.cmux-wait.sh by setup-workspace.sh.
#
# Usage: cmux-wait.sh <workspace-id> <surface-id> [timeout-seconds]
#
# Output (last lines of stdout):
#   RESULT status=<idle|dead|timeout> surface=<surface-id> elapsed=<seconds>
#   --- pane tail ---
#   <last 40 lines of the worker pane>
#
# Designed to be launched with run_in_background from an orchestrator Claude:
# arm it right after sending an instruction, end the turn, and receive one
# notification when the worker settles — no manual polling loops.
#
# Debounce: the worker is only considered settled after IDLE_CONFIRMS
# consecutive idle reads, and only once we have either seen it running at
# least once or GRACE seconds have passed (covers instructions that finish
# faster than our first poll).
set -euo pipefail

WS="${1:?usage: cmux-wait.sh <workspace-id> <surface-id> [timeout-sec]}"
SURF="${2:?usage: cmux-wait.sh <workspace-id> <surface-id> [timeout-sec]}"
TIMEOUT="${3:-1800}"

STATE_SCRIPT="${CMUX_STATE_SCRIPT:-$HOME/.cmux-state.sh}"
POLL_INTERVAL="${CMUX_WAIT_POLL:-5}"
IDLE_CONFIRMS="${CMUX_WAIT_IDLE_CONFIRMS:-2}"
GRACE="${CMUX_WAIT_GRACE:-20}"

[ -x "$STATE_SCRIPT" ] || { echo "RESULT status=error surface=$SURF elapsed=0 reason=missing-$STATE_SCRIPT"; exit 1; }

start="$(date +%s)"
seen_running=false
idle_streak=0
dead_streak=0
status="timeout"
DEAD_CONFIRMS="${CMUX_WAIT_DEAD_CONFIRMS:-2}"

while :; do
  now="$(date +%s)"
  elapsed=$((now - start))
  if [ "$elapsed" -ge "$TIMEOUT" ]; then
    status="timeout"
    break
  fi

  state="$("$STATE_SCRIPT" "$WS" "$SURF")"
  case "$state" in
    dead)
      # Require consecutive dead reads: one transient read-screen failure
      # (daemon hiccup, focus change) must not be reported as a dead worker.
      dead_streak=$((dead_streak + 1))
      if [ "$dead_streak" -ge "$DEAD_CONFIRMS" ]; then
        status="dead"
        break
      fi
      ;;
    running)
      seen_running=true
      idle_streak=0
      dead_streak=0
      ;;
    idle)
      dead_streak=0
      if $seen_running || [ "$elapsed" -ge "$GRACE" ]; then
        idle_streak=$((idle_streak + 1))
        if [ "$idle_streak" -ge "$IDLE_CONFIRMS" ]; then
          status="idle"
          break
        fi
      fi
      ;;
  esac
  sleep "$POLL_INTERVAL"
done

end="$(date +%s)"
echo "RESULT status=$status surface=$SURF elapsed=$((end - start))"
echo "--- pane tail ---"
CMUX_QUIET=1 cmux read-screen --workspace "$WS" --surface "$SURF" --lines 40 2>/dev/null || true
