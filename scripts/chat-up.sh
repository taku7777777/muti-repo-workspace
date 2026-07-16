#!/usr/bin/env bash
# chat-up.sh — `mrw chat` launcher (host side).
#
# docs/mrw-chat.md Phase C3 "Wiring": renders the generated Claude Code
# frontend config for one ticket's spine session into STATE_ROOT/chat/<T>/,
# runs the in-container "prepare" step (worktrees + a freshly-seeded ledger —
# spined itself only ever LOADS an already-seeded ledger, see
# harness/src/spined/index.ts's header), stamps directory trust so the first
# launch never stalls on a trust dialog, then opens an interactive `claude`
# session inside the orchestrator container (cmux tab if available, else the
# command is printed for the operator to run themselves).
#
# CONTAINER-ONLY, deliberately: the generated settings.json's deny posture is
# the ONLY cage for a natively-run session (no squid, no :ro mounts) — this
# design never claims that is safe (docs/mrw-chat.md "Wiring"), so this
# script refuses outright when the devcontainer stack is not up.
#
# Usage:
#   scripts/chat-up.sh --ticket <ID> [--repos a,b] [--purpose p] [--resume] [instruction words...]
#   scripts/chat-up.sh <ID> [...]                 # bare positional == --ticket
#
# --resume: reopen the SAME rendered chat dir with `claude --continue`
# instead of re-rendering/re-preparing — the ledger and Claude Code's own
# conversation history are already on disk (docs/mrw-chat.md: "resume =
# --continue in the same directory"). Without --resume, re-running this
# against a ticket that already has a seeded ledger is refused by
# `spine-prepare` itself (it never reseeds without an explicit --force, which
# this launcher never passes — see the prepare step below); pass --resume
# instead of retrying.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/effects/cmux.sh
. "$SCRIPT_DIR/lib/effects/cmux.sh"

require_cmd docker
require_cmd jq

WORKSPACE_ROOT="$(workspace_root)"
COMPOSE_FILE="$WORKSPACE_ROOT/.devcontainer/docker-compose.yml"

# --- container-side constants ------------------------------------------------
# Fixed by docker-compose.yml / coder.Dockerfile's own topology — the SAME
# string for every ticket and every host install (unlike WORKSPACE_ROOT/
# STATE_ROOT, which are host-install-specific). Still routed through
# render_template's placeholders rather than hardcoded in the templates
# themselves (see common.sh's render_template header) — these bash constants
# are simply where those placeholders' VALUES come from at render time.
CONTAINER_WS="/workspaces/muti-repo-workspace"
CONTAINER_HARNESS_RUN="/home/node/harness-run"
CONTAINER_SPINE_STATE_DIR="/var/mrw/notes"
CONTAINER_CHAT_HOME="/var/mrw/chat-home"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

# ---------------------------------------------------------------------------
# argv
TICKET_ID=""
REPOS_ARG=""
PURPOSE_ARG=""
RESUME=false
INSTRUCTION_ARGS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --ticket)  TICKET_ID="${2:?--ticket requires a value}"; shift 2 ;;
    --repos)   REPOS_ARG="${2:?--repos requires a value}"; shift 2 ;;
    --purpose) PURPOSE_ARG="${2:?--purpose requires a value}"; shift 2 ;;
    --resume)  RESUME=true; shift ;;
    -h|--help) sed -n '2,26p' "$0"; exit 0 ;;
    --)
      shift
      INSTRUCTION_ARGS+=("$@")
      break
      ;;
    -*) die "unknown argument: $1" ;;
    *)
      if [ -z "$TICKET_ID" ]; then
        TICKET_ID="$1"
      else
        INSTRUCTION_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

[ -n "$TICKET_ID" ] \
  || die "usage: chat-up.sh --ticket <ID> [--repos a,b] [--purpose p] [--resume] [instruction words...]"
validate_ticket_id "$TICKET_ID"

STATE_ROOT="$(state_root)"
CONFIG_DIR="$(config_dir)"
WS_CONFIG="$CONFIG_DIR/workspace.json"

