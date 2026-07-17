#!/usr/bin/env bash
# Shared helpers for workspace scripts.
# Bash 3.2 compatible (macOS default shell) — no associative arrays.

log()  { printf '%s\n' "$*" >&2; }
info() { printf '==> %s\n' "$*" >&2; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

# canonicalize_path <absolute-directory-path>
# Resolve symlinks in the longest existing prefix while preserving a not-yet-
# created suffix. This is intentionally portable to macOS's Bash 3.2 (whose
# realpath lacks GNU -m). Dot-dot in a missing suffix is rejected instead of
# being normalized across the trusted/untrusted prefix boundary.
canonicalize_path() {
  local p="${1:-}" parent suffix="" part physical
  case "$p" in
    /*) ;;
    *) die "path must be absolute (got '$p')" ;;
  esac
  while [ "$p" != "/" ] && [ "${p%/}" != "$p" ]; do p="${p%/}"; done
  [ -n "$p" ] || p="/"

  while [ ! -d "$p" ]; do
    [ "$p" != "/" ] || die "cannot canonicalize path '$1'"
    part="$(basename "$p")"
    case "$part" in
      ..) die "cannot canonicalize path with '..' in a missing suffix: '$1'" ;;
      .|'') ;;
      *) suffix="/$part$suffix" ;;
    esac
    parent="$(dirname "$p")"
    [ "$parent" != "$p" ] || die "cannot canonicalize path '$1'"
    p="$parent"
  done
  physical="$(cd "$p" 2>/dev/null && pwd -P)" \
    || die "cannot canonicalize path '$1'"
  if [ "$physical" = "/" ]; then printf '/%s' "${suffix#/}"; else printf '%s' "${physical%/}$suffix"; fi
}

reject_tasks_path() {
  case "$1" in
    */tasks|*/tasks/*) die "refusing config directory under a 'tasks/' path segment ($1)" ;;
  esac
}

validate_workspace_config() {
  local file="$1/workspace.json"
  [ -f "$file" ] || return 0
  require_cmd jq
  jq empty "$file" >/dev/null 2>&1 || die "invalid JSON in $file"
}

# Workspace root = parent of the scripts/ directory this file lives in.
workspace_root() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dirname "$(dirname "$lib_dir")"
}

# config_dir / config_mode — resolve the active config directory (holds
# workspace.json, repos.json, purposes/, broker-policy.json). Resolution
# priority, matching cli/mrw.mjs. The pre-push hook reads the setup-baked key
# with plain `git config --get` so gitdir includeIf rules are evaluated, first
# rejecting worker-writable local/worktree copies as tampering. It uses the
# same walk-up only as a compatibility fallback; a broken baked pointer fails
# closed, while a missing legacy config remains fail-open:
#   1. $MRW_CONFIG_DIR if set and non-empty.
#   2. the nearest ancestor .mrw/ directory (one that CONTAINS
#      workspace.json), found by walking UP from $PWD to /. Never picks
#      $HOME/.mrw or any other .mrw accidentally unless it really contains
#      workspace.json.
#   3. <toolHome>/config (legacy / single-workspace default).
# "workspace mode" = resolved via (1) or (2); "legacy mode" = resolved via
# (3). config_dir()/config_mode() are cheap (a single directory walk) — call
# them directly rather than caching, so a cwd change within the same shell
# (rare, but e.g. sourcing in a test) is always honored.
_config_resolve() {
  if [ -n "${MRW_CONFIG_DIR:-}" ]; then
    _CONFIG_DIR_RESULT="$(canonicalize_path "$MRW_CONFIG_DIR")"
    reject_tasks_path "$_CONFIG_DIR_RESULT"
  else
    local d="$PWD" _found=""
    while [ "$d" != "/" ]; do
      # SECURITY: never accept a .mrw/ inside worker-writable state
      # (state_root/tasks/**). A prompt-injected worker can COMMIT a
      # .mrw/workspace.json into its own worktree (which passes
      # push-create-pr.sh's porcelain check) to spoof the push-org/host
      # allowlist the pre-push hook reads. The legitimate per-workspace .mrw/
      # sits at the workspace root — a SIBLING of tasks/, with no `tasks` path
      # component — so skip any candidate under a tasks/ segment and keep
      # walking up to it. (Caveat: a workspace dir must not itself be named
      # `tasks` or live under a `tasks/` component.)
      case "$d" in
        */tasks|*/tasks/*) d="$(dirname "$d")"; continue ;;
      esac
      if [ -f "$d/.mrw/workspace.json" ]; then
        _found="$(canonicalize_path "$d/.mrw")"
        break
      fi
      d="$(dirname "$d")"
    done
    _CONFIG_DIR_RESULT="${_found:-$(canonicalize_path "$(workspace_root)/config")}"
  fi
  validate_workspace_config "$_CONFIG_DIR_RESULT"
  # Mode is determined by VALUE, not by which priority branch produced it: a
  # caller that explicitly sets MRW_CONFIG_DIR to exactly <toolHome>/config
  # (e.g. `mrw` always forwards its own resolved configDir to every script it
  # spawns — see cli/mrw.mjs's runScript) must still report "legacy" here, so
  # config_mode() AGREES with the mrw.mjs process that set it, whether or not
  # an env override was involved.
  if [ "$_CONFIG_DIR_RESULT" = "$(canonicalize_path "$(workspace_root)/config")" ]; then
    _CONFIG_MODE_RESULT="legacy"
  else
    _CONFIG_MODE_RESULT="workspace"
  fi
}

config_dir() {
  local _CONFIG_DIR_RESULT _CONFIG_MODE_RESULT
  _config_resolve
  printf '%s' "$_CONFIG_DIR_RESULT"
}

config_mode() {
  local _CONFIG_DIR_RESULT _CONFIG_MODE_RESULT
  _config_resolve
  printf '%s' "$_CONFIG_MODE_RESULT"
}

# config_base — the workspace base directory: workspace mode ⇒ dirname of the
# .mrw/ config_dir (the directory that HOLDS .mrw/); legacy mode ⇒
# workspace_root() (toolHome). This is state_root()'s default.
config_base() {
  local _CONFIG_DIR_RESULT _CONFIG_MODE_RESULT
  _config_resolve
  if [ "$_CONFIG_MODE_RESULT" = "workspace" ]; then
    canonicalize_path "$(dirname "$_CONFIG_DIR_RESULT")"
  else
    canonicalize_path "$(workspace_root)"
  fi
}

# compose_project_name — keep the historical Compose identity in legacy mode,
# while isolating containers and named volumes for each per-workspace config.
# Guarded captures: config_mode/config_base dying inside `$()`/`if` contexts
# would otherwise degrade to hashing the empty string ('mrw-e3b0c44298fc',
# exit 0) — a wrong-but-plausible project name aimed at nonexistent
# containers. Callers must ALSO use a split assignment
# (`VAR="$(compose_project_name)" || die; export VAR`) — `export VAR="$(…)"`
# masks the exit status (SC2155).
compose_project_name() {
  local mode base
  mode="$(config_mode)" || return $?
  if [ "$mode" = "legacy" ]; then
    printf 'mrw-phase0'
  else
    base="$(config_base)" || return $?
    printf 'mrw-%s' "$(printf '%s' "$base" | shasum -a 256 | cut -c1-12)"
  fi
}

# state_root — where repositories/ and tasks/ live. Configurable via
# `.state_root` in $(config_dir)/workspace.json; defaults to config_base()
# (== workspace_root() / toolHome in legacy mode) so the unconfigured,
# no-.mrw/ case is identical to the historical layout.
state_root() {
  local sr cdir
  cdir="$(config_dir)" || return $?
  sr="$(json_get "$cdir/workspace.json" '.state_root' '')" || return $?
  if [ -n "$sr" ]; then
    # Must be absolute: it is interpolated into container bind sources, git
    # worktree targets and sandbox paths, where a relative value would resolve
    # against the caller's cwd and silently misplace state.
    case "$sr" in
      /*) canonicalize_path "$sr" ;;
      *)  die "$cdir/workspace.json .state_root must be an absolute path (got '$sr')" ;;
    esac
  else
    canonicalize_path "$(config_base)"
  fi
}

# to_home_path <abs-path>
# Rewrite an absolute path under $HOME to its ~/ form. Paths written into
# sandbox excludedCommands / Bash allow rules and the matching call sites in
# generated CLAUDE.md MUST byte-match, and the ~/ form is the canonical one.
to_home_path() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# sed_escape <text> — escape for use in a sed replacement with '|' delimiter.
# Placeholders are single-line by contract, so a stray newline in a value
# (e.g. a pasted multi-line --title) is flattened to a space rather than
# aborting render_template with a sed syntax error mid-scaffold.
sed_escape() {
  printf '%s' "$1" | tr '\n' ' ' | sed -e 's/[&\\|]/\\&/g'
}

# validate_ticket_id <id> — die unless <id> matches ticket_id_pattern and is
# free of path-traversal characters. Ticket ids are interpolated into
# filesystem paths (TASK_DIR, worktree targets, settings paths), so this is a
# security boundary: every entry script that takes a ticket id MUST call it.
validate_ticket_id() {
  local id="$1" pattern nl
  nl='
'
  case "$id" in
    "")      die "ticket id is empty" ;;
    */*)     die "invalid ticket id '$id': must not contain '/'" ;;
    *..*)    die "invalid ticket id '$id': must not contain '..'" ;;
    *"$nl"*) die "invalid ticket id '$id': must not contain newlines" ;;
  esac
  pattern="$(json_get "$(config_dir)/workspace.json" '.ticket_id_pattern' '^[A-Z]+-[A-Za-z0-9_-]+$')"
  printf '%s' "$id" | grep -qE "$pattern" \
    || die "ticket id '$id' does not match $pattern (the prefix is required and never auto-added)"
}

