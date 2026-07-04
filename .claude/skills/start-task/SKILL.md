---
name: start-task
description: Reopen the cmux tabs / Claude sessions for an existing task (after a reboot, closed window, or a task created without cmux). Re-pins .worker-target to the new worker surface.
---

# start-task

For a task that already exists on disk but has no live cmux workspace.

1. Check whether a cmux workspace for the ticket is already open:
   ```bash
   cmux workspace list
   ```
   If it is listed, tell the user to focus it — do not create a duplicate.

2. Otherwise recreate the 3 tabs (this also re-pins `.worker-target` to the
   new worker surface UUID, so the orchestrator skills keep working):
   ```bash
   bash scripts/create-workspace.sh --ticket <T> --phase cmux --yes
   ```
   Note: `--phase cmux` only needs the generated agent directories on disk
   (from the finalize step); it does NOT need `.workspace-meta.json`, which is
   deleted once a task is fully created — so this works for an already-created
   task. If the agents were never generated it fails cleanly with
   "agents not generated — run --phase finalize first"; in that case resume
   /open-task from the finalize step instead.

3. The worker restarts on its initial prompt; if the task was mid-flight,
   send it a catch-up instruction from the orchestrator (it can re-derive
   state from `../../docs/handoff/`).
