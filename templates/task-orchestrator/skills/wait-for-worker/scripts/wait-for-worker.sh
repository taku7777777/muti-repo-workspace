#!/usr/bin/env bash
# Wait until the pinned worker settles. Thin wrapper over ~/.cmux-wait.sh
# (installed by setup-workspace.sh). Runs OUTSIDE the sandbox via
# excludedCommands — keep minimal.
set -euo pipefail

TIMEOUT=1800
while [ $# -gt 0 ]; do
  case "$1" in
    --workspace*|--surface*)
      echo "ERROR: target override is not allowed" >&2; exit 2 ;;
    ""|*[!0-9]*) echo "usage: wait-for-worker.sh [timeout-seconds]" >&2; exit 2 ;;
    *) TIMEOUT="$1"; shift ;;
  esac
done

SKILLS_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
TARGET_FILE="$SKILLS_DIR/.worker-target"
[ -f "$TARGET_FILE" ] || { echo "ERROR: $TARGET_FILE not found" >&2; exit 1; }
# shellcheck source=/dev/null
. "$TARGET_FILE"
: "${WORKER_CMUX_WORKSPACE:?malformed .worker-target}" "${WORKER_CMUX_SURFACE:?malformed .worker-target}"

WAIT_SCRIPT="${CMUX_WAIT_SCRIPT:-$HOME/.cmux-wait.sh}"
[ -x "$WAIT_SCRIPT" ] || { echo "ERROR: $WAIT_SCRIPT not found or not executable (run /setup-workspace)" >&2; exit 1; }

exec "$WAIT_SCRIPT" "$WORKER_CMUX_WORKSPACE" "$WORKER_CMUX_SURFACE" "$TIMEOUT"
