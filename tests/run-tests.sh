#!/usr/bin/env bash
# Zero-dependency test runner for the pure helpers in scripts/lib/.
# Usage: bash tests/run-tests.sh
set -u

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$TESTS_DIR")"
# shellcheck source=../scripts/lib/common.sh
. "$ROOT/scripts/lib/common.sh"
# shellcheck source=../scripts/lib/effects/ticket-registry.sh
. "$ROOT/scripts/lib/effects/ticket-registry.sh"

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

# --- canonical paths / config failure semantics -------------------------------
canon_td="$(mktemp -d)"
mkdir -p "$canon_td/real"
ln -s "$canon_td/real" "$canon_td/link"
canon_real="$(cd "$canon_td/real" && pwd -P)"
assert_eq "canonicalize_path: strips trailing slash" "$canon_real" "$(canonicalize_path "$canon_td/real///")"
assert_eq "canonicalize_path: resolves symlinks" "$canon_real" "$(canonicalize_path "$canon_td/link")"
assert_eq "canonicalize_path: preserves missing suffix" "$canon_real/new/deep" "$(canonicalize_path "$canon_td/link/new/deep")"
canon_try() ( canonicalize_path "$1" )
reject_tasks_try() ( reject_tasks_path "$1" )
assert_status "canonicalize_path: rejects relative paths" 1 canon_try "relative/path"
assert_status "canonicalize_path: rejects dotdot in missing suffix" 1 canon_try "$canon_td/missing/../escape"
assert_status "config validation: rejects tasks segment" 1 reject_tasks_try "$canon_td/tasks/config"

mkdir -p "$canon_td/bad" "$canon_td/missing"
printf '{bad json\n' > "$canon_td/bad/workspace.json"
assert_status "state_root: invalid workspace JSON fails closed" 1 \
  bash -c '. "$1/scripts/lib/common.sh"; MRW_CONFIG_DIR="$2" state_root' _ "$ROOT" "$canon_td/bad"
assert_status "config_dir: invalid workspace JSON fails closed" 1 \
  bash -c '. "$1/scripts/lib/common.sh"; MRW_CONFIG_DIR="$2" config_dir' _ "$ROOT" "$canon_td/bad"
assert_eq "state_root: missing workspace JSON uses config base" "$(cd "$canon_td" && pwd -P)" \
  "$(MRW_CONFIG_DIR="$canon_td/missing" state_root)"

assert_eq "compose_project_name: legacy preserves historical project" "mrw-phase0" \
  "$(MRW_CONFIG_DIR="$ROOT/config" compose_project_name)"
mkdir -p "$canon_td/workspace/.mrw"
printf '{}\n' > "$canon_td/workspace/.mrw/workspace.json"
compose_base="$(cd "$canon_td/workspace" && pwd -P)"
compose_expected="mrw-$(printf '%s' "$compose_base" | shasum -a 256 | cut -c1-12)"
compose_first="$(MRW_CONFIG_DIR="$canon_td/workspace/.mrw" compose_project_name)"
compose_second="$(MRW_CONFIG_DIR="$canon_td/workspace/.mrw" compose_project_name)"
assert_match "compose_project_name: workspace uses mrw-prefixed hash" '^mrw-[0-9a-f]{12}$' "$compose_first"
assert_eq "compose_project_name: workspace value derives from config_base" "$compose_expected" "$compose_first"
assert_eq "compose_project_name: workspace value is deterministic" "$compose_first" "$compose_second"
rm -rf "$canon_td"

# --- render_template ------------------------------------------------------------
tpl="$(mktemp)"
printf 'id={{TICKET_ID}} dir={{TASK_DIR}} title={{TITLE}}\n' > "$tpl"
out="$(WORKSPACE_ROOT=/w TASK_DIR=/w/tasks/T-1 TASK_DIR_H='~/w/tasks/T-1' \
  TICKET_ID=T-1 TITLE='Fix & improve | stuff' render_template "$tpl")"
assert_eq "render_template: basic + special chars" \
  'id=T-1 dir=/w/tasks/T-1 title=Fix & improve | stuff' "$out"
out="$(render_template "$tpl")"
assert_eq "render_template: unset vars become empty" 'id= dir= title=' "$out"

