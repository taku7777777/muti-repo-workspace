# Handoff protocol

`tasks/<T>/docs/handoff/` is the structured, asynchronous channel between the
worker and the orchestrator — the durable complement to volatile cmux pane
I/O. It is an **append-only event log**: state is always derived from the
files, never mutated.

## Rules

1. **One message = one file.** Existing files are never edited or deleted.
2. **File name**: `YYYYMMDD_HHmmss_NNN_<from>.md`
   - timestamp from `date +%Y%m%d_%H%M%S`
   - `NNN`: 3-digit sequence, one greater than the highest `NNN` in the
     directory regardless of sender — it provides ordering, freshness and
     message identity
   - `<from>`: `worker` or `orchestrator`
3. `docs/` is task-local: handoff files never appear in PR diffs
   (only `repositories/` content is pushed).

## Worker messages (`type: report`)

The worker appends a report **at every step completion, on any blocker, and
at overall completion**, then goes idle. It never exits — an idle prompt is
the "ready for next instruction" signal (`wait-for-worker` detects it).

```yaml
type: report
status: in_progress | awaiting_next | blocked | complete | failed
task_ref: docs/task.md step3
summary: |
  What was done, current state, what remains.
requests:                      # only when privileged action is needed
  - id: req-007-1              # <file seq>-<n>: unique forever
    action: push_and_pr | install_package | other
    repo: example-app
    branch: feat/TICKET-1
    pr_title: "fix: ..."       # for push_and_pr the worker drafts the PR text
    pr_body: |
      ...
    detail: "pnpm add zod"     # for install_package / other
```

The worker must **never attempt** privileged actions itself (push, PR,
package installs, network, writes to `agents/`/`scripts/`): the sandbox blocks
them, and retrying burns context. Request → idle is always the right move.

## Orchestrator messages (`type: result`)

After handling a request, the orchestrator records the outcome:

```yaml
type: result
refs: req-007-1
status: done | failed | deferred
summary: |
  PR created: https://github.com/...
```

## Derived state (no status file exists)

| Question | Answer |
|---|---|
| Current worker state | highest-seq `*_worker.md` → its `status:` |
| Unhandled requests | `request` ids with no `*_orchestrator.md` whose `refs:` matches |
| Orchestrator read position | highest-seq `*_orchestrator.md` |

## Division of labor (build / test / install)

| Work | Who |
|---|---|
| Initial setup: dependency install, docker, first build | **Human**, Terminal tab, at open-task time |
| In-cycle lint / build / test (existing deps) | **Worker**, sandboxed |
| Adding/upgrading packages | **Human** in Terminal (worker requests via `install_package`; the orchestrator relays and waits — it must not run installs either) |
| push / PR | **Orchestrator** via `scripts/push-create-pr.sh` (after reviewing the diff; human approval for anything surprising) |

## Orchestrator loop (normative)

1. `send-command.sh "<instruction>"`
2. `wait-for-worker.sh` with `run_in_background: true` → **end turn**
3. On `RESULT status=idle`: Read newest `*_worker.md` (Read tool — never bash
   under `agents/`; sandbox denyRead there makes bash fail with
   `Operation not permitted`, which is expected, not an error to chase)
4. Handle unhandled requests; append `*_orchestrator.md` results
5. Next instruction; stop when `status: complete` and no open requests

`RESULT status=dead` → worker session is gone: tell the human / `/start-task`.
`RESULT status=timeout` → read the pane (`read-output.sh`), judge, re-arm.
`RESULT status=error` → the wait helper could not run (`reason=` names it, e.g.
a missing `~/.cmux-state.sh`): an environment fault, not a worker state — tell
the human to re-run `/setup-workspace`.
