# `mrw` — thin dispatcher CLI

`mrw` is a small command-line front end over the scripts in `scripts/`. It
does not reimplement any logic: every subcommand resolves the tool checkout
it was installed from (`toolHome`) and execs the matching Phase-1 script,
propagating its exit code. Skills (`/setup-workspace`, `/open-task`, …) and
the raw scripts keep working unchanged — `mrw` is an additional entry point,
not a replacement.

See `docs/mrw-cli.md` for the longer-term design (link-based ticket triage,
native-path parity). Relocatable per-workspace config now IS implemented (see
"Per-workspace config (`.mrw/`)" below) — it keeps the same filenames as
`config/` (`workspace.json`, `repos.json`, `purposes/`, `broker-policy.json`)
rather than consolidating into a single `config.json`.

## Per-workspace config (`.mrw/`)

Config (`workspace.json`, `repos.json`, `purposes/`, `broker-policy.json`) can
live in a per-workspace `.mrw/` directory instead of only
`<toolHome>/config` — so multiple independent workspaces (different repo
sets AND different `allowed_push_orgs`) can coexist from the same tool
checkout.

`config_dir` (the directory holding those files) resolves, in priority:

1. `$MRW_CONFIG_DIR` if set and non-empty.
2. the nearest ancestor `.mrw/` directory (one that **contains**
   `workspace.json`), found by walking up from the current directory to `/`.
3. `<toolHome>/config` (the legacy, single-workspace default).

Resolution via (1) or (2) is **workspace mode**; via (3) is **legacy mode**.
`mrw` and host scripts resolve this consistently via the CLI and
`scripts/lib/common.sh`. During `mrw setup`, `setup-workspace.sh` bakes the
canonical config path into workspace-scoped git config; `.githooks/pre-push`
reads it through the matching `includeIf`, rejects repo-local/worktree copies
as tampering, and fails closed if the explicit baked target is unusable. Its
walk-up remains only as a compatibility fallback for legacy or
not-yet-reconfigured workspaces. **With no `.mrw/` above the current
directory and `MRW_CONFIG_DIR` unset, this is byte-identical to the pre-`.mrw/`
behavior** (`config_dir == <toolHome>/config`).

`state_root`'s default also changes shape slightly: it now defaults to the
**workspace base** (in workspace mode, the directory that holds `.mrw/`; in
legacy mode, `toolHome` — unchanged) rather than always `toolHome`. An
explicit absolute `.state_root` in `workspace.json` still wins either way.

Use `mrw init [dir]` to scaffold a new per-workspace `.mrw/` (see below), then
edit its `repos.json` / `workspace.json` (`allowed_push_orgs` etc.) and
`broker-policy.json` for that workspace.