# Agent settings must pin the resolved workspace config directory in both the
# tool permission layer and the OS sandbox layer.
settings_config_td="$(mktemp -d)"
CONFIG_DIR="$(canonicalize_path "$settings_config_td")"
export CONFIG_DIR
for role in task-worker task-orchestrator; do
  settings_out="$(render_template "$ROOT/templates/$role/claude-settings.json")"
  assert_status "$role settings: config_dir Edit deny is rendered" 0 \
    bash -c 'printf "%s" "$1" | jq -e --arg v "Edit(/$2/**)" ".permissions.deny | index(\$v) != null" >/dev/null' \
    _ "$settings_out" "$CONFIG_DIR"
  assert_status "$role settings: config_dir denyWrite is rendered" 0 \
    bash -c 'printf "%s" "$1" | jq -e --arg v "$2" ".sandbox.filesystem.denyWrite | index(\$v) != null" >/dev/null' \
    _ "$settings_out" "$CONFIG_DIR"
done
unset CONFIG_DIR
rm -rf "$settings_config_td"

# --add-write must reject config_dir (and descendants) before task lookup,
# while an unrelated absolute path proceeds to the ordinary task lookup.
sandbox_guard_td="$(mktemp -d)"
mkdir -p "$sandbox_guard_td/.mrw/child" "$sandbox_guard_td/outside"
printf '{}\n' > "$sandbox_guard_td/.mrw/workspace.json"
guard_out="$(MRW_CONFIG_DIR="$sandbox_guard_td/.mrw" bash "$ROOT/scripts/update-task-sandbox.sh" TST-1 --add-write "$sandbox_guard_td/.mrw/child" 2>&1)"
guard_status=$?
assert_eq "update-task-sandbox: config_dir descendant is rejected" 1 "$guard_status"
assert_match "update-task-sandbox: config_dir rejection names protected directory" \
  'refusing --add-write into the workspace config directory' "$guard_out"
outside_out="$(MRW_CONFIG_DIR="$sandbox_guard_td/.mrw" bash "$ROOT/scripts/update-task-sandbox.sh" TST-1 --add-write "$sandbox_guard_td/outside" 2>&1)"
outside_status=$?
assert_eq "update-task-sandbox: outside config_dir reaches task lookup" 1 "$outside_status"
assert_match "update-task-sandbox: outside config_dir retains ordinary missing-task failure" \
  'no worker settings for task TST-1' "$outside_out"
rm -rf "$sandbox_guard_td"
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

# --- broker ticket registry -------------------------------------------------
registry_td="$(mktemp -d)"
mkdir -p "$registry_td/.mrw"
printf '{"state_root":"%s/state"}\n' "$registry_td" > "$registry_td/.mrw/workspace.json"
registry_call() ( MRW_CONFIG_DIR="$registry_td/.mrw" "$@" )

assert_status "ticket registry: register creates an entry" 0 registry_call register_broker_ticket REG-1
registry_entry="$registry_td/state/broker-tickets/REG-1"
assert_status "ticket registry: entry has the typed JSON content" 0 \
  jq -e '.ticket == "REG-1" and (.created_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T"))' "$registry_entry"
assert_status "ticket registry: registration is idempotent" 0 registry_call register_broker_ticket REG-1
assert_status "ticket registry: deregister removes the entry" 0 registry_call deregister_broker_ticket REG-1
assert_status "ticket registry: deregistered entry is absent" 1 test -e "$registry_entry"
rmdir "$registry_td/state/broker-tickets"
assert_status "ticket registry: deregister tolerates a missing entry and directory" 0 registry_call deregister_broker_ticket REG-1

mkdir -p "$registry_td/real/tasks/state" "$registry_td/tasks-config"
printf '{"state_root":"%s/real/tasks/state"}\n' "$registry_td" > "$registry_td/tasks-config/workspace.json"
registry_tasks_call() ( MRW_CONFIG_DIR="$registry_td/tasks-config" register_broker_ticket REG-2 )
assert_status "ticket registry: refuses a canonicalized tasks path" 1 registry_tasks_call
rm -rf "$registry_td"

