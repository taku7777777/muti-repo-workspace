---
name: add-repository-to-worker
description: Add another repository worktree to this task mid-flight — creates the worktree, grants the worker commit access to it, and notifies the worker via cmux. Use when the task turns out to need a repo that was not selected at open-task time.
---

# add-repository-to-worker

Adds a repository to the running task: worktree + worker sandbox commit
access + cmux notification, in one privileged script.

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
- NOTE: the worker's sandbox settings change requires the worker's NEXT
  session restart only for widened filesystem write scopes; commit access to
  the new repo is injected immediately but the worker may need to be told to
  retry if a git commit was already denied. The script prints what happened.
