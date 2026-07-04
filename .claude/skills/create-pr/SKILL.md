---
name: create-pr
description: Push a task's branch(es) and create GitHub PRs with a description built from the task's docs and diffs. Run from the root console for any task (the per-task orchestrator has its own push-create-pr.sh path).
---

# create-pr

Publishes a task's committed work. For each repository under
`tasks/<T>/repositories/` that has commits on the task branch:

1. **Verify state**: `git -C tasks/<T>/repositories/<repo> status --porcelain`
   must be clean (if not, ask the user / worker to commit first) and
   `git -C ... log origin/<default>..HEAD --oneline` shows what will be pushed.

2. **Build the description**:
   - Read `tasks/<T>/docs/task.md` (what & why) and the latest
     `docs/handoff/*_worker.md` (the worker usually drafts `pr_title` /
     `pr_body` — prefer its draft).
   - Read the repo's `.github/PULL_REQUEST_TEMPLATE.md` if present and fill
     its sections.
   - Summarize the diff: `git -C ... diff origin/<default>...HEAD --stat`.
   - Write the body to a temp file.

3. **Push + create** via the task's privileged script (one call per repo):
   ```bash
   bash tasks/<T>/scripts/push-create-pr.sh <repo> --title "..." --body-file <tmp>
   ```
   The workspace pre-push hook enforces `allowed_push_orgs`.

4. Report the PR URLs. If the task is now fully published, suggest
   `/close-task <T>` once merged.
