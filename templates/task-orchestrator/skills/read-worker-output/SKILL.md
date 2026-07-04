---
name: read-worker-output
description: Capture the worker pane's current screen content (optionally scrollback) for this task's pinned worker. Use to inspect what the worker printed when the handoff log is not enough.
---

# read-worker-output

Reads the worker's terminal screen. Prefer the handoff log
(`../../docs/handoff/`, via the Read tool) for structured state — use this
skill when you need the raw pane output (errors, test results, TUI state).

## Usage

Call the script with its EXACT literal path (see your CLAUDE.md operating table):

```
<skills>/read-worker-output/scripts/read-output.sh [--lines N] [--scrollback]
```

- `--lines N` — number of lines (default 60)
- `--scrollback` — include scrollback history
- `--workspace` / `--surface` are rejected by design.
