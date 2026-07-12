#!/usr/bin/env bash
# create-workspace.sh — create a per-ticket task workspace (/open-task backend).
#
# Three phases (run in order; each is idempotent):
#   --phase init      Validate inputs, scaffold tasks/<TICKET>/, save
#                     .workspace-meta.json. Fast, no side effects elsewhere.
#   --phase finalize  Generate everything on disk: worktrees (unless
#                     --skip-worktrees — the /open-task skill creates them via
#                     Claude), docs, agent dirs, settings, per-task skills.
#   --phase cmux      Create the cmux workspace (3 tabs), pin .worker-target,
#                     start both Claude sessions. Run AFTER trust is set up so
#                     the worker's first boot honors permissions.allow. Skips
#                     creation if a workspace of the same name is already open.
#   --phase all       init + finalize + cmux (scripted use).
#
# init and finalize are idempotent (safe to re-run). cmux is guarded, not
# idempotent: it refuses to create a second workspace for a live ticket.
#
# Usage:
#   create-workspace.sh --ticket <ID> [--purpose <p>] [--dev-kind <k>]
#       [--repos "a,b,c"] [--title <t>] [--ticket-url <u>]
#       [--phase init|finalize|cmux|all] [--no-sandbox] [--skip-worktrees] [--yes]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"
# shellcheck source=lib/effects/cmux.sh
. "$SCRIPT_DIR/lib/effects/cmux.sh"
# shellcheck source=lib/effects/worktree.sh
. "$SCRIPT_DIR/lib/effects/worktree.sh"

require_cmd git
require_cmd jq

WORKSPACE_ROOT="$(workspace_root)"
WS_CONFIG="$WORKSPACE_ROOT/config/workspace.json"

TICKET_ID=""
PURPOSE=""
DEV_KIND=""
REPOS_ARG=""
TITLE=""
TICKET_URL=""
PHASE="all"
SANDBOX=true
SKIP_WORKTREES=false
AUTO_YES=false

while [ $# -gt 0 ]; do
  case "$1" in
    --ticket)      TICKET_ID="${2:?}"; shift 2 ;;
    --purpose)     PURPOSE="${2:?}"; shift 2 ;;
    --dev-kind)    DEV_KIND="${2:?}"; shift 2 ;;
    --repos)       REPOS_ARG="${2:?}"; shift 2 ;;
    --title)       TITLE="${2:?}"; shift 2 ;;
    --ticket-url)  TICKET_URL="${2:?}"; shift 2 ;;
    --phase)       PHASE="${2:?}"; shift 2 ;;
    --no-sandbox)  SANDBOX=false; shift ;;
    --sandbox)     SANDBOX=true; shift ;;
    --skip-worktrees) SKIP_WORKTREES=true; shift ;;
    --yes)         AUTO_YES=true; shift ;;
    -h|--help)     sed -n '2,20p' "$0"; exit 0 ;;
    *) die "unknown argument: $1 (note: there is no --preset; pass the final repo list via --repos)" ;;
  esac
done

[ -n "$TICKET_ID" ] || die "--ticket is required"
validate_ticket_id "$TICKET_ID"

TASK_DIR="$WORKSPACE_ROOT/tasks/$TICKET_ID"
META="$TASK_DIR/.workspace-meta.json"
BRANCH_PREFIX="$(json_get "$WS_CONFIG" '.branch_prefix' 'feat/')"
BRANCH="${BRANCH_PREFIX}${TICKET_ID}"
TASK_DIR_H="$(to_home_path "$TASK_DIR")"
export WORKSPACE_ROOT TASK_DIR TASK_DIR_H TICKET_ID BRANCH TITLE TICKET_URL

