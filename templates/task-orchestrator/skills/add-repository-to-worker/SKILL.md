---
name: add-repository-to-worker
description: Add another repository worktree to this task mid-flight — creates the worktree, pins the new origin's git redirect surface in the worker sandbox, and notifies the worker via cmux. Use when the task turns out to need a repo that was not selected at open-task time.
---

# add-repository-to-worker

Adds a repository to the running task: worktree + git-redirect-surface
denyWrite pins in the worker sandbox + cmux notification, in one privileged
script.

## Usage

Call the script with its EXACT literal path (see your CLAUDE.md operating table):

```
<skills>/add-repository-to-worker/scripts/add-repository.sh <repo-name>
```

- `<repo-name>` must exist in the workspace's `config/repos.json` and be
  cloned under `repositories/` (if it is not cloned, ask the human to run
  /setup-workspace or clone it in the Terminal tab first).
- The script tells the worker about the new repository automatically; you do
  not need to send a separate instruction for that.
- NOTE: the worker needs NO extra write grant to commit in the new worktree
  (git's worktree handling reaches the shared origin `.git` on its own —
  S8-d). What the script injects is denyWrite pins on the new origin's
  redirect surface (`.git/config`, `.git/hooks`, the worktree's
  `config.worktree`). These take effect on the worker's next session restart;
  commits themselves work immediately. The script prints what happened.
