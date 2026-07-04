#!/usr/bin/env bash
# Zero-dependency test runner for the pure helpers in scripts/lib/.
# Usage: bash tests/run-tests.sh
set -u

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$TESTS_DIR")"
# shellcheck source=../scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"

PASS=0
FAIL=0

assert_eq() { # <label> <expected> <actual>
  if [ "$2" = "$3" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected: %s\n  actual:   %s\n' "$1" "$2" "$3" >&2
  fi
}

assert_match() { # <label> <pattern> <actual>
  if printf '%s' "$3" | grep -qE "$2"; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  pattern: %s\n  actual:  %s\n' "$1" "$2" "$3" >&2
  fi
}

# --- to_home_path ------------------------------------------------------------
assert_eq "to_home_path: under HOME" "~/x/y" "$(to_home_path "$HOME/x/y")"
assert_eq "to_home_path: outside HOME" "/tmp/z" "$(to_home_path "/tmp/z")"
assert_eq "to_home_path: HOME prefix but not dir boundary" "${HOME}extra/f" "$(to_home_path "${HOME}extra/f")"

# --- sed_escape ---------------------------------------------------------------
assert_eq "sed_escape: ampersand" 'a\&b' "$(sed_escape 'a&b')"
assert_eq "sed_escape: pipe (our delimiter)" 'a\|b' "$(sed_escape 'a|b')"
assert_eq "sed_escape: backslash" 'a\\b' "$(sed_escape 'a\b')"

# --- render_template ------------------------------------------------------------
tpl="$(mktemp)"
printf 'id={{TICKET_ID}} dir={{TASK_DIR}} title={{TITLE}}\n' > "$tpl"
out="$(WORKSPACE_ROOT=/w TASK_DIR=/w/tasks/T-1 TASK_DIR_H='~/w/tasks/T-1' \
  TICKET_ID=T-1 TITLE='Fix & improve | stuff' render_template "$tpl")"
assert_eq "render_template: basic + special chars" \
  'id=T-1 dir=/w/tasks/T-1 title=Fix & improve | stuff' "$out"
out="$(render_template "$tpl")"
assert_eq "render_template: unset vars become empty" 'id= dir= title=' "$out"
rm -f "$tpl"

# --- template_for (override precedence) -----------------------------------------
assert_eq "template_for: default fallback" \
  "$ROOT/templates/default/task.md" "$(template_for task.md dev '')"
assert_eq "template_for: purpose override" \
  "$ROOT/templates/purposes/dev/initial-prompt.md" "$(template_for initial-prompt.md dev '')"
assert_eq "template_for: unknown kind falls back to purpose" \
  "$ROOT/templates/purposes/dev/initial-prompt.md" "$(template_for initial-prompt.md dev bug)"

# --- list_purposes ---------------------------------------------------------------
purposes="$(list_purposes | tr '\n' ' ')"
assert_match "list_purposes contains dev" '(^| )dev( |$)' "$purposes"
assert_match "list_purposes contains task" '(^| )task( |$)' "$purposes"

# --- json_get --------------------------------------------------------------------
j="$(mktemp)"
echo '{"a": "x", "n": null, "arr": ["p","q"]}' > "$j"
assert_eq "json_get: present" "x" "$(json_get "$j" '.a' 'd')"
assert_eq "json_get: null → default" "d" "$(json_get "$j" '.n' 'd')"
assert_eq "json_get: missing → default" "d" "$(json_get "$j" '.zz' 'd')"
assert_eq "json_get: join" "p q" "$(json_get "$j" '.arr | join(" ")')"
rm -f "$j"

# --- ticket id pattern (as used by create-workspace) ------------------------------
pattern="$(json_get "$ROOT/config/workspace.json" '.ticket_id_pattern' '^[A-Z]+-[A-Za-z0-9_-]+$')"
check_ticket() { printf '%s' "$1" | grep -qE "$pattern" && echo ok || echo ng; }
assert_eq "ticket: valid" "ok" "$(check_ticket 'ABC-123')"
assert_eq "ticket: valid with suffix" "ok" "$(check_ticket 'HHW-12_a-b')"
assert_eq "ticket: missing prefix" "ng" "$(check_ticket '1234')"
assert_eq "ticket: lowercase prefix" "ng" "$(check_ticket 'abc-1')"
assert_eq "ticket: path traversal" "ng" "$(check_ticket 'A-1/../x')"

# --- pre-push org extraction -------------------------------------------------------
extract_org() {
  local REMOTE_URL="$1" org=""
  case "$REMOTE_URL" in
    *"://"*) org="$(printf '%s' "$REMOTE_URL" | sed -E 's#^[a-z+]+://[^/]+/([^/]+)/.*#\1#')" ;;
    *@*:*/*) org="${REMOTE_URL#*:}" ; org="${org%%/*}" ;;
  esac
  printf '%s' "$org"
}
assert_eq "pre-push org: ssh scp-like" "my-org" "$(extract_org 'git@github.com:my-org/repo.git')"
assert_eq "pre-push org: https" "my-org" "$(extract_org 'https://github.com/my-org/repo.git')"
assert_eq "pre-push org: ssh url" "my-org" "$(extract_org 'ssh://git@github.com/my-org/repo.git')"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
