# Settings reference — Orchestrator (per task)

Generated file: `tasks/<T>/agents/orchestrator/.claude/settings.json`
Template (source of truth): `templates/task-orchestrator/claude-settings.json`

## Design goal

A commander with **no general shell**. Its entire bash surface is five
audited scripts; everything else it does goes through the Read tool and file
appends under `docs/`. It can publish work (push/PR) but cannot edit code,
cannot widen anything, and cannot talk to any surface except its own worker.

## Expectations

| Aspect | Value | Why |
|---|---|---|
| `permissions.allow` | exactly five `Bash(<literal path>*)` rules: send-command / read-output / wait-for-worker / add-repository / push-create-pr | no `Bash(*)` — command surface is enumerable |
| `sandbox.excludedCommands` | the same five paths (bare and `" *"` forms) | these scripts need the real cmux socket / git push / gh — they run **outside** the sandbox |
| Path form | `{{TASK_DIR_H}}` = `~/`-anchored; the generated CLAUDE.md operating table shows the **byte-identical** strings | `excludedCommands` matches literally: `/Users/...`-expanded, relative, or `bash <path>` calls fail with Exit 126 |
| Network | `allowedDomains: []` | push/PR happen inside the excluded script, which is unsandboxed anyway — the sandbox itself needs no network |
| Write scope | `docs/` only | handoff results; nothing else |
| `filesystem.denyWrite` **and** `denyRead` | `<T>/agents`, `<T>/scripts` | can't alter `.worker-target`, its own settings, skills, or privileged scripts — and can't *bash-peek* them either (floundering prevention: `ls`/`cat` there returns `Operation not permitted` by design) |
| Tool denies | `Edit` on `<T>/repositories/**` and workspace `repositories/**` | never edits code; review via Read |
| WebFetch / WebSearch / secrets | denied (same set as worker) | |
| MCP | purpose's servers (same list as worker in v1) | |

## Least-privilege messaging chain

`.worker-target` (workspace UUID + surface UUID) is written once by
/open-task, is unreadable/unwritable to the orchestrator's bash, and the
skills resolve it themselves while rejecting `--workspace`/`--surface`. Net
effect: even a fully prompt-injected orchestrator can only send text to its
own worker's pane.

## Verification quick checks (run as the orchestrator)

- `ls` / `cat .worker-target` / `find ../` → `Operation not permitted` (expected!)
- `bash ~/.../send-command.sh hi` → Exit 126 (must call the path directly)
- the literal `~/...send-command.sh "hi"` from CLAUDE.md's table → works
- Edit tool on `../../repositories/<repo>/file` → denied
- Read tool on `../../docs/task.md` → works