# render_template <template-file>
# Substitute {{PLACEHOLDER}} tokens from the corresponding environment
# variables (empty if unset). Output to stdout. Substitution happens at
# runtime only — templates committed to the repo never contain real paths.
#
# The MODEL.../CONTAINER_*/SPINE_STATE_DIR placeholders below were added for
# templates/chat-frontend/ (mrw-chat.md Phase C3): even though those values
# are CONTAINER-fixed constants (same string for every ticket, unlike
# STATE_ROOT/TASK_DIR which vary per host install), they are still rendered
# through placeholders rather than hardcoded in the template files — the same
# "templates never contain absolute paths" discipline every other template in
# this repo already follows (e.g. task-worker/claude-settings.json templates
# WORKSPACE_ROOT even though, for that agent, it too never actually varies
# within one render). Adding new placeholders here is additive and safe: a
# template that doesn't reference a given token is unaffected (sed no-ops).
render_template() {
  local tpl="$1"
  [ -f "$tpl" ] || die "template not found: $tpl"
  local out
  out="$(sed \
    -e "s|{{WORKSPACE_ROOT}}|$(sed_escape "${WORKSPACE_ROOT:-}")|g" \
    -e "s|{{STATE_ROOT}}|$(sed_escape "${STATE_ROOT:-}")|g" \
    -e "s|{{CONFIG_DIR}}|$(sed_escape "${CONFIG_DIR:-}")|g" \
    -e "s|{{TASK_DIR}}|$(sed_escape "${TASK_DIR:-}")|g" \
    -e "s|{{TASK_DIR_H}}|$(sed_escape "${TASK_DIR_H:-}")|g" \
    -e "s|{{TICKET_ID}}|$(sed_escape "${TICKET_ID:-}")|g" \
    -e "s|{{PURPOSE}}|$(sed_escape "${PURPOSE:-}")|g" \
    -e "s|{{TITLE}}|$(sed_escape "${TITLE:-}")|g" \
    -e "s|{{TICKET_URL}}|$(sed_escape "${TICKET_URL:-}")|g" \
    -e "s|{{BRANCH}}|$(sed_escape "${BRANCH:-}")|g" \
    -e "s|{{REPOS_LIST}}|$(sed_escape "${REPOS_LIST:-}")|g" \
    -e "s|{{MODEL}}|$(sed_escape "${MODEL:-}")|g" \
    -e "s|{{WORK_TYPE}}|$(sed_escape "${WORK_TYPE:-}")|g" \
    -e "s|{{REPOS_CSV}}|$(sed_escape "${REPOS_CSV:-}")|g" \
    -e "s|{{REPOS_BLOCK}}|$(sed_escape "${REPOS_BLOCK:-}")|g" \
    -e "s|{{CLAUDE_MD_EXCLUDES_JSON}}|$(sed_escape "${CLAUDE_MD_EXCLUDES_JSON:-}")|g" \
    -e "s|{{HARNESS_RUN_DIR}}|$(sed_escape "${HARNESS_RUN_DIR:-}")|g" \
    -e "s|{{CONTAINER_WORKSPACE_ROOT}}|$(sed_escape "${CONTAINER_WORKSPACE_ROOT:-}")|g" \
    -e "s|{{SPINE_STATE_DIR}}|$(sed_escape "${SPINE_STATE_DIR:-}")|g" \
    -e "s|{{MCP_TOOL_TIMEOUT_MS}}|$(sed_escape "${MCP_TOOL_TIMEOUT_MS:-}")|g" \
    "$tpl")"
  # Catch typo'd or newly-added-but-unwired placeholders before they ship
  # verbatim into a generated settings/CLAUDE file.
  local residual
  residual="$(printf '%s' "$out" | grep -oE '\{\{[A-Z_]+\}\}' | sort -u | tr '\n' ' ' || true)"
  [ -n "$residual" ] && warn "render_template: unresolved placeholder(s) in $(basename "$tpl"): $residual"
  printf '%s\n' "$out"
}

