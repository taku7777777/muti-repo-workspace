#!/usr/bin/env bash
# Ticket source adapter: manual.
#
# Adapter contract (all adapters in this directory):
#   <adapter>.sh fetch <ticket-id-or-url>
#     → prints the ticket body (markdown) on stdout, exit 0
#     → exit non-zero with a message on stderr when it cannot fetch
#
# The manual adapter cannot fetch anything: /open-task asks the user to paste
# the ticket content instead.
set -euo pipefail

CMD="${1:-}"
case "$CMD" in
  fetch)
    echo "manual ticket source: nothing to fetch — ask the user to paste the ticket description." >&2
    exit 3
    ;;
  *)
    echo "usage: manual.sh fetch <ref>" >&2
    exit 2
    ;;
esac
