#!/usr/bin/env bash
# Capture the pinned worker surface's screen. Runs OUTSIDE the sandbox via
# excludedCommands — keep minimal.
set -euo pipefail

LINES=60
SCROLLBACK=false
while [ $# -gt 0 ]; do
  case "$1" in
    --lines) LINES="${2:?--lines needs a value}"; shift 2 ;;
    --scrollback) SCROLLBACK=true; shift ;;
    --workspace*|--surface*)
      echo "ERROR: target override is not allowed" >&2; exit 2 ;;
    *) echo "usage: read-output.sh [--lines N] [--scrollback]" >&2; exit 2 ;;
  esac
done

SKILLS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_FILE="$SKILLS_DIR/.worker-target"
[ -f "$TARGET_FILE" ] || { echo "ERROR: $TARGET_FILE not found" >&2; exit 1; }
# shellcheck source=/dev/null
. "$TARGET_FILE"
: "${WORKER_CMUX_WORKSPACE:?malformed .worker-target}" "${WORKER_CMUX_SURFACE:?malformed .worker-target}"

export CMUX_QUIET=1
ARGS=(--workspace "$WORKER_CMUX_WORKSPACE" --surface "$WORKER_CMUX_SURFACE" --lines "$LINES")
$SCROLLBACK && ARGS+=(--scrollback)
exec cmux read-screen "${ARGS[@]}"
