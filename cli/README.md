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
| `mrw task-up [--ticket <ID>] --from <ref> [--no-triage] […]` | fetches a ticket body via `scripts/lib/ticket-sources/<ticket_source>.sh fetch <ref>` (adapter chosen by `config/workspace.json`'s `.ticket_source`), then (unless `--no-triage`) auto-triages it — see below. |
| `mrw task-up --ticket <ID> --body-file <path> [--no-triage] […]` | reads the ticket body from a local file instead of fetching it; otherwise behaves like `--from`. |

### `--from` / `--body-file` / `--no-triage` (ticket-up triage leaf)

`task-up` can auto-fill `--title`/`--repos` and record a `work_type` from a
ticket's text, via the harness's bounded, read-only, typed triage leaf
(`harness/src/triage.ts`, run host-side, outside any cage — it never touches a
repo checkout and can only Read/Grep/Glob, never Edit/Write/Bash).

- **Body resolution**, in priority: `--body-file <path>` (read a local file) >
  `--from <ref>` (adapter fetch) > none. A `--from` fetch failure (e.g. the
  `github-issues` adapter's `gh` CLI is missing or unauthenticated) is a HARD
  error — you explicitly asked for that fetch, so `task-up` exits non-zero
  rather than silently continuing.
- **Triage itself degrades gracefully**, unlike a `--from` fetch failure: if no
  Claude credential is available (neither `CLAUDE_CODE_OAUTH_TOKEN` /
  `ANTHROPIC_API_KEY` is set, nor is the macOS Keychain entry `security
  find-generic-password -s claude-code-oauth-token -w` present), or the
  triage subprocess fails or returns unparseable/malformed output, `task-up`
  WARNS to stderr and proceeds to create the task without triage. Triage
  failing never blocks task creation.
- **Explicit flags always win** over triage-derived values: `--title`/
  `--repos` you pass yourself are never overridden.
- **Ticket ID derivation**: `--ticket` wins if given; a bare positional ID
  (existing behavior) wins next; otherwise, if `--from` is a GitHub-issue-style
  ref (`https://github.com/o/r/issues/N` or `o/r#N`), the ID defaults to
  `GH-<N>` (matches the default `ticket_id_pattern`, `^[A-Z]+-...`). If none of
  those resolve an ID, `task-up` errors asking for `--ticket <ID>`.
- A short triage summary (`work_type`, `title`, `repos`, `summary`) is printed
  before the task is created. `MRW_WORK_TYPE=<work_type>` is exported into
  `create-workspace.sh`'s environment for that run only (see the deferred item
  below).
- A fetched ticket body is deliberately **not** written to `docs/task.md` —
  `create-workspace.sh`'s own `finalize` phase scaffolds that file from a
  template only if it doesn't already exist, and racing that write risks
  fighting its own idempotent scaffolding. `task-up` instead prints a note
  that the body was fetched, so you can paste it in yourself.
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
- Native-path parity / non-macOS support (the Keychain credential fallback for
  triage is macOS-only, same as `devcontainer-up.sh`).
- **`work_type` → telemetry wiring is per-run, not per-ticket.**
  `MRW_WORK_TYPE` is exported into `create-workspace.sh`'s environment for the
  duration of that one invocation, which is enough to record it — but the
  OTEL stack (`telemetry.ts`'s `telemetryEnv`) currently reads
  `MRW_WORK_TYPE` as a single **stack-level** env var, not something persisted
  per-ticket. Wiring a triaged `work_type` all the way through to a task's own
  telemetry attributes (surviving process restarts, `/start-task`, etc.) is a
  follow-up.
- **`--from` is gated on the configured `ticket_source` adapter actually being
  able to fetch.** The `github-issues` adapter requires the `gh` CLI
  installed and authenticated; the `manual` adapter (the default) never
  fetches at all — pass `--body-file` (or write `docs/task.md` yourself,
  post-creation) with that adapter. Live, end-to-end triage runs against a
  real ticket are intentionally left to manual/operator verification — this
  layer's automated tests are schema-only (no live Claude API call).

None of the above are touched by this slice beyond what's documented above —
`mrw` only dispatches to the existing scripts (plus the harness's triage leaf,
which itself only reads and never edits).