# ---------------------------------------------------------------------------
phase_init() {
  # purpose
  if [ -z "$PURPOSE" ]; then
    PURPOSE="$(json_get "$WS_CONFIG" '.default_purpose' 'dev')"
  fi
  list_purposes | grep -qx "$PURPOSE" \
    || die "unknown purpose '$PURPOSE' (available: $(list_purposes | tr '\n' ' '))"
  PURPOSE_JSON="$WORKSPACE_ROOT/config/purposes/$PURPOSE.json"

  # dev_kind
  if [ -n "$DEV_KIND" ]; then
    jq -e --arg k "$DEV_KIND" '.dev_kinds // [] | index($k)' "$PURPOSE_JSON" >/dev/null \
      || die "dev-kind '$DEV_KIND' is not defined for purpose '$PURPOSE'"
  fi

  # repos: explicit --repos wins; otherwise the purpose's default_repos apply
  # (in scripted mode too — deliberate difference from the v2 origin, where
  # defaults only applied interactively).
  local repos
  if [ -n "$REPOS_ARG" ]; then
    repos="$(printf '%s' "$REPOS_ARG" | tr ',' ' ')"
  else
    repos="$(jq -r '.default_repos // [] | join(" ")' "$PURPOSE_JSON")"
  fi
  local r
  for r in $repos; do
    [ -n "$(repo_field "$r" name)" ] || die "repository '$r' is not defined in config/repos.json"
    [ -e "$WORKSPACE_ROOT/repositories/$r/.git" ] \
      || die "repository '$r' is not cloned — run /setup-workspace first"
  done
  [ -n "$repos" ] || warn "no repositories selected — the task will have no worktrees (add later with add-repository)"

  info "Initializing task $TICKET_ID (purpose=$PURPOSE${DEV_KIND:+, kind=$DEV_KIND}; repos: ${repos:-none})"
  mkdir -p "$TASK_DIR/docs/handoff" "$TASK_DIR/repositories" "$TASK_DIR/agents" "$TASK_DIR/scripts"

  local repos_json="[]"
  if [ -n "$repos" ]; then
    # shellcheck disable=SC2086
    repos_json="$(printf '%s\n' $repos | jq -R . | jq -s .)"
  fi
  jq -n \
    --arg ticket "$TICKET_ID" \
    --arg purpose "$PURPOSE" \
    --arg dev_kind "$DEV_KIND" \
    --arg title "$TITLE" \
    --arg url "$TICKET_URL" \
    --argjson sandbox "$SANDBOX" \
    --argjson repos "$repos_json" \
    '{ticket: $ticket, purpose: $purpose, dev_kind: $dev_kind, title: $title,
      ticket_url: $url, sandbox: $sandbox, repos: $repos}' > "$META"

  info "init done — meta saved to $META"
}

# ---------------------------------------------------------------------------
load_meta() {
  [ -f "$META" ] || die "no $META — run --phase init first"
  PURPOSE="$(json_get "$META" '.purpose')"
  DEV_KIND="$(json_get "$META" '.dev_kind')"
  TITLE="$(json_get "$META" '.title')"
  TICKET_URL="$(json_get "$META" '.ticket_url')"
  # NB: not json_get — in jq, `false // empty` is empty, which would flip
  # --no-sandbox tasks back to sandboxed.
  SANDBOX="$(jq -r 'if .sandbox == false then "false" else "true" end' "$META")"
  REPOS="$(jq -r '.repos | join(" ")' "$META")"
  PURPOSE_JSON="$WORKSPACE_ROOT/config/purposes/$PURPOSE.json"
  export PURPOSE TITLE TICKET_URL
}