# --- pre-push hook (real subprocess, controlled config) --------------------------
# Invoke the ACTUAL hook against a temp workspace so a regression in the hook
# itself is caught (the previous test exercised an inline copy that could not).
hookdir="$(mktemp -d)"
mkdir -p "$hookdir/.githooks" "$hookdir/config" "$hookdir/scripts/lib"
cp "$ROOT/.githooks/pre-push" "$hookdir/.githooks/pre-push"
cp "$ROOT/scripts/lib/common.sh" "$hookdir/scripts/lib/common.sh"
hook_global="$(mktemp)"
run_hook() { GIT_CONFIG_GLOBAL="$hook_global" bash "$hookdir/.githooks/pre-push" origin "$1"; }

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

# A gitdir-scoped baked global include wins even when cwd cannot walk up to it.
baked_cfg="$(mktemp -d)"
printf '{"allowed_push_orgs":["baked-org"],"allowed_push_hosts":["github.com"]}\n' > "$baked_cfg/workspace.json"
git_fixture="$(mktemp -d)"
git -C "$git_fixture" init -q
git config --file "$hookdir/baked-include" mrw.configDir "$baked_cfg/"
git config --file "$hook_global" "includeIf.gitdir:$git_fixture/.path" "$hookdir/baked-include"
assert_status "pre-push: uses baked mrw.configDir" 0 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/baked-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"
attacker_cfg="$(mktemp -d)"
printf '{"allowed_push_orgs":["evil-org"],"allowed_push_hosts":["github.com"]}\n' > "$attacker_cfg/workspace.json"
git -C "$git_fixture" config mrw.configDir "$attacker_cfg"
assert_status "pre-push: blocks repo-local configDir spoof" 1 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/baked-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"
assert_status "pre-push: local spoof allowlist does not win" 1 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/evil-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"

git -C "$git_fixture" config --unset-all mrw.configDir
git -C "$git_fixture" config extensions.worktreeConfig true
git -C "$git_fixture" config --worktree mrw.configDir "$attacker_cfg"
assert_status "pre-push: blocks worktree configDir spoof" 1 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/baked-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"
git -C "$git_fixture" config --worktree --unset-all mrw.configDir

# Two gitdir-scoped global includes retain independent per-workspace
# allowlists. This catches a shared, last-setup-wins include target.
scope_root_raw="$(mktemp -d)"
scope_root="$(cd "$scope_root_raw" && pwd -P)"
scope_global="$(mktemp)"
for scope in A B; do
  mkdir -p "$scope_root/$scope/config" "$scope_root/$scope/repo"
  git -C "$scope_root/$scope/repo" init -q
  org="$(printf '%s' "$scope" | tr '[:upper:]' '[:lower:]')-org"
  printf '{"allowed_push_orgs":["%s"],"allowed_push_hosts":["github.com"]}\n' "$org" \
    > "$scope_root/$scope/config/workspace.json"
  git config --file "$scope_root/$scope/include" mrw.configDir "$scope_root/$scope/config"
  git config --file "$scope_global" "includeIf.gitdir:$scope_root/$scope/.path" "$scope_root/$scope/include"
done
assert_status "pre-push: workspace A uses A allowlist" 0 \
  bash -c 'cd "$1/A/repo" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/a-org/repo.git' _ "$scope_root" "$hookdir" "$scope_global"
assert_status "pre-push: workspace A rejects B allowlist" 1 \
  bash -c 'cd "$1/A/repo" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/b-org/repo.git' _ "$scope_root" "$hookdir" "$scope_global"
assert_status "pre-push: workspace B uses B allowlist" 0 \
  bash -c 'cd "$1/B/repo" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/b-org/repo.git' _ "$scope_root" "$hookdir" "$scope_global"
assert_status "pre-push: workspace B rejects A allowlist" 1 \
  bash -c 'cd "$1/B/repo" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/a-org/repo.git' _ "$scope_root" "$hookdir" "$scope_global"

# Without the baked value, a legitimate ancestor .mrw is the fallback.
walk_ws="$(mktemp -d)"
walk_global="$(mktemp)"
mkdir -p "$walk_ws/.mrw" "$walk_ws/repo"
printf '{"allowed_push_orgs":["walk-org"],"allowed_push_hosts":["github.com"]}\n' > "$walk_ws/.mrw/workspace.json"
assert_status "pre-push: falls back to ancestor walk-up" 0 \
  bash -c 'cd "$1/repo" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/walk-org/repo.git' _ "$walk_ws" "$hookdir" "$walk_global"

