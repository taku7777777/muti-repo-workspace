---
name: close-task
description: Tear down a task workspace — remove its worktrees (with unpushed-work safety checks), close the cmux workspace, delete tasks/<TICKET>. Use when a ticket's work is merged or abandoned.
---

# close-task

```bash
bash scripts/remove-workspace.sh <TICKET_ID>
```

The script refuses to delete unpushed work (uncommitted changes or commits
without a pushed upstream). If it blocks:
1. Show the user exactly what would be lost (the script lists it).
2. Only re-run with `--force` after the user explicitly confirms discarding.

Local branches `feat/<TICKET>` are kept; mention the cleanup command the
script prints if the user wants them gone too.
