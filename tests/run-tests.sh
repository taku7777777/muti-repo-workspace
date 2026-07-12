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

assert_status() { # <label> <expected-exit> <cmd...>
  local label="$1" want="$2"; shift 2
  "$@" >/dev/null 2>&1; local got=$?
  if [ "$got" -eq "$want" ]; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n  expected exit: %s\n  actual exit:   %s\n' "$label" "$want" "$got" >&2
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
  "$ROOT/templates/purposes/dev/initial-prompt.md" "$(template_for initial-prompt.md dev zzz-no-such-kind)"

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

# --- validate_ticket_id (security boundary) --------------------------------------
# Runs in a subshell because validate_ticket_id calls die() (exit 1).
vti() ( validate_ticket_id "$1" )
assert_status "validate_ticket_id: valid" 0 vti 'ABC-123'
assert_status "validate_ticket_id: valid with suffix" 0 vti 'HHW-12_a-b'
assert_status "validate_ticket_id: rejects slash traversal" 1 vti 'A-1/../x'
assert_status "validate_ticket_id: rejects dotdot" 1 vti 'A-..'
assert_status "validate_ticket_id: rejects empty" 1 vti ''
assert_status "validate_ticket_id: rejects lowercase prefix" 1 vti 'abc-1'
# Newline bypass: the OLD line-based grep accepted this (line 1 matched);
# validate_ticket_id must reject it.
assert_status "validate_ticket_id: rejects embedded newline" 1 vti "$(printf 'A-1\n/../../tmp/evil')"

# --- pre-push hook (real subprocess, controlled config) --------------------------
# Invoke the ACTUAL hook against a temp workspace so a regression in the hook
# itself is caught (the previous test exercised an inline copy that could not).
hookdir="$(mktemp -d)"
mkdir -p "$hookdir/.githooks" "$hookdir/config"
cp "$ROOT/.githooks/pre-push" "$hookdir/.githooks/pre-push"
run_hook() { bash "$hookdir/.githooks/pre-push" origin "$1"; }

# allowed_push_orgs set: org enforced, host enforced.
printf '{"allowed_push_orgs":["good-org"],"allowed_push_hosts":["github.com"]}\n' > "$hookdir/config/workspace.json"
assert_status "pre-push: allowed org+host passes" 0 run_hook 'https://github.com/good-org/repo.git'
assert_status "pre-push: allowed org via scp-like ssh passes" 0 run_hook 'git@github.com:good-org/repo.git'
assert_status "pre-push: disallowed org blocked" 1 run_hook 'https://github.com/evil-org/repo.git'
assert_status "pre-push: disallowed host blocked (org matches)" 1 run_hook 'https://evil.example/good-org/repo.git'
assert_status "pre-push: unparsable URL blocked" 1 run_hook 'not-a-url'

# allowed_push_orgs EMPTY: org unrestricted (warn) BUT host still enforced.
printf '{"allowed_push_orgs":[],"allowed_push_hosts":["github.com"]}\n' > "$hookdir/config/workspace.json"
assert_status "pre-push: empty orgs still allows allowed host" 0 run_hook 'https://github.com/anyone/repo.git'
assert_status "pre-push: empty orgs still BLOCKS bad host" 1 run_hook 'https://evil.example/anyone/repo.git'
rm -rf "$hookdir"

# --- worktree_gitdir (real git fixture) ------------------------------------------
# The resolved gitdir feeds the worker's config.worktree denyWrite pin — a wrong
# path here silently drops the C-2 redirect guard, so exercise the real thing.
# shellcheck source=../scripts/lib/effects/worktree.sh
. "$ROOT/scripts/lib/effects/worktree.sh"
wt_ticket="ZZTEST-wtgd$$"
wt_origin="$(mktemp -d)"
git -C "$wt_origin" -c init.defaultBranch=main init -q
git -C "$wt_origin" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
mkdir -p "$ROOT/tasks/$wt_ticket/repositories"
git -C "$wt_origin" worktree add -q -b "test-$wt_ticket" \
  "$ROOT/tasks/$wt_ticket/repositories/fixture-repo" >/dev/null 2>&1
resolved="$(worktree_gitdir fixture-repo "$wt_ticket")" || resolved=""
# NB: compare via a suffix pattern — on macOS, mktemp returns /var/... while
# git resolves the realpath /private/var/..., so a prefix match would fail.
assert_match "worktree_gitdir: resolves the private gitdir" \
  "/\.git/worktrees/fixture-repo$" "$resolved"
assert_status "worktree_gitdir: config.worktree pin path is derivable" 0 \
  test -n "$resolved"
assert_status "worktree_gitdir: missing worktree returns non-zero" 1 \
  worktree_gitdir no-such-repo "$wt_ticket"
git -C "$wt_origin" worktree remove --force \
  "$ROOT/tasks/$wt_ticket/repositories/fixture-repo" >/dev/null 2>&1
rm -rf "$ROOT/tasks/$wt_ticket" "$wt_origin"

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