# A repo with no baked key, no walk-up config, and no tool-home legacy config
# remains fail-open so setup is not required merely to push an unrelated repo.
legacy_hookdir="$(mktemp -d)"
legacy_repo="$(mktemp -d)"
mkdir -p "$legacy_hookdir/.githooks" "$legacy_hookdir/scripts/lib"
cp "$ROOT/.githooks/pre-push" "$legacy_hookdir/.githooks/pre-push"
cp "$ROOT/scripts/lib/common.sh" "$legacy_hookdir/scripts/lib/common.sh"
git -C "$legacy_repo" init -q
legacy_output="$(cd "$legacy_repo" && GIT_CONFIG_GLOBAL="$walk_global" bash "$legacy_hookdir/.githooks/pre-push" origin https://github.com/any-org/repo.git 2>&1)"
legacy_status=$?
assert_eq "pre-push: missing legacy config fails open" 0 "$legacy_status"
assert_match "pre-push: missing legacy config warns" 'WARNING: cannot read .*workspace.json \(missing file\); allowing push' "$legacy_output"
rm -rf "$legacy_hookdir" "$legacy_repo"

printf '{broken\n' > "$baked_cfg/workspace.json"
git -C "$git_fixture" config --unset-all mrw.configDir
assert_status "pre-push: malformed config fails closed" 1 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/baked-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"
rm -f "$baked_cfg/workspace.json"
assert_status "pre-push: missing baked config fails closed" 1 \
  bash -c 'cd "$1" && GIT_CONFIG_GLOBAL="$3" bash "$2/.githooks/pre-push" origin https://github.com/baked-org/repo.git' _ "$git_fixture" "$hookdir" "$hook_global"
rm -rf "$baked_cfg" "$attacker_cfg" "$git_fixture" "$walk_ws" "$scope_root"
rm -rf "$hookdir" "$hook_global" "$scope_global" "$walk_global"

# --- CLI pure helpers ---------------------------------------------------------
canon_file_td="$(mktemp -d)"
mkdir -p "$canon_file_td/real"
ln -s "$canon_file_td/real" "$canon_file_td/link"
printf 'not a directory\n' > "$canon_file_td/real/file"
canon_file_input="$canon_file_td/link/file/child"
shell_canon_file="$(canonicalize_path "$canon_file_input")"
js_canon_file="$(node --input-type=module -e "import { canonicalizePath } from '$ROOT/cli/mrw.mjs'; process.stdout.write(canonicalizePath(process.argv[1]))" "$canon_file_input")"
assert_eq "canonicalize path: shell and JS preserve regular-file suffix equally" "$shell_canon_file" "$js_canon_file"
rm -rf "$canon_file_td"

assert_status "mrw stripControlChars: removes CSI/OSC/C0" 0 node --input-type=module -e \
  "import { stripControlChars } from '$ROOT/cli/mrw.mjs'; const s='ok\\x1b[31mRED\\x1b[0m\\x1b]0;secret\\x07!\\x01'; if (stripControlChars(s) !== 'okRED!') process.exit(1)"

legacy_config_output="$(MRW_CONFIG_DIR="$ROOT/config" node "$ROOT/cli/mrw.mjs" config)"
assert_match "mrw config: reports legacy compose project" '^compose_project: mrw-phase0$' "$legacy_config_output"
compose_cli_td="$(mktemp -d)"
mkdir -p "$compose_cli_td/workspace/.mrw"
printf '{}\n' > "$compose_cli_td/workspace/.mrw/workspace.json"
shell_project="$(MRW_CONFIG_DIR="$compose_cli_td/workspace/.mrw" compose_project_name)"
cli_project="$(MRW_CONFIG_DIR="$compose_cli_td/workspace/.mrw" node "$ROOT/cli/mrw.mjs" config | sed -n 's/^compose_project: //p')"
assert_eq "compose project: shell and CLI workspace implementations agree" "$shell_project" "$cli_project"
rm -rf "$compose_cli_td"

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

