#!/usr/bin/env bash
# Ticket source adapter: GitHub Issues (via gh CLI).
#
# Accepted refs:
#   https://github.com/<org>/<repo>/issues/<n>
#   <org>/<repo>#<n>
#
# Prints a self-contained markdown ticket body (title, URL, labels, body).
set -euo pipefail

CMD="${1:-}"
REF="${2:-}"
[ "$CMD" = "fetch" ] && [ -n "$REF" ] || { echo "usage: github-issues.sh fetch <issue-url | org/repo#N>" >&2; exit 2; }
command -v gh >/dev/null 2>&1 || { echo "github-issues adapter requires the gh CLI" >&2; exit 3; }

case "$REF" in
  https://github.com/*/issues/*)
    repo="$(printf '%s' "$REF" | sed -E 's#https://github.com/([^/]+/[^/]+)/issues/.*#\1#')"
    num="$(printf '%s' "$REF" | sed -E 's#.*/issues/([0-9]+).*#\1#')"
    ;;
  */*#*)
    repo="${REF%%#*}"
    num="${REF##*#}"
    ;;
  *)
    echo "unrecognized ref: $REF" >&2; exit 2
    ;;
esac

gh issue view "$num" -R "$repo" --json title,url,body,labels --template \
'# {{.title}}

> Source: {{.url}}
> Labels: {{range .labels}}{{.name}} {{end}}

{{.body}}
'
