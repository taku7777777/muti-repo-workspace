#!/usr/bin/env bash
# Send one instruction to the pinned worker surface (text, then enter).
# Runs OUTSIDE the sandbox via excludedCommands — keep this script minimal
# and audit any change carefully.
set -euo pipefail

for a in "$@"; do
  case "$a" in
    --workspace*|--surface*)
      echo "ERROR: target override is not allowed — this skill only talks to the worker in .worker-target" >&2
      exit 2 ;;
  esac
done
[ $# -eq 1 ] || { echo "usage: send-command.sh \"<instruction text>\"" >&2; exit 2; }

SKILLS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_FILE="$SKILLS_DIR/.worker-target"
[ -f "$TARGET_FILE" ] || { echo "ERROR: $TARGET_FILE not found (was this task created by /open-task?)" >&2; exit 1; }

# shellcheck source=/dev/null
. "$TARGET_FILE"
: "${WORKER_CMUX_WORKSPACE:?malformed .worker-target}" "${WORKER_CMUX_SURFACE:?malformed .worker-target}"

export CMUX_QUIET=1
cmux send --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" "$1" >/dev/null
# A trailing newline in the text does NOT submit the prompt — enter must be a
# separate key event.
cmux send-key --workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" enter >/dev/null

echo "SENT surface=$WORKER_CMUX_SURFACE"
