---
name: add-repository
description: Add a repository worktree to an existing task from the root console — creates the worktree, pins the new origin's git redirect surface in the worker sandbox, notifies the worker via cmux.
---

# add-repository

Adds `<repo>` (must exist in `config/repos.json` and be cloned under
`repositories/`; if missing, run /setup-workspace first) to an existing task:

```bash
bash tasks/<TICKET_ID>/agents/orchestrator/.claude/skills/add-repository-to-worker/scripts/add-repository.sh <repo>
```

This is the same privileged script the task orchestrator uses — it creates
the worktree on the task branch (sparse for knowledge repos), pins the new
origin's redirect surface (`.git/config`, `.git/hooks`, the worktree's
`config.worktree`) as denyWrite in the worker's sandbox settings (commits
need no write grant — S8-d), and tells the worker via cmux.

If the ticket's cmux workspace is not running, the script warns; the worker
will discover the repo at ../../repositories/<repo> on its next instruction.