# --- chat-frontend template rendering (mrw-chat.md Phase C3) -----------------
# Every placeholder render_template now supports for templates/chat-frontend/
# must be resolved by the time settings.json/.mcp.json actually run inside
# the container — no residual {{...}} left in the output. Run in the CURRENT
# shell (not a `( )` subshell): assert_* mutate PASS/FAIL by simple
# arithmetic, which would not propagate back out of a subshell.
export WORKSPACE_ROOT="$ROOT" STATE_ROOT="$ROOT" TICKET_ID="T-1" PURPOSE="dev" BRANCH="feat/T-1"
export MODEL="sonnet" WORK_TYPE="feature" REPOS_CSV="repoa,repob"
export REPOS_BLOCK='`repoa` (worktree: /workspaces/muti-repo-workspace/tasks/T-1/repositories/repoa); `repob` (worktree: /workspaces/muti-repo-workspace/tasks/T-1/repositories/repob)'
export CLAUDE_MD_EXCLUDES_JSON='"/workspaces/muti-repo-workspace/tasks/T-1/repositories/repoa", "/workspaces/muti-repo-workspace/tasks/T-1/repositories/repob"'
export HARNESS_RUN_DIR="/home/node/harness-run"
export CONTAINER_WORKSPACE_ROOT="/workspaces/muti-repo-workspace"
export SPINE_STATE_DIR="/var/mrw/notes"
export MCP_TOOL_TIMEOUT_MS="3600000"

for f in settings.json CLAUDE.md .mcp.json; do
  out="$(render_template "$ROOT/templates/chat-frontend/$f")"
  residual="$(printf '%s' "$out" | grep -oE '\{\{[A-Za-z_]+\}\}' | sort -u | tr '\n' ' ')"
  assert_eq "chat-frontend $f: no unrendered placeholders" "" "$residual"
done

settings_out="$(render_template "$ROOT/templates/chat-frontend/settings.json")"
assert_status "chat-frontend settings.json: renders valid JSON" 0 \
  bash -c 'printf "%s" "$1" | jq empty' _ "$settings_out"
mcp_out="$(render_template "$ROOT/templates/chat-frontend/.mcp.json")"
assert_status "chat-frontend .mcp.json: renders valid JSON" 0 \
  bash -c 'printf "%s" "$1" | jq empty' _ "$mcp_out"

assert_match "chat-frontend settings.json: denies Bash" '"Bash"' "$settings_out"
assert_match "chat-frontend settings.json: denies Task" '"Task"' "$settings_out"
assert_match "chat-frontend settings.json: denies Agent" '"Agent"' "$settings_out"
assert_match "chat-frontend settings.json: allows mcp__spine__\*" '"mcp__spine__\*"' "$settings_out"
assert_match "chat-frontend settings.json: enables the spine MCP server" '"enabledMcpjsonServers": \["spine"\]' "$settings_out"
assert_match "chat-frontend settings.json: grants additionalDirectories for repo-orientation Reads" \
  '"additionalDirectories": \["/workspaces/muti-repo-workspace"\]' "$settings_out"
assert_match "chat-frontend .mcp.json: spawns tsx directly (not npm run)" '\.bin/tsx' "$mcp_out"

# Clear the chat-frontend env vars so they don't leak into anything below.
unset WORKSPACE_ROOT STATE_ROOT TICKET_ID PURPOSE BRANCH MODEL WORK_TYPE
unset REPOS_CSV REPOS_BLOCK CLAUDE_MD_EXCLUDES_JSON HARNESS_RUN_DIR CONTAINER_WORKSPACE_ROOT SPINE_STATE_DIR MCP_TOOL_TIMEOUT_MS

# --- shared fake `docker` shim for every chat-up.sh subprocess test below ----
# chat-up.sh's very first lines are `require_cmd docker; require_cmd jq` — on
# a docker-less host (or CI) that dies BEFORE reaching any of the guard/
# dispatch logic these tests actually exercise, which would make the tests
# pass or fail for the WRONG reason. A tiny always-"nothing running" shim
# (same "empty output = down" contract chat-up.sh itself checks for) makes
# every test below deterministic regardless of what's really on this host —
# same "fake a real subprocess via a controlled PATH" style as the pre-push
# hook test above, just reused for every case here instead of one.
chat_fakebin="$(mktemp -d)"
cat > "$chat_fakebin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
# Fake docker: `compose ... ps --status running -q orchestrator` always
# reports "nothing running" (empty stdout, exit 0); every other invocation
# shape also just exits 0 with no output (harmless no-op).
exit 0
FAKE_DOCKER
chmod +x "$chat_fakebin/docker"
chat_up_with_fake_docker() { # <MRW_CONFIG_DIR> <chat-up.sh args...>
  local cfgdir="$1"; shift
  PATH="$chat_fakebin:$PATH" MRW_CONFIG_DIR="$cfgdir" bash "$ROOT/scripts/chat-up.sh" "$@" 2>&1
}
# Exported: some call sites below invoke this from inside `bash -c "..."`
# (assert_status's "run a fresh subprocess and check its exit code" shape) —
# a NESTED bash only sees a shell FUNCTION if it was exported first, and
# (bash has no closures) only sees the VARIABLES the function body
# references — $chat_fakebin, $ROOT — if THOSE are exported too.
export ROOT chat_fakebin
export -f chat_up_with_fake_docker