# ---------------------------------------------------------------------------
# canonicalize_existing_prefix <path> — resolve symlinks in the LONGEST
# EXISTING prefix of <path> (via `cd` + `pwd -P`; portable — BSD/macOS
# `realpath` has no -m/--canonicalize-missing, only GNU's does, and this repo
# targets bash-3.2/macOS as a first-class host — see common.sh's header),
# then re-append whatever suffix doesn't exist yet LITERALLY (a ticket's
# chat/<TICKET_ID> leaf never exists before this script creates it).
# SECURITY: this MUST run before the tasks/-segment guard below — a
# state_root that IS (or resolves THROUGH) a symlink into a `tasks/` tree
# would otherwise sail past a naive string match on the un-resolved path
# (the same non-canonicalized-path class an earlier branch review flagged
# elsewhere in this repo — do not reintroduce it here).
canonicalize_existing_prefix() {
  # NOTE: `existing` is deliberately a SEPARATE `local` statement from
  # `path` below it, not `local path="$1" existing="$path"` on one line —
  # under `set -u`, bash expands every RHS on a `local` line (to build the
  # assignment list) BEFORE any of that line's assignments actually take
  # effect, so `existing="$path"` on the SAME line as `path="$1"` would read
  # `path` while it is still unset (bash-3.2-reproducible; do not merge
  # these back into one statement).
  local path="$1" suffix="" resolved
  local existing="$path"
  while [ ! -e "$existing" ] && [ "$existing" != "/" ] && [ -n "$existing" ]; do
    suffix="/$(basename "$existing")$suffix"
    existing="$(dirname "$existing")"
  done
  resolved="$(cd "$existing" 2>/dev/null && pwd -P)" || resolved="$existing"
  printf '%s%s' "$resolved" "$suffix"
}

CHAT_DIR="$(canonicalize_existing_prefix "$STATE_ROOT/chat/$TICKET_ID")"
CONTAINER_CHAT_DIR="$CONTAINER_WS/chat/$TICKET_ID"

