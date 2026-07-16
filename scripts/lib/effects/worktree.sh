#!/usr/bin/env bash
# Worktree side-effect helpers. Requires common.sh to be sourced first.
#
# NOTE: the primary path for worktree creation during /open-task is Claude
# executing `git -C ...` directly (see the open-task skill, Step "worktrees") —
# these helpers exist for the scripted/unsandboxed paths (create-workspace.sh
# without --skip-worktrees, add-repository-to-worker). The rules are identical:
# relative target paths, `git -C`, no command chaining.

# create_worktree <repo-name> <ticket-id> <branch> <purpose>
# Creates tasks/<ticket>/repositories/<repo> as a worktree of
# repositories/<repo> on <branch>. Sparse checkout for knowledge repos.
create_worktree() {
  local repo="$1" ticket="$2" branch="$3" purpose="$4"
  local sroot origin target_rel target_abs repo_type
  # repositories/ (origin) and tasks/ (target) live under state_root; keeping
  # them siblings there preserves the RELATIVE target below (`../../tasks/...`
  # resolves within state_root). config lives under config_dir (tool_home
  # config/ by default, or a per-workspace .mrw/).
  sroot="$(state_root)"
  origin="$sroot/repositories/$repo"
  target_rel="../../tasks/$ticket/repositories/$repo"
  target_abs="$sroot/tasks/$ticket/repositories/$repo"

  [ -d "$origin/.git" ] || die "repository '$repo' is not cloned (run /setup-workspace first)"
  if [ -d "$target_abs" ]; then
    log "  - $repo: worktree already exists, skipping"
    return 0
  fi

  repo_type="$(repo_field "$repo" type)"
  local checkout_flag=""
  [ "$repo_type" = "knowledge" ] && checkout_flag="--no-checkout"

  # Use a RELATIVE target path so the worktree link stays valid if the
  # workspace directory moves. Never chain commands.
  if git -C "$origin" show-ref --verify --quiet "refs/heads/$branch"; then
    info "  - $repo: adding worktree on existing local branch $branch"
    git -C "$origin" worktree add $checkout_flag "$target_rel" "$branch"
  elif git -C "$origin" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
    info "  - $repo: adding worktree tracking origin/$branch"
    git -C "$origin" worktree add $checkout_flag --track -b "$branch" "$target_rel" "origin/$branch"
  else
    info "  - $repo: adding worktree on new branch $branch"
    git -C "$origin" worktree add $checkout_flag -b "$branch" "$target_rel"
  fi

  if [ "$repo_type" = "knowledge" ]; then
    local paths
    paths="$(jq -r --arg n "$repo" --arg p "$purpose" \
      '.repositories[] | select(.name == $n) | .sparse_paths[$p] // [] | join(" ")' \
      "$(config_dir)/repos.json")"
    if [ -n "$paths" ]; then
      info "  - $repo: sparse checkout ($paths)"
      # shellcheck disable=SC2086
      git -C "$target_abs" sparse-checkout set --cone $paths
      git -C "$target_abs" checkout "$branch"
    else
      git -C "$target_abs" checkout "$branch"
    fi
  fi
}

# worktree_gitdir <repo-name> <ticket-id> — print the absolute private gitdir
# of the task's worktree for <repo> (<origin>/.git/worktrees/<name>; the name
# is assigned by git and can differ from <repo> on collisions, so resolve it —
# never guess). Returns non-zero if the worktree does not exist yet.
worktree_gitdir() {
  local wt
  wt="$(state_root)/tasks/$2/repositories/$1"
  [ -d "$wt" ] || return 1
  git -C "$wt" rev-parse --absolute-git-dir 2>/dev/null
}

# remove_worktrees <ticket-id> — detach all worktrees of a task, then prune.
remove_worktrees() {
  local ticket="$1" root wt repo origin
  # Both tasks/ and repositories/ live under state_root.
  root="$(state_root)"
  for wt in "$root/tasks/$ticket/repositories"/*/; do
    [ -d "$wt" ] || continue
    repo="$(basename "$wt")"
    origin="$root/repositories/$repo"
    if [ -d "$origin/.git" ]; then
      info "  - removing worktree $repo"
      git -C "$origin" worktree remove --force "$wt" 2>/dev/null \
        || warn "    could not remove worktree $wt (removing directory manually)"
      # rm BEFORE prune: if `worktree remove` failed, the directory still
      # exists and prune would keep the registration; deleting it first lets
      # prune clear the stale admin metadata so a later re-add of the same
      # ticket+repo doesn't hit "missing but already registered worktree".
      rm -rf "$wt"
      git -C "$origin" worktree prune
    else
      rm -rf "$wt"
    fi
  done
}
