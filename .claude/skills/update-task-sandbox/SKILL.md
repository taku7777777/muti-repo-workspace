---
name: update-task-sandbox
description: Widen a task worker's sandbox from the root console — add network domains, permission rules, write scopes, or git fetch access. The audited escalation path; tasks can never widen their own sandbox.
---

# update-task-sandbox

Use when a worker's handoff reports `status: blocked` on something the
sandbox denies and the user agrees the permission is warranted.

```bash
bash scripts/update-task-sandbox.sh <TICKET_ID> --show                 # current state
bash scripts/update-task-sandbox.sh <TICKET_ID> --add-domain <domain>  # e.g. registry.npmjs.org
bash scripts/update-task-sandbox.sh <TICKET_ID> --add-allow "Bash(...)"
bash scripts/update-task-sandbox.sh <TICKET_ID> --add-ask "Bash(...)"
bash scripts/update-task-sandbox.sh <TICKET_ID> --add-write </abs/path>
bash scripts/update-task-sandbox.sh <TICKET_ID> --add-git-access       # git fetch: github.com + SSH agent
```

Rules:
- Confirm with the user before widening anything — state the concrete risk
  (e.g. "--add-domain X lets the worker send data to X").
- Prefer the narrowest option that unblocks the worker.
- Push access is never granted this way; publishing always goes through the
  orchestrator's `push-create-pr.sh`.
- The worker session must be restarted (or told to retry after `/start-task`)
  for changes to apply — the script reminds you.
