#!/usr/bin/env bash
# Run ShellCheck over the repository's host-side shell scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v shellcheck >/dev/null 2>&1; then
  printf '%s\n' "WARNING: shellcheck is not installed; install it with 'brew install shellcheck' (or your package manager)." >&2
  exit 0
fi

shellcheck \
  "$ROOT"/scripts/*.sh \
  "$ROOT"/scripts/cmux/*.sh \
  "$ROOT"/scripts/task/*.sh \
  "$ROOT"/scripts/lib/*.sh \
  "$ROOT"/scripts/lib/effects/*.sh \
  "$ROOT"/scripts/lib/ticket-sources/*.sh
