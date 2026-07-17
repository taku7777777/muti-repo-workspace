# Broker per-ticket routing — request-carried ticket + operator registry (design memo)

**Status: BUILT + LIVE-VALIDATED 2026-07-17.** R2 (broker) = `dedaffd`,
R3 (senders/registry/wiring) = `b621372`. R4 live run: tickets RT-1
(phase2-demo#5) and RT-2 (phase3-docs#2) published through the SAME broker
with no recreate between them — the operator exported only
`BROKER_GITHUB_TOKEN`; no `BROKER_WORKTREES_DIR` ritual. Both approval
surfaces showed the ticket badge; the tests-touched caveat fired on both
(package.json rule). Negative legs: five socket probes (unregistered /
registered+missing-repo ordering / case-alias / legacy hint /
post-deregistration), and the F6 leg — RT-1 deregistered while its gate sat
open, then approved with the CORRECT sha → `push/PR failed: ticket 'RT-1'
is no longer registered; aborting`, nothing pushed; re-registered →
re-requested → published. Known follow-ups found during R4 (out of this
memo's scope): workerd is stack-single and single-flight, so concurrent
tickets' steps contend (`workerd busy`) AND busy refusals consume worker-run
budget; `run_tests` assumes `npm test`, so a docs repo without package.json
cannot pass the gate (no per-repo TEST_COMMAND yet).
Companion: docs/mrw-chat.md (Thread C), docs/devcontainer-phase2.md (broker
contract), docs/browser-approval.md (Thread B). Found during the C4 live E2E
(ticket ETE-1 → phase2-demo#4).

## Motivation

The broker locates the git tree it verifies and pushes via
`BROKER_WORKTREES_DIR`, an env var **fixed at container start**. The legacy
stack (`scripts/devcontainer-up.sh`) starts it pointing at the generic
`<ws>/repositories` (origin clones, always `master`), while every ticket's
actual work lives in `<ws>/tasks/<T>/repositories/<repo>` on `feat/<T>`. Every
past publish (Phase 2/3, DEMO-6) worked only because the operator manually
exported `BROKER_WORKTREES_DIR=tasks/<T>/repositories` before `up` — a ritual
that was never wired into any launcher. Thread C made per-ticket sessions
self-service (`mrw chat <T>`), so the ritual was finally skipped and the C4 E2E
hit it live: `request_publish` failed `branch_mismatch` ("request branch
'feat/ETE-1' != worktree branch 'master'") **after** tests and review had
passed — a late, misleading error whose true cause is "the broker is looking at
a different tree".

Every other layer is already per-ticket (worktrees, spined + its lock, the
ledger under `/var/mrw/notes/<T>`, telemetry labels). The broker's worktree
pinning is the one layer stuck at multiplicity 1, and it is manual:

| layer | per-ticket | multiplicity |
|---|---|---|
| worktrees (`tasks/<T>/`) | yes | N |
| chat / spined (daemon + lock per ticket) | yes | N |
| ledger (`MRW_STATE_DIR/<T>`) | yes | N |
| telemetry (`workspace=<T>`) | yes | N |
| **broker worktree reference** | **no — start-time env, manual** | **1** |

Operational costs of the manual pin, observed live: the failure surfaces last
and reads as a branch problem; re-pointing requires a `--force-recreate` with
the push token re-exported in that shell; recreating drops any pending
approval for other tickets.

## Decision

Adopt **request-carried ticket routing with an operator-registered ticket
registry** (option "c+" of the 2026-07-17 discussion):

1. The publish request gains an **optional `ticket` field**. When present, the
   broker resolves the worktree at
   `<BROKER_TASKS_DIR>/<ticket>/repositories/<repo>` instead of
   `<BROKER_WORKTREES_DIR>/<repo>`.
2. The ticket claim is accepted **only if registered**: host-side (trusted)
   scripts register a ticket at task/chat creation and deregister at close, in
   a directory only the broker (ro) and the host (rw) can see. An unregistered
   ticket fails closed (`ticket_not_registered`).
3. No `ticket` field ⇒ **behavior-identical legacy path** (env-pinned
   `BROKER_WORKTREES_DIR`; diagnostics improved — see failure codes). The
   manual pin keeps working.

Alternatives considered and rejected:
- **(a) early explicit error only** — better diagnostics, but the manual
  recreate ritual (and its token/pending-approval hazards) remains. (Its
  error-clarity value is absorbed into this design: see failure codes.)
- **(b) `mrw` re-pins the broker per ticket** — automates the ritual but keeps
  publish multiplicity at 1 and *guarantees* the "recreate drops another
  ticket's pending approval" hazard whenever two tickets interleave.
- **(d) per-ticket broker instances** — cleanest isolation, but requires the
  compose generator (docs/mrw-cli.md Thread A remainder); disproportionate to
  the problem today. Not precluded later.

## What changes in the trust model (read this first)

Today "which tree the broker verifies" is an **operator-asserted fact** (its
own env, set at a human-initiated moment). This design turns it into a
**cage-asserted claim, constrained by an operator-asserted fact**:

- The broker cannot distinguish a request sent by the deterministic spine code
  from one crafted by a compromised process inside the orchestrator container.
  Anything arriving on the socket is a claim. This does not change.
- What the claim can select is only **which of the equally coder-writable
  `tasks/<T>/repositories` trees** gets verified — and only among tickets the
  **operator actually opened** (the registry is written exclusively by
  host-side scripts; no rw mount of it exists in any cage).
- Every downstream gate is unchanged: allowed_push_hosts/orgs from the
  broker-own policy, branch checks, ground-truth diff rendered from git
  objects, the human SHA-typed approval, token isolation in the broker.

Residual risk, accepted: a compromised orchestrator for T1 could request a
publish of registered ticket T2's tree. The rendered diff, branch
(`feat/T2`) and ticket badge shown at the gate are all truthfully T2's, so
the human approver sees the mismatch with the conversation they came from —
this is a confused-deputy risk bounded by the human gate, same class as the
existing "human must read the diff" reliance. Mitigation: BOTH approval
surfaces must show the ticket prominently. The `mrw serve` page already
renders a `ticket:` badge in the meta row (fixed position — title/body render
in panels below and cannot push it off-screen); the TTY gate's
`renderHeader` (broker/src/approve.ts) renders NO ticket line today — **R2
adds one**; the mitigation is not real until it lands on both surfaces
(review finding 1).

## Architecture

### Wire contract (broker/src/types.ts)

```ts
// added to PublishRequestSchema (.strict() preserved):
ticket: TICKET.optional(),
// TICKET = bare-name shape, same charset as SAFE_TICKET in config.ts:
// /^[A-Za-z0-9._-]{1,100}$/, plus the '.'/'..'/contains-'..' refinements
// BARE_REPO already has. The broker does NOT enforce the workspace's
// ^[A-Z]+- ticket format — bare-name safety + registry membership only.
```

New failure codes: `ticket_not_registered` (regex-valid but not in the
registry). A regex-invalid ticket is `invalid_request` via the schema. The
routed branch-binding failure (`actualBranch !== branch_prefix + ticket`)
reuses `branch_mismatch` with a message naming all three values. Handler
ordering: the **registry check runs BEFORE the worktree-existence check**, so
an unregistered probe cannot enumerate which worktrees exist (review finding
6). The legacy `branch_mismatch` message, when the request branch starts with
the policy `branch_prefix` but the env-pinned worktree is on the default
branch, appends a hint: "is this broker pointed at the right worktrees dir?
(BROKER_WORKTREES_DIR=<value>; per-ticket requests carry `ticket`)" — option
(a)'s diagnostic value, kept.

**Version skew** (review finding 2): the broker is image-baked while the
harness is re-copied at every container start, so an old broker +
ticket-sending harness fails every routed publish as `invalid_request`
(`.strict()` rejects the unknown field) — exactly the late-misleading class
this memo fixes. Mitigations, both required: (i) the harness sender, on an
`invalid_request` response to a ticket-carrying request, surfaces "broker
image predates ticket routing — run `mrw infra-up --build` (or `docker
compose build broker`)" instead of the raw error; (ii) the R3 rollout notes
name the broker rebuild as an explicit operator step.

### Ticket registry

- **Location (host)**: `<state_root>/broker-tickets/` — sibling of `tasks/`,
  generated state, gitignored. NOT under `tasks/` (coder-writable) and NOT
  under `config/` (human-edited truth).
- **Mount**: bound `:ro` into the broker at `/etc/mrw-broker/tickets/`
  (a DIRECTORY bind — the policy single-FILE bind's stale-inode lesson from
  the 2026-07-16 review applies here from day one; host scripts create/delete
  files inside it, which a file bind would pin/miss).
- **Entry**: one file per ticket, filename = `<TICKET>`, content JSON
  `{ "ticket": "<T>", "created_at": "<iso8601>" }` (content informational;
  existence is the authorization). Broker-side membership check: validate the
  ticket against TICKET **before** any path use, then **`readdir` the registry
  and require an exact string match (`===`)** — NOT a bare `lstat(path)`,
  which on a macOS-backed case-insensitive bind would accept `ete-1` when
  `ETE-1` is registered (review finding 4; R2 needs a case-alias test). The
  matched entry must be a regular file (symlink/directory rejected — fail
  closed); its content is never followed anywhere.
- **Membership is re-checked at F6** (the post-approval re-validation in
  handler.ts that already re-checks config/target/sha): a ticket deregistered
  while the gate sat open must not push (review finding 10).
- **Writers** (all host-side, trusted): `scripts/create-workspace.sh` (task-up)
  and `scripts/chat-up.sh` register; `scripts/remove-workspace.sh` (close)
  deregisters. Every registry write — including `devcontainer-up.sh`'s
  `mkdir -p` — applies the Phase-2.2 guards (`canonicalize` the longest
  existing prefix, refuse any `tasks/` path segment) before touching the
  path, so a symlinked or tasks-nested `state_root` cannot relocate the
  registry into coder-writable space (review finding 3 — same vuln class,
  same recipe as chat-up.sh's `refuse_if_under_tasks_segment`).
- **Lifecycle**: `mrw close` is the single deregistration point for BOTH task
  and chat tickets (chat tickets live under `tasks/<T>` and are closed the
  same way). Deregistration tolerates a missing entry (pre-feature tasks).
  `mrw chat --resume` re-registers idempotently — the remediation path for a
  ticket opened BEFORE the registry existed (post-implementation review
  finding: resume is such a ticket's only re-entry point, since
  spine-prepare refuses a non-resume re-run). An
  abandoned-but-unclosed chat ticket staying routable is correct by
  definition — the registry mirrors "opened by the operator and not yet
  closed", nothing narrower (review finding 5). A stale entry whose worktree
  is gone fails later as `worktree_missing` — harmless.
- **Cage visibility**: the worker mounts only `tasks/` (rw) +
  `repositories/` (ro) — it never sees the registry. The orchestrator's
  whole-workspace `:ro` mount may let it *read* the registry in legacy
  layouts; reading is harmless (names of open tickets), writing is impossible.

### Resolution (broker/src/handler.ts, config.ts)

- New env `BROKER_TASKS_DIR`, default `${BROKER_CODER_TREE}/tasks` — the
  **operator-asserted base** under which claims resolve. The claim never
  chooses the base, only the `<ticket>` segment inside it.
- New env `BROKER_TICKETS_DIR`, default `/etc/mrw-broker/tickets` — where the
  registry mount lands (review finding 9: tests need to point it at temp
  dirs; a host-run broker without it must fail visibly). An unreadable/absent
  registry dir on a ticket-carrying request fails closed as
  `ticket_not_registered` with a message naming the dir.
- With `ticket`: `wt = resolve(BROKER_TASKS_DIR, ticket, "repositories", repo)`
  followed by the same containment check `resolveWorktree` does today
  (resolved path must stay under `BROKER_TASKS_DIR/<ticket>/repositories/`),
  using already-regex-validated components. Without `ticket`: exactly today's
  `resolveWorktree(repo)` under `WORKTREES_ROOT`.
- **Branch binding**: when `ticket` is present, require
  `actualBranch === policy.branch_prefix + ticket` (worktree.sh and
  spine-prepare always create `feat/<T>`), not merely `startsWith(prefix)`.
  This pins tree ↔ ticket ↔ branch into one coherent claim the human sees.
  Legacy requests keep the prefix-only check (their branch names are not
  ticket-derived by contract).

### Senders (harness)

Both coder-side entry points already know the ticket deterministically —
the LLM never types it:
- **spined**: launched with `--ticket <T>` baked into `.mcp.json` args by the
  host-side launcher; the executor's repoDir is already
  `tasks/<T>/repositories/<repo>` in the ledger. Pass the ticket through
  `publish()`'s request. Always sent on this path.
- **classic spine / drive**: `harness/src/exec.ts`'s `deriveTicketRepo()`
  already derives `<ticket>` from the repoDir layout, but it is unexported
  and throws on non-per-ticket layouts — R3 adds an exported, non-throwing
  variant returning `null` (review finding 8). Layout not per-ticket ⇒ send
  no `ticket` — legacy path.

### Telemetry / attribution amendment

`broker/src/config.ts`'s `ticketFromWorktreesRoot()` (env-derived) remains the
attribution source for legacy requests. For ticket-carrying requests, the
broker attributes to the **validated + registered** request ticket — this
amends the invariant "the broker derives ticket from ITS OWN env, never the
coder's request" (docs/devcontainer-status.md item 10 — the invariant's only
home; item 10 now carries an AMENDED-by-item-11 annotation) to: "…never from
an **unvalidated** request value; a
ticket claim is accepted for attribution only after bare-name validation AND
registry membership, the same conditions under which the broker is willing to
*act* on it." The reviewer-consult `ticket` field forwarding keeps the same
rule. The approval header and `mrw serve` page show this same value — display
provenance changes from env-derived to claim-derived, which is exactly why the
registry precondition exists.

### Compose / launcher wiring

- `.devcontainer/docker-compose.yml` broker service: add the
  `broker-tickets` `:ro` directory bind (`${MRW_STATE_ROOT:-..}/broker-tickets`)
  and `BROKER_TASKS_DIR` env. **Coordination note:** this file is concurrently
  being edited by the pre-merge-blockers workstream (policy directory-bind
  de-bake); rebase this change on top of that landing, not vice versa.
- `scripts/devcontainer-up.sh`: `mkdir -p` the registry dir pre-up (same
  reason as the existing state-dir pre-creation: Docker would otherwise
  root-own it).
- `.gitignore`: `broker-tickets/`.

## Invariants (what changes, what must not)

| invariant | before | after |
|---|---|---|
| push token only in broker env | unchanged | unchanged |
| policy (hosts/orgs/prefix) broker-own, fail-closed | unchanged | unchanged |
| ground-truth diff from git objects, human SHA gate | unchanged | unchanged |
| worktree resolution base | operator env (single dir) | operator env (tasks base) + registered-claim `<ticket>` segment |
| broker ticket attribution | own env only | own env (legacy) / validated+registered claim (routed) |
| branch check | prefix match | prefix match (legacy) / `== prefix+ticket` (routed) |
| registry | — | host-writes-only, broker `:ro`, never coder-writable |

## Phases

- **R1** — this memo + independent review (security-boundary change: review is
  mandatory per the workspace's own rules).
- **R2** — broker: schema + registry membership (readdir exact-match) +
  resolution + branch binding + failure codes + **`renderHeader` ticket line**
  + F6 registry re-check + tests (broker/test/: incl. a case-alias entry and
  a deregistered-during-gate case). Image-baked: needs
  `docker compose build broker` — an explicit, named operator step.
- **R3** — harness: spined + classic publish senders with the version-skew
  diagnostic (+ tests); host scripts: register/deregister with the Phase-2.2
  path guards + compose/gitignore/up.sh wiring; chat-selfcheck gains a
  routed-publish probe (request with an unregistered ticket must fail
  `ticket_not_registered` — the C4 lesson: posture checks must exercise the
  path that failed live).
- **R4** — live E2E: two tickets open concurrently, a routed publish through
  the browser gate for each, **interleaved without a broker recreate** — the
  broker remains single-flight (`busy` for a second simultaneous request;
  unchanged, not a regression — review finding 11); plus the negative probe
  (unregistered ticket).

## Out of scope

- Per-ticket broker instances / compose generation (Thread A remainder).
- The pre-merge-blockers workstream (push-guard canonicalize, triage posture,
  telemetry-net check) — independent; only the compose-file rebase note above
  couples them operationally.
- Retiring `BROKER_WORKTREES_DIR` — kept for legacy/single-repo deployments.
