# `mrw` CLI — decoupling the tool from its state (design memo)

**Status: DESIGN PROPOSAL (not built).** Companion to
[architecture.md](architecture.md) (the security layers) and
[agent-orchestration.md](agent-orchestration.md) (the container control plane).
This memo settles how `muti-repo-workspace` stops *being* the workspace and
becomes a **`mrw` binary** that operates on a workspace directory you point it
at — without giving up a single security invariant.

> 🇯🇵 日本語版: [mrw-cli.ja.md](mrw-cli.ja.md)

## Motivation

Today the checkout is two things at once:

- a **tool** — skills, `harness/`, `broker/`, `reviewer/`, `templates/`,
  `.devcontainer/`, `scripts/`; and
- a **container for generated state** — `repositories/` (worktree origins) and
  `tasks/` (per-ticket worktrees), both gitignored.

You must `cd` into the checkout and start `claude` there to do anything. The
state and the tool share one directory and one lifecycle. That coupling makes
three things awkward: you cannot keep several independent workspaces (different
repo sets) side by side; upgrading the tool means reconciling it with local
generated state in the same tree; and the "console" is a Claude session whose
cwd *is* the tool, so the tool cannot be installed once and reused.

**Goal:** install the tool once; keep `repositories/`- and `tasks/`-equivalent
state in a directory you choose; drive the lifecycle with a small deterministic
CLI. The smartness stays where it already is (the per-task Claude session); the
CLI is dumb authority — it only performs procedures.

## Target UX

```
# once, at adoption
mrw config                 # initialize a workspace: choose its dir, register repos

# start of the day, after boot
mrw infra-up               # bring the container stack up for this workspace

# start of a task
mrw task-up https://…      # create worktrees + cmux tab for one ticket
                           #   ends with a BOUNDED Claude SDK step: triage the
                           #   ticket (type / title / repos), typed output only

# move to the new cmux terminal workspace
# → interactive Claude session (plan / worker / review / publish), as today
```

This is exactly today's skill flow (`/setup-workspace`, `/open-task`, …) with
two changes: the deterministic procedures become real subcommands instead of
skill-markdown-Claude-executes, and the state they read/write lives outside the
tool checkout.

## What moves to the binary, what stays in Claude

| Concern | Home | Why |
|---|---|---|
| config / infra-up / task-up / close / list / doctor | **`mrw` binary (deterministic code)** | Already "dumb authority." Skill markdown → real code is *stricter*, not looser: invariants become asserted, not assumed. |
| ticket triage inside `task-up` | **bounded Claude SDK leaf** | Read-only, classification only, typed output `{work_type, title, repos, summary}` — same shape as the harness's `runPlan`/`runReview`. Smartness fenced in by the type. |
| plan / implement / review / the human dialogue | **per-task Claude session** | Judgment + conversation. Opened in the cmux tab after `task-up`, unchanged. |

