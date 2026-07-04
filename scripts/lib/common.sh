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

# Workspace root = parent of the scripts/ directory this file lives in.
workspace_root() {
  local lib_dir
  lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  dirname "$(dirname "$lib_dir")"
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
  pattern="$(json_get "$(workspace_root)/config/workspace.json" '.ticket_id_pattern' '^[A-Z]+-[A-Za-z0-9_-]+$')"
  printf '%s' "$id" | grep -qE "$pattern" \
    || die "ticket id '$id' does not match $pattern (the prefix is required and never auto-added)"
}

# render_template <template-file>
# Substitute {{PLACEHOLDER}} tokens from the corresponding environment
# variables (empty if unset). Output to stdout. Substitution happens at
# runtime only — templates committed to the repo never contain real paths.
render_template() {
  local tpl="$1"
  [ -f "$tpl" ] || die "template not found: $tpl"
  local out
  out="$(sed \
    -e "s|{{WORKSPACE_ROOT}}|$(sed_escape "${WORKSPACE_ROOT:-}")|g" \
    -e "s|{{TASK_DIR}}|$(sed_escape "${TASK_DIR:-}")|g" \
    -e "s|{{TASK_DIR_H}}|$(sed_escape "${TASK_DIR_H:-}")|g" \
    -e "s|{{TICKET_ID}}|$(sed_escape "${TICKET_ID:-}")|g" \
    -e "s|{{PURPOSE}}|$(sed_escape "${PURPOSE:-}")|g" \
    -e "s|{{TITLE}}|$(sed_escape "${TITLE:-}")|g" \
    -e "s|{{TICKET_URL}}|$(sed_escape "${TICKET_URL:-}")|g" \
    -e "s|{{BRANCH}}|$(sed_escape "${BRANCH:-}")|g" \
    -e "s|{{REPOS_LIST}}|$(sed_escape "${REPOS_LIST:-}")|g" \
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
  out="$(jq -r "$filter // empty" "$file" 2>/dev/null || true)"
  if [ -n "$out" ]; then printf '%s' "$out"; else printf '%s' "$default"; fi
}

# list_purposes — names of available purposes (config/purposes/*.json).
list_purposes() {
  local root
  root="$(workspace_root)"
  ls "$root/config/purposes/" 2>/dev/null | sed -n 's/\.json$//p'
}

# repo_field <repo-name> <field> — look up a field in config/repos.json.
repo_field() {
  local root
  root="$(workspace_root)"
  jq -r --arg n "$1" --arg f "$2" \
    '.repositories[] | select(.name == $n) | .[$f] // empty' \
    "$root/config/repos.json"
}