**Security note:** `allowed_push_orgs` and `broker-policy.json` are now
per-workspace — each `.mrw/` has its own push-org allowlist, enforced by
`.githooks/pre-push` (native path, defence-in-depth) and, authoritatively for
the container path, by the publish broker reading its per-workspace
`broker-policy.json` (bind-mounted from `config_dir`, see
`.devcontainer/docker-compose.yml`'s `${MRW_CONFIG_DIR:-../config}`).

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
| `mrw config` | print resolved `toolHome`, `config_dir` (+ workspace/legacy mode), `state_root`, and repo names from `config_dir/repos.json` |
| `mrw config --state-root <abs>` | set `.state_root` in `config_dir/workspace.json` (absolute path required) |
| `mrw config --state-root ""` | clear `.state_root` back to the default (workspace base — `toolHome` in legacy mode) |
| `mrw init [dir]` | scaffold a new per-workspace `.mrw/` in `[dir]` (default cwd): copies `workspace.json`, `repos.json`, `purposes/`, `broker-policy.json` from `<toolHome>/config` as a starting point. Refuses if `<dir>/.mrw/` already exists. Prints next steps (edit `repos.json`/`allowed_push_orgs`, then `mrw setup`). |
| `mrw setup [args...]` | exec `scripts/setup-workspace.sh` (e.g. `--skip-clone`, `--dry-run`) |
| `mrw infra-up [args...]` | exec `scripts/devcontainer-up.sh` (args forwarded to `docker compose up`) |
| `mrw infra-down [args...]` | `docker compose -f .devcontainer/docker-compose.yml down` from `toolHome` |
| `mrw task-up --ticket <ID> [--repos a,b] [--title t] [--purpose p] [--url u] [--no-sandbox] [--yes] […]` | exec `scripts/create-workspace.sh --phase all --ticket <ID> […]`. `--url` is mapped to `--ticket-url`. A bare positional (`mrw task-up ABC-123`) is treated as the ticket ID when `--ticket` is omitted. |
| `mrw task-up [--ticket <ID>] --from <ref> [--no-triage] […]` | fetches a ticket body via `scripts/lib/ticket-sources/<ticket_source>.sh fetch <ref>` (adapter chosen by `config/workspace.json`'s `.ticket_source`), then (unless `--no-triage`) auto-triages it — see below. |
| `mrw task-up --ticket <ID> --body-file <path> [--no-triage] […]` | reads the ticket body from a local file instead of fetching it; otherwise behaves like `--from`. |
| `mrw list [args...]` | exec `scripts/list-task.sh` |
| `mrw close <TICKET_ID> [--force]` | exec `scripts/remove-workspace.sh` |
| `mrw doctor [args...]` | exec `scripts/verify-workspace.sh` |
| `mrw chat <TICKET_ID> [--repos a,b] [--purpose p] [--resume] [instruction...]` | exec `scripts/chat-up.sh` — Thread C chat frontend (`docs/mrw-chat.md`): Claude Code itself as the orchestrator chat UI, over a generated, pinned config (deny-posture `settings.json`, persona `CLAUDE.md`, `.mcp.json` spawning the `spined` MCP daemon). **Container-only** — refuses if the devcontainer stack (`orchestrator`) is not running. Renders `STATE_ROOT/chat/<TICKET_ID>/` (refusing any resolved path with a `tasks/` segment — worker-writable state must never hold this config), runs `spine-prepare` in-container (worktrees + a freshly-seeded ledger; never passes `--force`, so re-running against an already-prepared ticket is refused with guidance to use `--resume` instead), stamps directory trust, then opens `claude` inside the orchestrator container — a cmux tab if available (reusing a `/open-task`-created workspace of the same name, if one exists), otherwise the command is printed (and, on macOS, copied to the clipboard) for you to run yourself. `mrw task-up` prints this command as a hint on success; it never auto-launches it. |
| `mrw serve [up]` `[--port N] [--no-open]` | boot the browser-approval page (compose profile `serve`, `--no-deps` — a running `broker` is never recreated); mints a fresh session token and prints (on macOS also opens) a tokened `http://localhost:<port>/?token=<token>` URL. Warns, but does not fail, if `broker` isn't running yet. |
| `mrw serve down` | stop it: `docker compose --profile serve rm -sf serve` |
| `mrw serve url` | reprint the tokened URL for an already-running `serve` container (reads its published port and session token back via `docker port`/`docker inspect`) |
| `mrw serve status` | `docker compose ps serve` |
| unknown subcommand | error + usage, exit 2 |

### `--from` / `--body-file` / `--no-triage` (ticket-up triage leaf)

`task-up` can auto-fill `--title`/`--repos` and record a `work_type` from a
ticket's text, via the harness's bounded, tool-less, typed triage leaf
(`harness/src/triage.ts`, run host-side with all built-in tools denied,
`settingSources: []`, and an inert cwd — it never touches a repo checkout).

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
## `mrw config --state-root`

The active `config_dir`'s `workspace.json` (`<toolHome>/config/workspace.json`
in legacy mode, `<workspace-base>/.mrw/workspace.json` in workspace mode —
see "Per-workspace config" above) has its `.state_root` edited in place: only
the `"state_root"` line's value is changed, so every other key (including the
`_note` fields), the 2-space indentation, blank lines, and the trailing
newline are preserved untouched. Setting a value and then clearing it back to
`""` leaves the file byte-identical to before.

## Browser approval (`mrw serve`)

Thread B (see `docs/mrw-cli.md`'s "Thread B" section) adds a **separate,
token-less** process that renders the broker's sha-typed publish gate as a
GitHub-PR-style web page instead of (or alongside) the broker container's
TTY prompt. `mrw serve` never holds `BROKER_GITHUB_TOKEN` and cannot push —
it relays a typed short-sha decision to the broker over a new unix socket
(`approve-sock`), and the broker independently re-verifies the submitted sha
against the actual pending publish before anything is pushed, so a
compromised `serve` can never approve a different sha, target, or content
than the one already pending.

`mrw serve up` (the default when no action is given) starts the `serve`
compose service under its own `profiles: ["serve"]` gate — a plain `mrw
infra-up` never starts it — publishes it on `127.0.0.1:<port>` only, and
prints a session-tokened URL to open. `mrw serve down|url|status` stop it,
reprint the URL, or show its container status, respectively. Full setup,
UI guide, customization reference (`config/serve.json` + `serve.css`), and
the security/trust-model writeup live in
[`../docs/browser-approval.md`](../docs/browser-approval.md) (see also its
Japanese mirror, `browser-approval.ja.md`).

## Deferred (later slices)

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