# generate_agent_settings <role: worker|orchestrator> <dest-file>
generate_agent_settings() {
  local role="$1" dest="$2" template tmp
  tmp="$(mktemp)"
  if [ "$SANDBOX" = "true" ]; then
    render_template "$WORKSPACE_ROOT/templates/task-$role/claude-settings.json" > "$tmp"
  elif [ "$role" = "worker" ]; then
    # No OS sandbox: restricted-bash worker profile (tool-level guards only).
    render_template "$WORKSPACE_ROOT/templates/default/claude-settings-no-sandbox.json" > "$tmp"
  else
    # No-sandbox orchestrator: keep its real profile (five privileged-script
    # allow rules + denies) but drop the sandbox block, which has no meaning
    # without OS enforcement. Deriving it avoids a second template drifting.
    render_template "$WORKSPACE_ROOT/templates/task-orchestrator/claude-settings.json" \
      | jq 'del(.sandbox)' > "$tmp"
  fi

  # Worker: worktree git operations reach the origin's shared .git through
  # git/Claude Code's own worktree handling — NO allowWrite injection is
  # needed for commits (verified: sandbox-experiments S8-d, Claude Code
  # >= 2.1.149). Keeping origin .git out of allowWrite, we instead inject
  # denyWrite pins for the redirect surface. denyWrite beats every allow —
  # including permission-rule merges from a settings.local.json written by a
  # "don't ask again" approval (S2-n) — so these hold even if the permission
  # layer drifts:
  #   .git/config, .git/hooks              — remote/hook redirect on the origin
  #   <gitdir>/config.worktree             — the per-worktree redirect vector
  #     (core.hooksPath / remote.origin.url; the C-2 finding). git never
  #     writes this file during add/commit; sparse-checkout setup does, but
  #     that runs at task creation, outside the worker sandbox.
  # Still not a boundary on its own: the authoritative guard remains the
  # single publish path (push-create-pr.sh forces -c core.hooksPath so the
  # pre-push host/org hook always runs).
  if [ "$role" = "worker" ] && [ "$SANDBOX" = "true" ]; then
    local r t2 gitdir wt_gitdir wt_pin
    for r in $REPOS; do
      gitdir="$WORKSPACE_ROOT/repositories/$r/.git"
      wt_pin=""
      if wt_gitdir="$(worktree_gitdir "$r" "$TICKET_ID")"; then
        wt_pin="$wt_gitdir/config.worktree"
      else
        # A sandboxed worker without this pin has an open C-2 redirect vector,
        # so refuse to generate its settings rather than warn-and-continue.
        # In the normal flow worktrees are created (open-task Step 5b, or
        # phase_finalize) before this runs, so this only fires on a genuinely
        # missing worktree — which must be created before finalize.
        die "worktree for '$r' not found — cannot pin its config.worktree (the C-2 redirect vector). Create the worktree before finalize, then re-run."
      fi
      t2="$(mktemp)"
      jq --arg c "$gitdir/config" --arg h "$gitdir/hooks" --arg w "$wt_pin" \
        '.sandbox.filesystem.denyWrite += ([$c, $h] + (if $w == "" then [] else [$w] end))' \
        "$tmp" > "$t2"
      mv "$t2" "$tmp"
    done
  fi

  # Worker origin access: deliberately NOT added to additionalDirectories.
  # The worker operates on its worktrees under {{TASK_DIR}} (already covered by
  # additionalDirectories), so it never needs to read the origins directly.
  # Adding an origin to additionalDirectories would ALSO widen the OS-level
  # Bash *write* boundary to that origin's working tree (verified
  # sandbox-experiments S2-o: additionalDirectories is a fifth merge source of
  # the effective write boundary, not just a read/auto-approve widener) —
  # letting a worker mutate the shared clone outside its own task. So we omit
  # it entirely and supersede the earlier per-repo read grant (review Low-1).

  # MCP servers selected by the purpose.
  local t3
  t3="$(mktemp)"
  jq --argjson servers "$MCP_SERVERS_JSON" '.enabledMcpjsonServers = $servers' "$tmp" > "$t3"
  mv "$t3" "$tmp"

  mv "$tmp" "$dest"
}