The split *reinforces* the existing philosophy ("authority outside the cage,
and authority is dumb"): the decision logic scattered across skill markdown
collapses into one code path that can enforce the path-encoded invariants
(below) mechanically.

## Workspace & config model

Git-style discovery. `mrw` walks up from the cwd to find `.mrw/config.json`;
`mrw config` creates it.

```
~/my-workspace/            # any directory you choose; `mrw config` runs here
  .mrw/config.json         # workspaceRoot, repos[], stack name/id
  repositories/            # worktree origins (default: here; overridable in config)
  tasks/                   # per-ticket worktrees
```

`.mrw/config.json` absorbs today's `config/workspace.json` + `config/repos.json`
(same fields: `allowed_push_orgs`/`_hosts`, `default_purpose`, `ticket_source`,
`ticket_id_pattern`, `branch_prefix`, `repositories[]`), plus:

- `workspaceRoot` — absolute path holding `repositories/`/`tasks/` (default: the
  dir containing `.mrw/`).
- `stack` — a compose project name derived from `workspaceRoot`, so **multiple
  workspaces run their own stack side by side** (a global `~/.config` cannot).

Tool assets (`harness/`, `scripts/`, `docker/`, `.devcontainer/`, `templates/`,
`broker`/`reviewer` image definitions) resolve from the **binary's own install
path** (`toolHome`), never from the workspace. State and tool are now two
independent sources — but see three complications the naive split hides:

- **`config/broker-policy.json` is baked into the broker image at build time**
  (`broker.Dockerfile`: `COPY config/broker-policy.json …`) and is the
  *authoritative* push-org/host enforcement point (the broker enforces it
  in-process; the pre-push hook is defence-in-depth, not the gate). If it stays
  a `toolHome` asset baked once, **every workspace sharing that install inherits
  the same `allowed_push_orgs`** — which breaks per-workspace isolation for the
  one file where org divergence matters most. It must become **per-workspace
  state, mounted into the broker at runtime** (not `COPY`d at build), so
  `mrw infra-up` binds `${workspaceRoot}/.mrw/broker-policy.json`. This is a
  required change, not optional.
- **`config/purposes/*.json`** (`dev.json`/`task.json`: `default_repos`,
  `mcp_servers`, `dev_kinds`, read by `open-task`) is a whole config *directory*
  — a *task profile* (which repos + MCP servers a task opens), whose name also
  happens to be the OTEL `purpose=` label. **Decision:** it stays a `toolHome`
  default; no per-workspace override for now (deferred — profiles are not the
  priority, and the OTEL label already flows from the profile name). Revisit if
  a workspace ever needs its own profiles.
- **`WORKSPACE_ROOT` is one overloaded variable today**: `scripts/` and the
  orchestrator `denyWrite` template use a single `{{WORKSPACE_ROOT}}` token for
  *both* tool assets (`.githooks`, `scripts`, `templates`, `.claude`) and state
  (`config`, `repositories`, `tasks`). The split's real work is **bifurcating
  that one token into `toolHome` vs `workspaceRoot` across every script and
  template** — not just the three named invariants below.

## The load-bearing compose change

`.devcontainer/docker-compose.yml` binds everything relative to `..` (the repo
root) onto the fixed container path `/workspaces/muti-repo-workspace`. The
container-internal layout can stay fixed; only the **host side** changes, and it
splits into two sources:

| Container path | Today (host) | Target (host) | Access |
|---|---|---|---|
| `…/tasks` | `../tasks` | `${workspaceRoot}/tasks` | rw (worker) |
| `…/repositories` | `../repositories` | `${workspaceRoot}/repositories` | :ro |
| `…/harness`, `…/scripts` | `../harness`, `../scripts` | `${toolHome}/harness`, `${toolHome}/scripts` | :ro |
| whole `…` (**orchestrator + broker** :ro) | `..` | **composed** {`${toolHome}` ∪ `${workspaceRoot}` state} :ro | :ro |

The last row is the subtle one: the **orchestrator and broker** currently mount
the *entire* repo (`..`) read-only as one fact. Externalizing splits that single
mount into tool-assets-ro + state-ro. (The **reviewer needs zero compose
changes here** — it has *no* workspace mount at all; everything it runs is baked
into its image, and it sees only its socket and `review-diffs:ro`.) `mrw
infra-up` **generates** the compose (or a compose + override) with absolute
paths from config; the hand-maintained relative compose goes away.
`BROKER_WORKTREES_DIR` is pinned by `mrw` per task to
`${workspaceRoot}/tasks/<T>/repositories`.

Two more host-relative things the generator must rewrite, easy to miss because
they are not `volumes:` binds:

- **`build.context`.** Every service builds from `context: ..` (egress-proxy
  from `../docker/egress`); these Dockerfiles are `toolHome` assets, so the
  generated compose points `build.context` at `${toolHome}`, not the workspace.
- **Named-volume state is a *third* location, not on the host FS at all.**
  `spine-notes` (the orchestrator's `MRW_STATE_DIR` invariant ledger) and
  `review-diffs` are Docker-managed named volumes scoped to the compose project.
  They are neither `toolHome` nor files under `workspaceRoot`, so "state and
  tool are two sources" is really *three*. **Decision:** these hold operational
  *history* (the invariant ledger, reviewed diffs), so the default is to
  **preserve** them; `mrw close --purge` explicitly drops them. Never auto-delete
  history on the safe path.

## `task-up`'s bounded triage step

After the deterministic work (worktree add, template render, cmux tab), `mrw
task-up` runs one **read-only, typed** Claude SDK query over the fetched ticket
text and returns:

```
{ work_type: string, title: string, repos: string[], summary: string }
```

This is the natural home for `work_type`, which the OTEL telemetry work
(devcontainer-status item 10) deliberately left as a fixed `feature`/`auto`
value. `task-up` can derive it once and set `MRW_WORK_TYPE` for the ticket's
containers, whence the existing self-derivation mechanism
(`harness/src/telemetry.ts`) carries it into `OTEL_RESOURCE_ATTRIBUTES`.

**Be honest about the trust boundary this moves.** Today `work_type` comes
*only* from an operator-set `MRW_WORK_TYPE` — explicitly never from ticket or
request content, "so a coder cannot pick its own `work_type`." Deriving it from
a classifier that reads the fetched ticket text means the value is now
influenced by ticket content, which for `ticket_source: github-issues` is
externally supplied. That is acceptable **only** because: (a) `work_type` is a
telemetry *label*, fail-open, and "fake data" is already an accepted risk of the
`mrw-telemetry` network; (b) the classifier output is constrained to a
**validated vocabulary** (an enum/regex, not free-form), so it cannot inject
attribute syntax; and (c) it is set **host-side, outside the cage, by the
operator-run `task-up`** — the caged coder still cannot choose it. It must never
be extended to anything authoritative (push targets, policy) — those stay
operator/`broker-policy` owned. The step itself is bounded exactly like
`runPlan`: `READ_ONLY_TOOLS` + `DENY_MUTATION`, `settingSources: []`, structured
output. It never edits and never chooses what to publish.

## Migration hazards (must not silently regress)

1. **Compose absolute paths** (above) — the meatiest mechanical change; the
   whole point of `mrw infra-up` generating compose from config.
2. **The pre-push hook self-locates its config by path — doubly broken by the
   split.** `.githooks/pre-push` derives its config as
   `$(dirname $(dirname $0))/config/workspace.json` — walking up from wherever
   `.githooks` is installed, with the filename hard-coded. The split breaks this
   two ways: (a) if `.githooks` is a `toolHome` asset while config lives under
   `workspaceRoot`, the dirname-walk resolves to the *wrong tree*; (b) the
   filename itself changes (`config/workspace.json` → `.mrw/config.json`). The
   hook must be taught its config location explicitly (env or a generated path),
   not by walking up from its own install dir. This is a more concrete hazard
   than the three "path-encoded invariants" originally imagined.
3. **`WORKSPACE_ROOT` bifurcation** (see the config-model complications above):
   every `scripts/` reference and every `{{WORKSPACE_ROOT}}` template token must
   be split into `toolHome` vs `workspaceRoot`. The orchestrator `denyWrite`
   list is the sharp edge — it currently lists `.githooks`/`scripts`/`templates`
   /`.claude` (tool assets) *and* `config` (state) under one token.
4. **Worktree creation rule.** The CLAUDE.md rule ("relative target, no command
   chaining") exists because a Claude ran the command. `mrw` runs it in code
   with `git -C <origin> worktree add <computed-path> …`; the rule becomes an
   implementation detail of one function, not a prompt-time hazard.

Note on what *isn't* newly fragile: the orchestrator `excludedCommands` ↔
`CLAUDE.md` byte-match is **already guaranteed by construction** —
`scripts/lib/common.sh`'s `render_template()` substitutes one shared path value
into both files in a single pass, so any path (home-relative or absolute) stays
consistent post-split. A `mrw doctor` (mount audit, egress self-check, config-
discovery check for hazard 2, `denyWrite` bifurcation check for hazard 3) is
still worth having, but the byte-match is not the thing it needs to rescue.

## Thread B — browser approval (independent, ships separately)

**Status: BUILT** — see [browser-approval.md](browser-approval.md).

The user's sketch (steps 5–6) shows the approval moving to a browser: diff
summary, review result, full diff, then approve. This is a good rendering
upgrade but touches the **one authoritative gate** in the whole design, so:

- **Keep SHA-typing as the approval act.** The broker's short-SHA gate is the
  only authoritative human gate; typing the SHA *proves the human saw that
  specific commit*. A one-click button degrades that to one-bit consent. The
  page renders diff summary / advisory reviewer verdict / full diff beautifully,
  but approval still requires typing the short SHA into the page.
- **Treat the approval server as attack surface.** A local HTTP endpoint that
  can approve a push must be **localhost-bound with a per-session token / CSRF
  protection**; otherwise any local process or drive-by page can POST an
  approval. The broker stays LLM-free; the reviewer verdict renders as advisory
  text only.
- **The listener lives in a separate `mrw serve`, not in the broker
  (decided).** Today the broker exposes *no* host port — only a UNIX socket plus
  a TTY readline for `approve.ts`. It is also the sole holder of
  `BROKER_GITHUB_TOKEN` and the only cage with real internet egress; its
  container split exists precisely to isolate that token. Putting an HTTP
  listener *inside* the broker would grow the token-holder's attack surface, so
  instead a separate, **token-less** `mrw serve` process renders the page and
  relays the approval to the broker over the existing socket. Crucially the
  broker **does not trust `mrw serve`**: it independently re-verifies the typed
  short SHA against the pending publish before pushing, so the authoritative
  gate stays inside the token-holder and a compromised `mrw serve` cannot push
  on its own.

  ```
  browser ──HTTP(localhost+token)──▶ [ mrw serve ]  (no token, cannot push)
                                          │ UNIX socket
                                          ▼
                                     [ broker ]  (token, SHA re-verify, push) ──▶ GitHub
  ```

This is orthogonal to Thread A and can land before or after it.

## Phasing

1. **Externalize state, keep skills** (smallest *useful* step, but not small):
   bifurcate `WORKSPACE_ROOT` into `toolHome`/`workspaceRoot` across scripts and
   templates, generate compose from config, move `broker-policy.json` to a
   runtime mount, and teach the pre-push hook its config path — *without* the
   binary yet. This is where the compose + invariant work is proven in
   isolation; it is the bulk of the risk.
2. **`mrw` binary** wraps the (now path-clean) procedures as subcommands;
   skills become thin shims or are retired.
3. **`task-up` triage leaf** — wire the bounded classifier; retire the fixed
   `work_type`.
4. **Browser approval** (Thread B) — independent.

## Invariants unchanged

Egress allowlist (Squid) and the `mrw-telemetry` internal network; the 5-role
containment model and per-role sandboxes; broker LLM-free with the SHA gate as
the sole authoritative approval; worker never holds the broker socket;
`allowed_push_orgs`/`_hosts` enforced **in-process by the broker** (via
`broker-policy.json`, now per-workspace) with the pre-push hook as
defence-in-depth. This memo relocates *where state lives* and *who runs the
procedure* — not what is contained.
