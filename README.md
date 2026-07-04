# multi-repo-workspace

A Git-repository-shaped workspace for running **sandboxed, multi-agent Claude
Code sessions across multiple repositories** — one isolated workspace per
ticket, with an orchestrator agent commanding a sandboxed worker agent.

> 🇯🇵 日本語版: [README.ja.md](README.ja.md)

Clone it, list your repositories in `config/repos.json`, and every ticket gets:

- its own directory `tasks/<TICKET_ID>/` with **git worktrees** (branch
  `feat/<TICKET_ID>`) for every relevant repository — cheap, disposable, isolated;
- a **worker** Claude that edits/builds/tests/commits autonomously inside an
  OS-level sandbox (no network, no push, no secrets, no settings tampering);
- an **orchestrator** Claude that instructs the worker over
  [cmux](https://github.com/wandb/cmux), reviews results via an append-only
  **handoff log**, and handles the privileged steps (push, PR creation);
- a plain **terminal** tab for the human: installs, docker, escape hatch.

```
┌───────────────────────── cmux workspace "<TICKET_ID>" ─────────────────────────┐
│ Tab 1 Worker Claude        Tab 2 Terminal           Tab 3 Orchestrator Claude  │
│ tasks/T/agents/worker      tasks/T                  tasks/T/agents/orchestrator│
│ edit·build·test·commit     human: install, docker   send / wait / read / PR    │
└────────────────────────────────────────────────────────────────────────────────┘
            ▲  writes docs/handoff/*_worker.md          │ cmux send (pinned target)
            └────────── shared: docs/, repositories/ ◄──┘
```

## Why

Running agents with `--dangerously-skip-permissions` is fast but unbounded;
running them with prompts on every command is safe but unusable. This
workspace takes a third path: **OS-enforced sandbox boundaries per role**, so
the worker runs with zero confirmation prompts *because* it physically cannot
push, exfiltrate, read credentials, or widen its own permissions. Roles that
need privileges (push/PR) get them through single-purpose, literal-path
allowlisted scripts — never general shell.

| Layer | CWD | Network | Writes |
|---|---|---|---|
| Root (management console) | repo root | github.com, npm registry | workspace scaffolding |
| Origins | `repositories/` | — | none (worktree source, read-only) |
| Worker (per task) | `tasks/T/agents/worker/` | none (localhost only) | task worktrees + docs only |
| Orchestrator (per task) | `tasks/T/agents/orchestrator/` | none (PR via excluded script) | docs only |

## Requirements

- macOS (sandboxing uses Claude Code's macOS sandbox; `--no-sandbox` mode works elsewhere)
- `git`, `jq`, `curl`, [GitHub CLI `gh`](https://cli.github.com/), SSH access to your repos
- [Claude Code](https://claude.com/claude-code)
- [`cmux`](https://github.com/wandb/cmux) — optional but strongly recommended
  (without it you get clipboard-fallback single-session mode)

## Quick start

```bash
git clone <this-repo> my-workspace && cd my-workspace

# 1. Describe your repositories and policies
$EDITOR config/repos.json        # the repos this workspace manages
$EDITOR config/workspace.json    # allowed push orgs, ticket source, branch prefix

# 2. Let Claude set everything up
claude
> /setup-workspace               # clones repos, installs hooks/settings/helpers

# 3. Open a task
> /open-task                     # ticket id → purpose → repos → 3 cmux tabs
```

Then watch the worker start on the ticket in tab 1, and drive it from the
orchestrator in tab 3 (or let it drive itself — the orchestrator loops:
instruct → wait → read handoff → push/PR).

## Configuration

| File | What you edit |
|---|---|
| `config/repos.json` | Target repositories (`name`, `url`, `type: code\|knowledge`, sparse paths) |
| `config/workspace.json` | `allowed_push_orgs` (pre-push hook), ticket source adapter, branch prefix |
| `config/purposes/*.json` | Task purposes: default repos, MCP servers, sub-kinds. Add a JSON = add a purpose |
| `templates/` | Everything /open-task generates (settings, CLAUDE.md, prompts) — placeholders are substituted at runtime |
| `templates/default/mcp.json` | MCP server catalog; purposes pick servers from it by name |

See `examples/` for richer purpose definitions (incident response, project
planning) and additional ticket-source adapters.

## How it works

- **Worktrees, not clones**: `repositories/<repo>` is cloned once;
  `tasks/<T>/repositories/<repo>` are `git worktree`s on branch
  `feat/<T>` sharing the same object store. `type: knowledge` repos check out
  sparsely (only the paths configured for the task's purpose).
- **Pinned worker target**: when /open-task creates the worker tab, it writes
  the cmux workspace + surface UUID to a file the orchestrator can read but
  never modify. The messaging skills refuse `--workspace`/`--surface`
  overrides — an orchestrator can only ever command its own worker.
- **Handoff log**: `tasks/<T>/docs/handoff/` is an append-only event log
  (`YYYYMMDD_HHmmss_NNN_<role>.md`). The worker reports status and requests
  privileged actions there; the orchestrator answers with result files. State
  is always derivable from the files; nothing is mutated.
- **Idle-not-exit**: the worker never exits. It reports, goes idle, and waits
  for the next cmux instruction — so one session accumulates task context
  across the whole ticket.
- **Privilege boundaries as files**: push/PR runs through
  `scripts/push-create-pr.sh`, which the orchestrator may execute (sandbox
  exclusion, literal path match) but not edit (denyWrite). A pre-push hook
  restricts push destinations to `allowed_push_orgs`.

Full details: [`docs/architecture.md`](docs/architecture.md),
[`docs/handoff-protocol.md`](docs/handoff-protocol.md),
[`docs/settings-reference/`](docs/settings-reference/),
[`docs/verification-guide.md`](docs/verification-guide.md).

## Repository layout

```
.claude/skills/        management skills (/setup-workspace, /open-task, ...)
config/                your workspace definition (repos, purposes, policies)
templates/             sources for everything /open-task generates
scripts/               workspace machinery (setup, task creation, cmux helpers)
docs/                  architecture / protocol / settings references
examples/              optional purpose configs and ticket-source adapters
repositories/          cloned target repos           (generated, gitignored)
tasks/                 per-ticket workspaces         (generated, gitignored)
```

## License

MIT — see [LICENSE](LICENSE).