# --- chat-up.sh: render-target tasks/-segment refusal (mrw-chat.md C3) -------
# Same guard class as `mrw init` — STATE_ROOT/chat/<ticket> must never resolve
# under a worker-writable `tasks/` path segment. Exercised as a real
# subprocess (not by sourcing chat-up.sh, which runs its whole flow at the
# top level) against a throwaway per-workspace config, several path shapes —
# including a SYMLINKED state_root, which must be resolved (canonicalized)
# before the guard's string match, not matched against literally.
chat_guard_td="$(mktemp -d)"
mkdir -p "$chat_guard_td/.mrw"
chat_guard_ws_config() { # <state_root>
  printf '{"state_root": "%s"}\n' "$1" > "$chat_guard_td/.mrw/workspace.json"
}
chat_guard_run() {
  chat_up_with_fake_docker "$chat_guard_td/.mrw" --ticket TST-1
}

chat_guard_ws_config "$chat_guard_td/state/tasks"
out="$(chat_guard_run)"
assert_status "chat-up.sh: refuses state_root ending in /tasks" 1 \
  bash -c "chat_up_with_fake_docker '$chat_guard_td/.mrw' --ticket TST-1 >/dev/null 2>&1"
assert_match "chat-up.sh: refusal names the tasks/ segment (ending in /tasks)" "tasks/' path segment" "$out"

chat_guard_ws_config "$chat_guard_td/state/tasks/nested"
out="$(chat_guard_run)"
assert_match "chat-up.sh: refusal names the tasks/ segment (mid-path)" "tasks/' path segment" "$out"

chat_guard_ws_config "$chat_guard_td/tasks"
out="$(chat_guard_run)"
assert_match "chat-up.sh: refusal fires when state_root itself is the tasks/ segment" "tasks/' path segment" "$out"

# SYMLINK case: the state_root path itself ("innocuous-name") contains no
# literal "tasks" substring at all — only resolving the symlink (which
# canonicalize_existing_prefix's `cd` + `pwd -P` does) reveals it points into
# a tasks/ tree. Before the canonicalize fix this would have sailed straight
# past the guard's string match; after it, it must refuse exactly like the
# direct cases above.
mkdir -p "$chat_guard_td/real/tasks/nested"
ln -s "$chat_guard_td/real/tasks/nested" "$chat_guard_td/innocuous-name"
chat_guard_ws_config "$chat_guard_td/innocuous-name"
out="$(chat_guard_run)"
assert_match "chat-up.sh: refuses a SYMLINKED state_root that resolves into tasks/ (canonicalized)" \
  "tasks/' path segment" "$out"

# Negative control: a substring match ("mytasksdir") must NOT trip the guard
# — it is not a path segment named exactly "tasks". With docker mocked as
# "down" (chat_up_with_fake_docker), the run now deterministically proceeds
# PAST the guard and fails at the stack-down check instead — a stronger
# assertion than merely "the guard message is absent".
chat_guard_ws_config "$chat_guard_td/mytasksdir"
out="$(chat_guard_run)"
guard_hit="$(printf '%s' "$out" | grep -oE "tasks/' path segment" || true)"
assert_eq "chat-up.sh: does NOT refuse a substring like 'mytasksdir' (guard is segment-exact)" "" "$guard_hit"
assert_match "chat-up.sh: 'mytasksdir' proceeds past the guard to the (mocked-down) stack check" \
  "devcontainer stack is not up" "$out"

rm -rf "$chat_guard_td"

