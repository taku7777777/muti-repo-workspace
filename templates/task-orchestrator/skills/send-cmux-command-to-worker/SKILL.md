---
name: send-cmux-command-to-worker
description: Send an instruction to this task's worker Claude session via cmux. The target is pinned in .worker-target and cannot be overridden. Use for every instruction to the worker; follow immediately with wait-for-worker (run_in_background).
---

# send-cmux-command-to-worker

Sends one instruction to the worker pane and submits it (text + enter).

## Usage

Call the script with its EXACT literal path (as listed in your CLAUDE.md
operating table — literal-match sandbox exclusion; relative paths or
`bash <path>` fail with Exit 126):

```
<skills>/send-cmux-command-to-worker/scripts/send-command.sh "<instruction text>"
```

- One argument: the full instruction text. Keep it self-contained — the worker
  has its own context but no access to yours.
- `--workspace` / `--surface` are rejected by design: you can only address the
  worker recorded in `.worker-target`.

## After sending

Immediately start `wait-for-worker` with `run_in_background: true` and end
your turn. Never poll manually.
