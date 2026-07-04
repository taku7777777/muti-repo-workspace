---
name: gen-create-pr-command
description: Generate (and copy to clipboard) a ready-to-paste push-create-pr command for a task, committing any pending changes first. For the human to run in the task's Terminal tab when they want manual control over publishing.
---

# gen-create-pr-command

Produces a one-liner the human can paste into the task's Terminal tab —
useful when they want to eyeball the final command instead of letting an
agent push.

1. Identify the target task and repo (ask if ambiguous). If the worktree has
   uncommitted changes, first commit them (or ask the worker to; a manual
   `git -C tasks/<T>/repositories/<repo> add -A` + `commit` is fine if the
   user agrees).

2. Draft `--title` and a `--body-file` (write the body to
   `tasks/<T>/docs/pr-body-<repo>.md`) from `docs/task.md`, the handoff log
   and the diff.

3. Emit the command:
   ```
   bash tasks/<T>/scripts/push-create-pr.sh <repo> --title "..." --body-file tasks/<T>/docs/pr-body-<repo>.md
   ```
   Copy it to the clipboard with `pbcopy` when available, and print it either
   way. Tell the user to paste it into the Terminal tab (Tab 2).