phase_finalize() {
  load_meta
  local kind_arg=""
  [ -n "$DEV_KIND" ] && kind_arg="$DEV_KIND"

  MCP_SERVERS_JSON="$(jq -c '.mcp_servers // []' "$PURPOSE_JSON")"

  # Validate the purpose's MCP server names against the template catalog — a
  # typo would otherwise be dropped silently at the filter step (review Low-15).
  local s
  for s in $(jq -r '.[]' <<<"$MCP_SERVERS_JSON"); do
    jq -e --arg k "$s" '.mcpServers | has($k)' "$WORKSPACE_ROOT/templates/default/mcp.json" >/dev/null \
      || warn "purpose '$PURPOSE' references MCP server '$s' which is not in templates/default/mcp.json — it will be ignored"
  done

  # Permanent task metadata — survives the cmux phase (which deletes
  # .workspace-meta.json). Source of truth for purpose/repos after setup
  # (review Low-8); the OTEL scrape in add-repository/list-task remains only
  # as a fallback for tasks created before this file existed.
  local repos_meta="[]"
  if [ -n "$REPOS" ]; then
    # shellcheck disable=SC2086
    repos_meta="$(printf '%s\n' $REPOS | jq -R . | jq -s .)"
  fi
  jq -n \
    --arg ticket "$TICKET_ID" --arg purpose "$PURPOSE" --arg dev_kind "$DEV_KIND" \
    --arg title "$TITLE" --arg url "$TICKET_URL" --arg branch "$BRANCH" \
    --argjson sandbox "$SANDBOX" --argjson repos "$repos_meta" \
    '{ticket: $ticket, purpose: $purpose, dev_kind: $dev_kind, title: $title,
      ticket_url: $url, branch: $branch, sandbox: $sandbox, repos: $repos}' \
    > "$TASK_DIR/.task-meta.json"

  # REPOS_LIST for templates (single line; render_template is line-based).
  local r list=""
  for r in $REPOS; do
    list="${list:+$list, }\`$r\`"
  done
  REPOS_LIST="${list:-none (add with add-repository)}"
  export REPOS_LIST

  # --- worktrees -----------------------------------------------------------
  if ! $SKIP_WORKTREES; then
    info "Creating worktrees"
    for r in $REPOS; do
      create_worktree "$r" "$TICKET_ID" "$BRANCH" "$PURPOSE"
    done
  fi

  # --- task docs -----------------------------------------------------------
  if [ ! -f "$TASK_DIR/docs/task.md" ]; then
    render_template "$(template_for task.md "$PURPOSE" "$kind_arg")" > "$TASK_DIR/docs/task.md"
    info "docs/task.md scaffolded from template (fill in the ticket body)"
  fi
  if [ ! -f "$TASK_DIR/CLAUDE.md" ]; then
    render_template "$(template_for CLAUDE.md "$PURPOSE" "$kind_arg")" > "$TASK_DIR/CLAUDE.md"
  fi

  # --- privileged task scripts ---------------------------------------------
  cp "$WORKSPACE_ROOT/scripts/task/push-create-pr.sh" "$TASK_DIR/scripts/push-create-pr.sh"
  chmod +x "$TASK_DIR/scripts/push-create-pr.sh"

  # --- worker agent ----------------------------------------------------------
  info "Generating agents/worker"
  mkdir -p "$TASK_DIR/agents/worker/.claude"
  # Empty .git file isolates the agent dir from any enclosing git repo
  # (Claude Code stops walking up for repo context here).
  touch "$TASK_DIR/agents/worker/.git"
  render_template "$WORKSPACE_ROOT/templates/task-worker/CLAUDE.md" \
    > "$TASK_DIR/agents/worker/CLAUDE.md"
  generate_agent_settings worker "$TASK_DIR/agents/worker/.claude/settings.json"
  render_template "$(template_for initial-prompt.md "$PURPOSE" "$kind_arg")" \
    > "$TASK_DIR/agents/worker/initial-prompt.md"

  # --- orchestrator agent ----------------------------------------------------
  info "Generating agents/orchestrator"
  mkdir -p "$TASK_DIR/agents/orchestrator/.claude/skills"
  touch "$TASK_DIR/agents/orchestrator/.git"
  render_template "$WORKSPACE_ROOT/templates/task-orchestrator/CLAUDE.md" \
    > "$TASK_DIR/agents/orchestrator/CLAUDE.md"
  generate_agent_settings orchestrator "$TASK_DIR/agents/orchestrator/.claude/settings.json"
  render_template "$WORKSPACE_ROOT/templates/task-orchestrator/initial-prompt.md" \
    > "$TASK_DIR/agents/orchestrator/initial-prompt.md"
  cp -R "$WORKSPACE_ROOT/templates/task-orchestrator/skills/." \
    "$TASK_DIR/agents/orchestrator/.claude/skills/"
  find "$TASK_DIR/agents/orchestrator/.claude/skills" -name '*.sh' -exec chmod +x {} +

  # --- MCP -------------------------------------------------------------------
  if [ "$MCP_SERVERS_JSON" != "[]" ]; then
    local mcp_src="$WORKSPACE_ROOT/templates/default/mcp.json"
    jq --argjson servers "$MCP_SERVERS_JSON" \
      '{mcpServers: (.mcpServers | with_entries(select(.key as $k | $servers | index($k))))}' \
      "$mcp_src" > "$TASK_DIR/agents/worker/.mcp.json"
    cp "$TASK_DIR/agents/worker/.mcp.json" "$TASK_DIR/agents/orchestrator/.mcp.json"
  fi

  info "finalize done"
  log ""
  log "Next: set up trust for the agent directories, then run --phase cmux."
}

