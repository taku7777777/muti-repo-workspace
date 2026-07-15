# `mrw` — thin dispatcher CLI

`mrw` is a small command-line front end over the scripts in `scripts/`. It
does not reimplement any logic: every subcommand resolves the tool checkout
it was installed from (`toolHome`) and execs the matching Phase-1 script,
propagating its exit code. Skills (`/setup-workspace`, `/open-task`, …) and
the raw scripts keep working unchanged — `mrw` is an additional entry point,
not a replacement.

See `docs/mrw-cli.md` for the longer-term design (a `.mrw/config.json`
workspace model, link-based ticket triage, native-path parity). None of that
is implemented here — this slice only wires up the dispatcher.

## Install

From inside `cli/`:

```
npm link
```

This puts `mrw` on your `PATH`, pointing at `cli/mrw.mjs` in this checkout.
Alternatively, just add `cli/mrw.mjs` to your `PATH` directly (it is already
executable), or invoke it with an absolute path: `node <repo>/cli/mrw.mjs …`.

`mrw` resolves its tool checkout from its own install location
(`import.meta.url`), not from your current directory — so once installed, it
works the same from any cwd.

## Subcommands

| Subcommand | Action |
|---|---|
| `mrw help` / `-h` / `--help` / no args | print usage |
| `mrw config` | print resolved `toolHome`, `state_root`, and repo names from `config/repos.json` |
| `mrw config --state-root <abs>` | set `.state_root` in `config/workspace.json` (absolute path required) |
| `mrw config --state-root ""` | clear `.state_root` back to the legacy default (== `toolHome`) |
| `mrw setup [args...]` | exec `scripts/setup-workspace.sh` (e.g. `--skip-clone`, `--dry-run`) |
| `mrw infra-up [args...]` | exec `scripts/devcontainer-up.sh` (args forwarded to `docker compose up`) |
| `mrw infra-down [args...]` | `docker compose -f .devcontainer/docker-compose.yml down` from `toolHome` |
| `mrw task-up --ticket <ID> [--repos a,b] [--title t] [--purpose p] [--url u] [--no-sandbox] [--yes] […]` | exec `scripts/create-workspace.sh --phase all --ticket <ID> […]`. `--url` is mapped to `--ticket-url`. A bare positional (`mrw task-up ABC-123`) is treated as the ticket ID when `--ticket` is omitted. |
| `mrw list [args...]` | exec `scripts/list-task.sh` |
| `mrw close <TICKET_ID> [--force]` | exec `scripts/remove-workspace.sh` |
| `mrw doctor [args...]` | exec `scripts/verify-workspace.sh` |
| unknown subcommand | error + usage, exit 2 |

## `mrw config --state-root`

`config/workspace.json`'s `.state_root` is edited in place: only the
`"state_root"` line's value is changed, so every other key (including the
`_note` fields), the 2-space indentation, blank lines, and the trailing
newline are preserved untouched. Setting a value and then clearing it back to
`""` leaves the file byte-identical to before.

## Deferred (later slices)

- Moving config into a per-workspace `.mrw/config.json` (git-style discovery,
  multiple independent workspaces).
- Link-based ticket triage inside `task-up` (currently requires an explicit
  `--ticket <ID>`; passing only a URL/link errors out).
- Native-path parity / non-macOS support.

None of the above are touched by this slice — `mrw` only dispatches to the
existing scripts.