# template_for <relative-file> <purpose> [dev_kind]
# Resolve a template path with override precedence:
#   templates/purposes/<purpose>/kinds/<kind>/<file>
#   templates/purposes/<purpose>/<file>
#   templates/default/<file>
# Echoes the first existing path; fails if none exist.
template_for() {
  local file="$1" purpose="$2" kind="${3:-}" root
  root="$(workspace_root)"
  if [ -n "$kind" ] && [ -f "$root/templates/purposes/$purpose/kinds/$kind/$file" ]; then
    printf '%s' "$root/templates/purposes/$purpose/kinds/$kind/$file"
  elif [ -f "$root/templates/purposes/$purpose/$file" ]; then
    printf '%s' "$root/templates/purposes/$purpose/$file"
  elif [ -f "$root/templates/default/$file" ]; then
    printf '%s' "$root/templates/default/$file"
  else
    die "no template found for '$file' (purpose=$purpose kind=$kind)"
  fi
}

# json_get <file> <jq-filter> [default]
json_get() {
  local file="$1" filter="$2" default="${3:-}"
  local out
  require_cmd jq
  [ -f "$file" ] || { printf '%s' "$default"; return 0; }
  jq empty "$file" >/dev/null 2>&1 || die "invalid JSON in $file"
  out="$(jq -r "$filter // empty" "$file")" || die "failed to read JSON from $file"
  if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' "$default"; fi
}

# list_purposes — names of available purposes ($(config_dir)/purposes/*.json).
list_purposes() {
  local cdir
  cdir="$(config_dir)"
  ls "$cdir/purposes/" 2>/dev/null | sed -n 's/\.json$//p'
}

# repo_field <repo-name> <field> — look up a field in $(config_dir)/repos.json.
repo_field() {
  local cdir
  cdir="$(config_dir)"
  jq -r --arg n "$1" --arg f "$2" \
    '.repositories[] | select(.name == $n) | .[$f] // empty' \
    "$cdir/repos.json"
}