# ---------------------------------------------------------------------------
phase_cmux() {
  # No load_meta here: .workspace-meta.json is deleted at the end of a
  # successful cmux phase, so requiring it would make /start-task (re-run
  # --phase cmux on an existing task) fail every time. cmux only needs the
  # task dir + ticket id (already set) and the generated agent dirs on disk.
  local worker_dir="$TASK_DIR/agents/worker"
  local orch_dir="$TASK_DIR/agents/orchestrator"
  [ -f "$worker_dir/initial-prompt.md" ] || die "agents not generated — run --phase finalize first"

  # Paths are shell-quoted (%q) because these strings are sent verbatim to a
  # cmux shell — an unquoted path with spaces would cd to the wrong directory
  # and start Claude without the task's settings.
  local worker_cmd="claude --permission-mode acceptEdits \"\$(cat initial-prompt.md)\""
  local orch_cmd
  orch_cmd="cd $(printf '%q' "$orch_dir") && claude \"\$(cat initial-prompt.md)\""

  if cmux_available; then
    # Guard against duplicating an already-open workspace (re-run, or
    # /start-task while one is live) — creating a second one would spawn a
    # rival worker on the same worktrees and re-pin .worker-target.
    if [ -n "$(cmux_workspace_uuid_by_name "$TICKET_ID")" ]; then
      warn "a cmux workspace named '$TICKET_ID' is already open — focus it instead of re-running --phase cmux."
      warn "(to rebuild it: close that workspace first, then re-run.)"
      # Review Low-9: don't imply the live workspace is functional if it was
      # created without a pin — messaging would fail on every send.
      if [ ! -f "$orch_dir/.claude/skills/.worker-target" ]; then
        warn "NOTE: this task has NO pinned .worker-target, so orchestrator→worker"
        warn "messaging will not work in that workspace. Close it and re-run"
        warn "--phase cmux to create a properly pinned one."
      fi
      rm -f "$META"
      return 0
    fi
    info "Creating cmux workspace '$TICKET_ID' (3 tabs)"
    local ws worker_surface term_surface orch_surface
    ws="$(cmux_new_workspace "$TICKET_ID" "$worker_dir" "$worker_cmd")" \
      || die "failed to create cmux workspace"
    worker_surface="$(cmux_first_surface_uuid "$ws")" \
      || die "could not resolve worker surface UUID"
    [ -n "$worker_surface" ] || die "could not resolve worker surface UUID"
    cmux_rename_tab "$ws" "$worker_surface" "Worker Claude"

    # Pin the worker target BEFORE the orchestrator session starts. The
    # orchestrator cannot modify this file (denyWrite agents/**); surfaces are
    # addressed by UUID so focus/reorder cannot break the pin.
    cat > "$orch_dir/.claude/skills/.worker-target" <<EOF
# Generated by open-task. Do not edit.
WORKER_CMUX_WORKSPACE=$ws
WORKER_CMUX_SURFACE=$worker_surface
EOF

    term_surface="$(cmux_new_tab "$ws" "Terminal")"
    # cmux new-surface has no --cwd: always cd explicitly (a bare 'claude'
    # would start in \$HOME and miss the task settings).
    cmux_send_line "$ws" "$term_surface" "cd $(printf '%q' "$TASK_DIR")"

    orch_surface="$(cmux_new_tab "$ws" "Orchestrator Claude")"
    cmux_send_line "$ws" "$orch_surface" "$orch_cmd"

    info "cmux workspace ready: worker=$worker_surface"
  else
    warn "cmux not available — falling back to manual startup."
    log ""
    log "Run the worker yourself:"
    log "  cd $worker_dir && $worker_cmd"
    log "Run the orchestrator in another terminal:"
    log "  $orch_cmd"
    log "(orchestrator worker-messaging skills need cmux and will not work)"
    if command -v pbcopy >/dev/null 2>&1; then
      printf 'cd %s && %s' "$worker_dir" "$worker_cmd" | pbcopy
      log "Worker command copied to clipboard."
    fi
  fi

  rm -f "$META"
  info "Task $TICKET_ID is ready."
}

# ---------------------------------------------------------------------------
case "$PHASE" in
  init)     phase_init ;;
  finalize) phase_finalize ;;
  cmux)     phase_cmux ;;
  all)      phase_init; phase_finalize; phase_cmux ;;
  *) die "unknown phase: $PHASE" ;;
esac