# ---------------------------------------------------------------------------
# SECURITY: refuse to render the chat frontend config under a worker-writable
# `tasks/` path segment. Same guard class as `mrw init`
# (cli/mrw.mjs's underTasksSegment) and common.sh's own config_dir() walk-up
# (`_config_resolve`'s `*/tasks|*/tasks/*` case). docs/mrw-chat.md: ".mcp.json
# is a command line the frontend will spawn inside the orchestrator
# container, and settings.json carries the whole deny posture — if either
# were worker-writable, a compromised worker could strip the posture or run
# code in the orchestrator container." Checked on the FULL resolved
# (canonicalized, see above) chat dir — not just STATE_ROOT alone — so a
# state_root that itself already contains a `tasks` segment (directly OR via
# a symlink) is caught too — every path built under it inherits that segment.
refuse_if_under_tasks_segment() {
  local d="$1"
  case "$d" in
    */tasks|*/tasks/*)
      die "refusing to render the chat frontend config under a 'tasks/' path segment ($d) — that tree is worker-writable and must never hold the deny-posture settings.json / .mcp.json spawn command (docs/mrw-chat.md's render-target guard). Check $(config_dir)/workspace.json's .state_root."
      ;;
  esac
}
refuse_if_under_tasks_segment "$CHAT_DIR"

# ---------------------------------------------------------------------------
# CONTAINER-ONLY: refuse fail-closed when the stack isn't up. `orchestrator`
# has no healthcheck of its own (it idles on `sleep infinity` after preparing
# the container-local harness copy — see docker-compose.yml), so "running" is
# the right (and only) signal here, not "healthy".
_orch_running="$(dc ps --status running -q orchestrator 2>/dev/null || true)"
if [ -z "$_orch_running" ]; then
  die "the devcontainer stack is not up (the 'orchestrator' container is not running) — 'mrw chat' is container-only (docs/mrw-chat.md: the deny-rule posture is the only cage, and this design never claims that is safe on a native run). Run 'mrw infra-up' first, then retry."
fi

if $RESUME; then
  [ -f "$CHAT_DIR/.claude/settings.json" ] \
    || die "--resume: no rendered chat config at $CHAT_DIR/.claude/settings.json — run 'mrw chat $TICKET_ID' first (without --resume)."
  info "Resuming chat for $TICKET_ID (reusing the existing rendered config at $CHAT_DIR — not re-rendering, not re-preparing)."
else
  # --- resolve repos / purpose / model / work_type for this render ---------
  REPOS_CSV=""
  if [ -n "$REPOS_ARG" ]; then
    REPOS_CSV="$(printf '%s' "$REPOS_ARG" | tr -d ' ')"
    for r in $(printf '%s' "$REPOS_CSV" | tr ',' ' '); do
      [ -n "$(repo_field "$r" name)" ] || die "repository '$r' is not defined in $CONFIG_DIR/repos.json"
    done
  else
    REPOS_CSV="$(jq -r '[.repositories[].name] | join(",")' "$CONFIG_DIR/repos.json")"
  fi
  [ -n "$REPOS_CSV" ] \
    || die "no repositories configured in $CONFIG_DIR/repos.json — 'mrw chat' needs at least one (pass --repos, or add one to repos.json)"

  PURPOSE="${PURPOSE_ARG:-$(json_get "$WS_CONFIG" '.default_purpose' 'dev')}"
  BRANCH_PREFIX="$(json_get "$WS_CONFIG" '.branch_prefix' 'feat/')"
  BRANCH="${BRANCH_PREFIX}${TICKET_ID}"
  MODEL="${HARNESS_MODEL:-sonnet}"
  WORK_TYPE="${MRW_WORK_TYPE:-feature}"

  # MCP_TIMEOUT/MCP_TOOL_TIMEOUT must stay ABOVE the worker step budget
  # (harness/src/workerd/index.ts's WORKERD_STEP_TIMEOUT_MS, default 45min =
  # 2_700_000ms) or a long run_worker gets client-aborted while the daemon is
  # still busy. 3_600_000 (60min) is a safe flat default for that default —
  # but if the OPERATOR raises WORKERD_STEP_TIMEOUT_MS past 50min the flat
  # constant would no longer clear it, so derive from the SAME host env var
  # (mirroring MODEL/HARNESS_MODEL above) with a 10min margin when it is set.
  # CAVEAT (documented, not silently assumed): WORKERD_STEP_TIMEOUT_MS is
  # NOT currently forwarded into the worker service's compose environment
  # (.devcontainer/docker-compose.yml) — an operator override here only
  # changes what THIS render computes unless they also export it before
  # `docker compose up` for the worker to actually honor it.
  if [ -n "${WORKERD_STEP_TIMEOUT_MS:-}" ]; then
    MCP_TOOL_TIMEOUT_MS=$((WORKERD_STEP_TIMEOUT_MS + 600000))
  else
    MCP_TOOL_TIMEOUT_MS=3600000
  fi

  # REPOS_BLOCK / CLAUDE_MD_EXCLUDES_JSON: one entry per repo. render_template
  # flattens embedded newlines to spaces by contract (see common.sh's
  # sed_escape) — the same single-line-value discipline task-orchestrator's
  # own REPOS_LIST already lives under — so REPOS_BLOCK entries are
  # ';'-joined rather than newline-joined bullets.
  REPOS_BLOCK=""
  CLAUDE_MD_EXCLUDES_JSON=""
  _first=true
  for r in $(printf '%s' "$REPOS_CSV" | tr ',' ' '); do
    wt="$CONTAINER_WS/tasks/$TICKET_ID/repositories/$r"
    if $_first; then
      REPOS_BLOCK="\`$r\` (worktree: $wt)"
      CLAUDE_MD_EXCLUDES_JSON="$(jq -Rn --arg p "$wt" '$p')"
      _first=false
    else
      REPOS_BLOCK="$REPOS_BLOCK; \`$r\` (worktree: $wt)"
      CLAUDE_MD_EXCLUDES_JSON="$CLAUDE_MD_EXCLUDES_JSON, $(jq -Rn --arg p "$wt" '$p')"
    fi
  done

  export WORKSPACE_ROOT STATE_ROOT TICKET_ID PURPOSE BRANCH MODEL WORK_TYPE
  export REPOS_CSV REPOS_BLOCK CLAUDE_MD_EXCLUDES_JSON MCP_TOOL_TIMEOUT_MS
  export HARNESS_RUN_DIR="$CONTAINER_HARNESS_RUN"
  export CONTAINER_WORKSPACE_ROOT="$CONTAINER_WS"
  export SPINE_STATE_DIR="$CONTAINER_SPINE_STATE_DIR"

  # settings.json MUST land at <cwd>/.claude/settings.json — Claude Code
  # reads PROJECT settings from that path, never a bare <cwd>/settings.json
  # (repo precedent: create-workspace.sh installs every agent's settings to
  # agents/*/.claude/settings.json, never agents/*/settings.json). CLAUDE.md
  # and .mcp.json DO belong at the cwd root (same precedent).
  #
  # LIVE FINDING (2026-07-16 re-verify): a stdio MCP server's `env` block in
  # .mcp.json REPLACES the child process's environment — it is NOT merged
  # with the `claude` parent's own inherited env (confirmed empirically:
  # `claude mcp list` reported "Failed to connect" for spine until the
  # credential env vars below were added, even though the orchestrator
  # container itself plainly has one — spined's own fail-closed credential
  # guard was firing silently inside the spawned MCP subprocess). The
  # template's `${ANTHROPIC_API_KEY}`/`${CLAUDE_CODE_OAUTH_TOKEN}` entries
  # are Claude Code's own env-var interpolation syntax for .mcp.json (NOT
  # render_template's {{PLACEHOLDER}} substitution — these stay LITERAL
  # through render_template, unresolved until the `claude` CLI itself spawns
  # spined) — resolved from the CLI's OWN process env at spawn time, so no
  # secret value is ever written to disk here; whichever ONE the operator
  # actually set resolves, the other is reported as a harmless "missing" MCP
  # config warning (same "set exactly one" contract as docker-compose.yml's
  # own CLAUDE_CODE_OAUTH_TOKEN/ANTHROPIC_API_KEY null-passthrough).
  info "Rendering chat frontend config for $TICKET_ID into $CHAT_DIR (repos: $REPOS_CSV, purpose: $PURPOSE)"
  mkdir -p "$CHAT_DIR/.claude"
  render_template "$WORKSPACE_ROOT/templates/chat-frontend/settings.json" > "$CHAT_DIR/.claude/settings.json"
  render_template "$WORKSPACE_ROOT/templates/chat-frontend/CLAUDE.md" > "$CHAT_DIR/CLAUDE.md"
  render_template "$WORKSPACE_ROOT/templates/chat-frontend/.mcp.json" > "$CHAT_DIR/.mcp.json"

  # --- prepare (in-container): worktrees + a freshly-seeded ledger ---------
  # `--force` is deliberately NEVER passed — spine-prepare itself refuses to
  # reseed an existing ledger (harness/src/spined/prepare.ts's own guard);
  # re-running this against a prepared ticket is expected to fail with its
  # guidance to use --resume instead, not to silently wipe budgets/baseSha.
  #
  # tsx invoked DIRECTLY (not `npm run`) — same reasoning as .mcp.json's own
  # spined spawn (a wrapper's own stdout banner is a hazard for a stdio MCP
  # server; here it's merely one fewer process layer + one fewer way for an
  # `npm run` script-name mismatch to surface as a confusing failure).
  info "Running spine-prepare in the orchestrator container..."
  prepare_args=(--ticket "$TICKET_ID" --repos "$REPOS_CSV" --purpose "$PURPOSE")
  # Bash 3.2 (macOS default — see common.sh's own header) treats
  # "${arr[@]}" on a DECLARED-BUT-EMPTY array as an unbound-variable error
  # under `set -u`, even though the array itself was initialized (`arr=()`).
  # Guard the expansion on length instead of expanding directly.
  if [ ${#INSTRUCTION_ARGS[@]} -gt 0 ]; then
    prepare_args+=("${INSTRUCTION_ARGS[@]}")
  fi
  if ! dc exec -T orchestrator \
    "$CONTAINER_HARNESS_RUN/node_modules/.bin/tsx" "$CONTAINER_HARNESS_RUN/src/spined/prepare.ts" \
    "${prepare_args[@]}"; then
    # A partially-rendered (never-prepared) chat dir is worse than none: a
    # later `--resume` would find `-d "$CHAT_DIR"` true and happily open a
    # session against a ticket with NO ledger — spined's own startup would
    # then fail, but only after the human is already mid-session. Fail
    # closed here instead: remove the render so --resume's own existence
    # check (below, next invocation) correctly refuses and points back at a
    # plain (non-resume) retry.
    rm -rf "$CHAT_DIR"
    die "spine-prepare failed — removed the incomplete render at $CHAT_DIR (see the prepare output above for the cause; re-run 'mrw chat $TICKET_ID' once it's fixed — NOT --resume, nothing was prepared)."
  fi
fi

# ---------------------------------------------------------------------------
# Trust stamp: projects[<dir>].hasTrustDialogAccepted = true, inside
# CLAUDE_CONFIG_DIR's claude.json — same jq-merge shape the open-task
# skill's own trust step uses for ~/.claude.json (.claude/skills/open-task/
# SKILL.md Step 6.5), just against the chat-home volume's copy instead. jq is
# already a hard dependency of this whole toolchain (common.sh's json_get et
# al.), so this reuses it rather than adding a `node -e` dependency. Always
# run (fresh render AND --resume): cheap, idempotent, and guarantees trust
# even the first time this exact ticket path is launched.
#
# TWO keys are stamped, not one (LIVE FINDING, 2026-07-16 re-verify): Claude
# Code treats `permissions.additionalDirectories` (CONTAINER_WORKSPACE_ROOT —
# see templates/chat-frontend/settings.json) as its OWN separate trust
# boundary, distinct from the cwd's. Leaving it unstamped doesn't just skip
# the Read auto-approval that entry exists for — confirmed empirically that
# it ALSO makes the CLI silently drop the UNRELATED `permissions.allow:
# ["mcp__spine__*"]` entry ("Ignoring 1 permissions.allow entry ... this
# workspace has not been trusted"), which would otherwise look exactly like
# an MCP wiring bug rather than a trust gap.
info "Stamping directory trust for $CONTAINER_CHAT_DIR and $CONTAINER_WS ..."
dc exec -T \
  -e CLAUDE_CONFIG_DIR="$CONTAINER_CHAT_HOME" \
  -e MRW_CHAT_PROJECT_KEY="$CONTAINER_CHAT_DIR" \
  -e MRW_CHAT_ADDL_DIR_KEY="$CONTAINER_WS" \
  orchestrator sh -lc '
    f="$CLAUDE_CONFIG_DIR/.claude.json"
    [ -f "$f" ] || printf "%s" "{}" > "$f"
    tmp="$(mktemp)"
    jq --arg p "$MRW_CHAT_PROJECT_KEY" --arg a "$MRW_CHAT_ADDL_DIR_KEY" \
      ".projects[\$p] = ((.projects[\$p] // {}) + {hasTrustDialogAccepted: true})
       | .projects[\$a] = ((.projects[\$a] // {}) + {hasTrustDialogAccepted: true})" \
      "$f" > "$tmp" && mv "$tmp" "$f"
  '

# ---------------------------------------------------------------------------
# Open the session. cmux (if available) gets its own tab, reusing an existing
# workspace named after the ticket (e.g. one /open-task already created) —
# same lookup create-workspace.sh's own phase_cmux uses
# (cmux_workspace_uuid_by_name). Degrades to printing (and, on macOS,
# clipboard-copying) the command when cmux is absent — same fallback shape as
# create-workspace.sh's own worker/orchestrator startup.
CHAT_CMD_PRINTABLE="docker compose -f $(printf '%q' "$COMPOSE_FILE") exec -it -e CLAUDE_CONFIG_DIR=$CONTAINER_CHAT_HOME -w $(printf '%q' "$CONTAINER_CHAT_DIR") orchestrator claude"
if $RESUME; then
  CHAT_CMD_PRINTABLE="$CHAT_CMD_PRINTABLE --continue"
fi

if cmux_available; then
  ws="$(cmux_workspace_uuid_by_name "$TICKET_ID")"
  if [ -z "$ws" ]; then
    info "Creating a cmux workspace '$TICKET_ID' for the chat session"
    ws="$(cmux_new_workspace "$TICKET_ID" "$WORKSPACE_ROOT" "$CHAT_CMD_PRINTABLE")" \
      || die "failed to create a cmux workspace for the chat session"
    chat_surface="$(cmux_first_surface_uuid "$ws")" || die "could not resolve the chat surface UUID"
    cmux_rename_tab "$ws" "$chat_surface" "Chat"
  else
    info "Adding a 'Chat' tab to the existing cmux workspace '$TICKET_ID'"
    chat_surface="$(cmux_new_tab "$ws" "Chat")" \
      || die "failed to create a chat tab in cmux workspace $ws"
    cmux_send_line "$ws" "$chat_surface" "$CHAT_CMD_PRINTABLE"
  fi
  info "cmux tab ready — focus workspace '$TICKET_ID' to use the chat."
else
  warn "cmux not available — run this yourself:"
  log ""
  log "  $CHAT_CMD_PRINTABLE"
  log ""
  if command -v pbcopy >/dev/null 2>&1; then
    printf '%s' "$CHAT_CMD_PRINTABLE" | pbcopy
    log "(command copied to clipboard)"
  fi
fi
