# Task {{TICKET_ID}} — {{TITLE}}

Per-ticket workspace created by /open-task. Purpose: **{{PURPOSE}}**.

## Layout

| Path | What |
|---|---|
| `docs/task.md` | Full ticket description — the source of truth for this task |
| `docs/handoff/` | Append-only worker ↔ orchestrator message log |
| `repositories/<repo>/` | Git worktrees on branch `{{BRANCH}}` |
| `agents/worker/` | Worker Claude CWD (sandboxed executor) |
| `agents/orchestrator/` | Orchestrator Claude CWD (task commander) |
| `scripts/` | Task-local privileged scripts (push-create-pr.sh, add-repository.sh) |

## Repositories in this task

{{REPOS_LIST}}

## Roles

- **Worker** (cmux tab 1): edits, builds, tests, commits. No push, no network.
- **Terminal** (cmux tab 2): human-run setup (installs, docker) and escape hatch.
- **Orchestrator** (cmux tab 3): directs the worker, reviews, pushes and opens PRs.
