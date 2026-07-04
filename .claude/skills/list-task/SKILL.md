---
name: list-task
description: List all task workspaces under tasks/ with purpose, latest worker handoff status and repositories. Use to get an overview of open work or find stale tasks to close.
---

# list-task

```bash
bash scripts/list-task.sh
```

One line per task: ticket, purpose, latest worker-reported status (from
`docs/handoff/`), worktree repos. `[SETUP INCOMPLETE]` means open-task never
finished (finalize/cmux pending) — offer to resume it or close the task.

After showing the list, point out candidates for `/close-task`: tasks whose
status is `complete` (and PR merged, if you can check with `gh`).
