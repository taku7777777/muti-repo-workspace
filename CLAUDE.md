# multi-repo-workspace — Root / management console

This directory is the workspace root AND the management console: start
`claude` here to run the management skills. Everything under `repositories/`
and `tasks/` is generated local state (never committed).

## Layers

| Layer | Where | Role |
|---|---|---|
| Root (here) | `./` | Setup, task lifecycle management, oversight |
| Origins | `repositories/` | Read-only clones that worktrees are created from |
| Worker | `tasks/<T>/agents/worker/` | Sandboxed executor for one ticket |
| Orchestrator | `tasks/<T>/agents/orchestrator/` | Commander for one ticket |

## Management skills (run from here)

- `/setup-workspace` — clone target repos from `config/repos.json`, install
  settings, git hooks and cmux helpers. Run once after cloning, re-run any time
  (idempotent).
- `/open-task` — create a per-ticket workspace: worktrees, worker+orchestrator
  agents, cmux tabs. Main entry point for starting work.
- `/list-task`, `/close-task` — inspect / remove task workspaces (close prunes worktrees).
- `/add-repository` — add a worktree to an existing task.
- `/create-pr` — push a task's branch and open a PR.
- `/update-task-sandbox` — grant extra permissions to a task's worker from
  outside the task (a task can never widen its own sandbox).
- `/start-task` — reopen the cmux tabs / Claude sessions for an existing task.

## Rules for this layer

- Never edit files under `repositories/` — they are worktree origins; all code
  changes happen inside `tasks/<T>/repositories/` worktrees, by the task's worker.
- Configuration lives in `config/` (workspace.json, repos.json, purposes/).
  Templates for generated files live in `templates/`. Change them via normal
  git branches and PRs on this repository.
- Do not hand-edit generated files (`tasks/**`, `.claude/settings.json`,
  `repositories/*/.claude/`); change the template and re-run the skill instead.
- Worktree creation must be done with `git -C repositories/<repo> worktree add
  ../../tasks/<T>/repositories/<repo> ...` (relative target path, no command
  chaining) — see the open-task skill for the exact rules.