# --- chat-up.sh: fails closed when the devcontainer stack is down ------------
chat_down_td="$(mktemp -d)"
mkdir -p "$chat_down_td/.mrw"
printf '{"state_root": "%s"}\n' "$chat_down_td/state" > "$chat_down_td/.mrw/workspace.json"

assert_status "chat-up.sh: fails closed (non-zero exit) when the stack is down" 1 \
  bash -c "chat_up_with_fake_docker '$chat_down_td/.mrw' --ticket TST-1 >/dev/null 2>&1"
down_out="$(chat_up_with_fake_docker "$chat_down_td/.mrw" --ticket TST-1)"
assert_match "chat-up.sh: names the stack-down reason and 'mrw infra-up' guidance" \
  "devcontainer stack is not up.*infra-up" "$down_out"

rm -rf "$chat_down_td"

# --- mrw chat: dispatch wiring (mrw-chat.md C3) -------------------------------
assert_status "cli/mrw.mjs: no shell:true anywhere (spawnSync must never shell out)" 1 \
  grep -qE 'shell:[[:space:]]*true' "$ROOT/cli/mrw.mjs"
assert_status "cli/mrw.mjs: 'chat' dispatches to scripts/chat-up.sh" 0 \
  grep -q 'runScript("chat-up.sh"' "$ROOT/cli/mrw.mjs"

# require_cmd docker (chat-up.sh's very first check) needs a real binary on
# PATH even for this "no --ticket" usage-message case — mocked for the same
# docker-less-host reason as the guard tests above.
chat_dispatch_out="$(cd "$ROOT" && PATH="$chat_fakebin:$PATH" node "$ROOT/cli/mrw.mjs" chat 2>&1)"
assert_match "mrw chat (no --ticket): reaches chat-up.sh's own usage message" \
  "usage: chat-up.sh --ticket" "$chat_dispatch_out"
assert_status "mrw chat (no --ticket): non-zero exit (propagated from chat-up.sh)" 1 \
  bash -c "cd '$ROOT' && PATH='$chat_fakebin:$PATH' node '$ROOT/cli/mrw.mjs' chat >/dev/null 2>&1"

assert_status "mrw task-up: prints the 'mrw chat' hint on success (source check)" 0 \
  grep -q 'Tip: chat with the spine' "$ROOT/cli/mrw.mjs"
task_help_out="$(cd "$ROOT" && node "$ROOT/cli/mrw.mjs" task-up --help 2>&1)"
assert_status "mrw task-up --help: exits zero" 0 \
  bash -c "cd '$ROOT' && node '$ROOT/cli/mrw.mjs' task-up --help >/dev/null 2>&1"
assert_match "mrw task-up --help: prints task-up usage" "task-up --ticket" "$task_help_out"
assert_status "mrw task-up --phase: missing value exits one" 1 \
  bash -c "cd '$ROOT' && node '$ROOT/cli/mrw.mjs' task-up --ticket ABC-1 --phase >/dev/null 2>&1"

rm -rf "$chat_fakebin"

# --- harness/test/*.test.ts (guarded: node:test suite, run ONLY if this ------
# host's harness/node_modules is actually runnable) --------------------------
# harness/node_modules is gitignored and populated by whichever environment last
# ran `npm ci` there — on a dev machine that's often the orchestrator CONTAINER
# (Linux), whose native esbuild binary (tsx's transform engine) silently fails
# every transform on a macOS/host node. `tsx --version` alone does NOT catch
# this: it prints and exits 0 without ever invoking esbuild's native binary
# (confirmed empirically while writing this guard). A trivial `tsx -e` DOES
# force one real transform, so it actually detects the mismatch — that's the
# check used here, not a bare `--version`.
HARNESS_DIR="$ROOT/harness"
HARNESS_TSX="$HARNESS_DIR/node_modules/.bin/tsx"
if [ -x "$HARNESS_TSX" ] \
  && "$HARNESS_TSX" --version >/dev/null 2>&1 \
  && "$HARNESS_TSX" -e 'process.exit(0)' >/dev/null 2>&1; then
  if (cd "$HARNESS_DIR" && npm test); then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL: %s\n' "harness npm test (see output above)" >&2
  fi
else
  echo "skipped: harness node_modules not runnable on this host; run npm test in the orchestrator container"
fi

echo ""
echo "passed: $PASS  failed: $FAIL"
[ "$FAIL" -eq 0 ]
