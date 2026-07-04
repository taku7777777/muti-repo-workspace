---
name: wait-for-worker
description: Block until this task's worker settles (running → idle) or dies, then emit one RESULT line plus the pane tail. ALWAYS run with run_in_background true right after sending an instruction, then end your turn — the completion notification replaces manual polling.
---

# wait-for-worker

Monitors the pinned worker until it stabilizes. Replaces sleep/peek polling
loops: arm it, end your turn, act once on the notification.

## Usage

Call the script with its EXACT literal path (see your CLAUDE.md operating
table), **always** with `run_in_background: true`:

```
<skills>/wait-for-worker/scripts/wait-for-worker.sh [timeout-seconds]
```

- Default timeout: 1800 seconds.
- Output ends with:
  ```
  RESULT status=<idle|dead|timeout> surface=<uuid> elapsed=<seconds>
  --- pane tail ---
  <last 40 lines of the worker pane>
  ```
- `status=idle` — worker finished the instruction and is waiting. Read the
  newest handoff file next.
- `status=dead` — the worker surface is gone; tell the human.
- `status=timeout` — still running after the timeout; read the pane output
  and decide (extend the wait, or intervene).
- `--workspace` / `--surface` are rejected by design.
