# `mrw chat` — Claude Code as the chat frontend (design memo)

**Status: DESIGN AGREED (2026-07-16), not built — Thread C of the `mrw` effort.**
C1 spike **passed (GO)** and an independent adversarial review returned
SHIP-WITH-FIXES the same day; both are incorporated below. Companion to
[agent-orchestration.md](agent-orchestration.md) (the spine / M1–M4 control
plane this memo puts a face on) and [mrw-cli.md](mrw-cli.md) (Threads A & B).
Decided interactively with the operator on 2026-07-16.

> 🇯🇵 日本語版: [mrw-chat.ja.md](mrw-chat.ja.md)

## Motivation

The M2 chat surface (`npm run chat` → `spine/repl.ts`) is a bare readline REPL,
and it shows:

- assistant text streams as raw stdout — no markdown, no color;
- **tool calls are invisible** — a `run_worker` can run for minutes with zero
  feedback (no spinner, no elapsed time, no "what is it doing");
- no interrupt (Esc), no persistent input history, no multi-line editing,
  no resume;
- `/quit` is the only command; no status (ticket / repos / budget);
- publish approval prints a 200-line-truncated diff with a `y/N` line.

Goal: **Claude Code-grade interactive experience** for the orchestrator chat,
**without** coupling UI work to engine work — the interface layer must be
independently improvable while engine logic (executor / ledger / steps /
workerd / broker) evolves on its own thread.

## Decision

**Use Claude Code itself as the frontend.** The spine engine is exposed to an
interactive Claude Code session as an **MCP server**; the session's LLM can
only *propose* spine actions by calling typed MCP tools, and the coded spine
still *disposes*. Claude Code is NOT used "bare": it runs inside the existing
orchestrator container cage, under a **generated, pinned configuration**
(deny-posture settings, persona CLAUDE.md, `.mcp.json`, version-pinned CLI).

What this buys:

- the experience is *by definition* Claude Code-grade (markdown, streaming,
  tool-call display, live progress, Esc interrupt, history, `--continue`
  resume, slash commands), and future Claude Code improvements arrive free;
- the UI/engine seam becomes the **MCP tool contract** — UI iteration is
  config/persona/template work; engine iteration is daemon work; neither
  blocks the other;
- zero TUI code to build or maintain.

Rejected alternatives:

- **Custom TUI (Ink) over a typed event protocol** — maximal freedom and a
  clean allowlist posture, but reaching (and keeping) Claude Code parity is a
  standing engineering project of its own. Kept as the **fallback ("B-lite")**
  — no longer expected to be needed: the C1 spike confirmed the experience
  core (see Phases).
- **Browser chat inside `mrw serve`** — richest rendering, but diverges from
  the terminal/cmux workflow and depends on Thread B, which is not started.

Non-interactive LLM leaves (triage / plan / review / worker steps) are **not
touched**: they stay on the Agent SDK with typed schemas and pinned read-only
postures. Only the one genuinely conversational surface — the orchestrator
chat — moves onto Claude Code.

## Architecture

### New pieces (all additive)

- **`harness/src/spined/`** — a stdio MCP server wrapping the *existing*
  executor/ledger (same pattern as `workerd/`: thin protocol adapter, no new
  capability). Spawned by the frontend via `.mcp.json`; receives
  `--ticket/--repos/--purpose` on argv from the generated config.
  - **Prepare is the launcher's job, not the daemon's**: `mrw chat` runs the
    worktree setup + ledger seeding (today's `spine/index.ts` `cli()` preamble)
    as an explicit in-container prepare step *before* opening the session, so
    spined starts instantly (stdio MCP servers have a startup timeout) and
    only **loads** the ledger. A missing ledger is a fail-closed startup error
    naming the prepare command.
  - Tools exposed: `run_worker`, `run_tests`, `plan_repo`, `review_diff`,
    `request_publish`, `status`, `done`, `abort`. `status` is **budget-exempt**:
    it reads a read-only ledger snapshot *outside* `executor.dispatch()`
    (every dispatched action burns budget by design; a "summon any time"
    status must not).
  - **Single instance per ticket**: spined takes an exclusive lockfile in the
    ledger dir; a second daemon (second chat tab) on the same ticket fails
    closed with a clear message. Without this, two executors would double the
    budget rails and last-writer-win the ledger. The **legacy REPL does not
    take this lock yet** — chat + REPL concurrency on one ticket stays
    unenforced until the REPL adopts it (tracked for C4).
  - **Keep-alive progress**: during a long dispatch (`run_worker`, minutes)
    the daemon emits coarse MCP progress notifications from a timer
    ("run_worker … Ns elapsed", ~10 s cadence). C1 proved these render live
    in the TUI. This is boundary-side narration only — *workerd-internal*
    progress streaming stays out of scope (see below).
  - `ask_human` / `show_human` are **not exposed** — the chat itself is the
    human channel now. They remain in the executor for the legacy REPL path,
    which stays intact as the headless/fallback frontend.
- **Generated frontend config — rendered to an orchestrator-only surface.**
  The trusted host-side launcher (root-console layer) renders it into
  **`STATE_ROOT/chat/<ticket>/`** — a *sibling* of `tasks/`, never mounted
  into the worker; the render target is **refused if its path contains a
  `tasks/` segment** (same guard class as `mrw init`). It reaches the
  container through the existing read-only workspace/state overlays. This
  matters: `.mcp.json` is a command line the frontend will spawn inside the
  orchestrator container, and settings.json carries the whole deny posture —
  if either were worker-writable, a compromised worker could strip the
  posture or run code in the orchestrator container (the exact vuln class
  Phase 2.2 fixed for `.mrw/`). The container-home trust stamp
  (`projects[<dir>].hasTrustDialogAccepted`) is written by the launcher, too.
  - Contents: settings.json (deny posture; `permissions.allow:
    ["mcp__spine__*"]`; `enabledMcpjsonServers: ["spine"]` so first launch
    never stalls on the MCP approval prompt; `model` rendered from the same
    source of truth as sdk.ts's `MODEL`/`HARNESS_MODEL`; OTEL env;
    `MCP_TIMEOUT`/`MCP_TOOL_TIMEOUT` pinned **above the worker step budget**
    — default 45 min — so a long `run_worker` is never client-aborted while
    the daemon is still busy), persona CLAUDE.md (today's
    `buildSystemContext()` text), `.mcp.json` (spined stdio command),
    `claudeMdExcludes` for repo paths.
- **Wiring**: `mrw chat <ticket>` (and `mrw task-up` at the end) runs the
  prepare step, renders the config, then opens the cmux tab running `claude`
  inside the orchestrator container (`docker compose exec -it orchestrator
  claude …`); resume = `--continue` in the same directory. **Container-only
  for now**: the launcher refuses when the stack is not up — run natively,
  the deny settings would be the *only* cage (no squid, no `:ro` mounts),
  which this design never claims to be safe. The orchestrator container home
  gets a named volume (`chat-home`) so conversation history survives
  container recreation.

### Deliberate engine adaptations (the honest list — no longer "zero")

All small, all specified here, all test-covered in C2; everything else in
executor/ledger/steps/workerd stays untouched:

1. **Injectable approval policy** (`in-chat` | `broker-only`, default
   `in-chat`): the y/N gates live in `executor.ts`, not the REPL, so removing
   them "from the publish path" unqualified would silently strip the legacy
   REPL too. The REPL keeps today's in-chat gates byte-identically; spined
   injects `broker-only` (no terminal to ask on).
2. **Post-ended dispatch refusal**: today the REPL loop enforces session end;
   spined has no loop, so after `done()`/`abort()` the executor itself must
   refuse further dispatches with a typed `session_ended` error.
3. **Ledger load-or-seed**: `SpineLedger` is persist-only today; resume would
   silently refill budgets and re-derive `baseSha` from *current* HEAD
   (making later review/publish bodies cover only the post-restart delta).
   The persisted ledger — baseSha, budgets, recorded verdicts — is loaded on
   daemon start; `--continue` restores the conversation, the ledger restores
   the engine.
4. **Broker-computed caveat** (see Gate policy): ~20 additive coded lines in
   the broker + tests (broker is image-baked — rebuild required).

### Posture parity (SDK options → settings)

| Today (`spine/session.ts`) | Frontend equivalent | Note |
|---|---|---|
| `tools: [Read, Grep, Glob]` (allowlist) | `permissions.deny: [Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Task, …]` | deny rules are non-bypassable in-session (doc-verified; C1-observed: denied built-ins vanish from the session entirely); **posture flips allowlist→denylist** — see drift countermeasures |
| `settingSources: []` (no CLAUDE.md) | neutral cwd (`STATE_ROOT/chat/<ticket>/`, not a repo) + `claudeMdExcludes` on repo paths | residual: same class of exposure the native-path orchestrator already accepts |
| `permissionMode: bypassPermissions` | default mode + `permissions.allow: ["mcp__spine__*"]` | no prompts left to mis-approve: built-ins denied outright, spine tools pre-allowed (requires the directory trust stamp — automated by the launcher) |
| `env: telemetryEnv(ticket,"spine")` | generated settings `env` block | same self-composed OTEL attrs, never forwarded strings |
| `MODEL` constant | settings `model` | rendered from the same source of truth (`sdk.ts` `MODEL`/`HARNESS_MODEL`) at render time — no manual lockstep |

Drift countermeasures (the honest cost of the denylist flip):

1. **Pin the `claude` CLI version in the container image** — and drop
   `coder.Dockerfile:31`'s `|| true` while at it, so a failed install fails
   the build instead of silently shipping an image without the CLI.
2. **Extend the role selfcheck** (`scripts/egress-selfcheck-role.sh` pattern)
   with an effective-posture check: drive a throwaway `claude -p` under the
   generated settings, attempt Bash/Edit/WebFetch, expect deny; attempt
   `mcp__spine__status`, expect success; verify `claudeMdExcludes` actually
   suppresses a planted nested CLAUDE.md.

### Gate policy (approved direction)

Authority is **unchanged**: the broker's human SHA-typing is the only
authoritative approval, `allowed_push_orgs/_hosts` enforced in-process by the
LLM-free broker. Changes at the boundary:

- The in-chat `y/N` gates disappear **from the spined path only**, via the
  injected approval policy (under Claude Code a chat reply would be
  model-mediated and worthless as a gate); the legacy REPL keeps them.
  `request_publish` on the spined path becomes: ledger gate (green tests +
  approving review of the CURRENT head) → broker intent → broker SHA.
- The `diffTouchesTests` caveat (test-independence warning) **moves into the
  broker**: the broker computes it itself on its ground-truth diff and prints
  a coded caveat line at the SHA gate, next to the tri-state reviewer header.
  This deliberately trades away "broker: zero changes" (~20 additive coded
  lines + tests + image rebuild) because the alternative — a caveat line
  inside the intent body — would be labeled "as sent by the coder", uncapped,
  buriable in LLM-authored plan prose, and would leak into the public PR
  body. Broker-computed = unspoofable, gate-only, invisible to the PR.
- MCP **elicitation** exists in the binary (C1), but whether it is truly
  human-only is **not verified** (the docs describe an Elicitation hook that
  can auto-respond). It is at most future polish and never a gate dependency.

### Invariants (who enforces what — unchanged rows are the point)

| Invariant | Enforced by | Under this design |
|---|---|---|
| push targets (orgs/hosts) | broker in-process + pre-push hook | unchanged (frontend has no push token) |
| authoritative approval = human SHA | broker | unchanged |
| worker containment (no broker sock, no net) | compose topology | unchanged |
| egress allowlist | squid | unchanged (claude talks to the same allowlisted api.anthropic.com) |
| budget / serial / fail-closed rails | executor + ledger | unchanged (daemon-side; + single-instance lock so they can't be multiplied) |
| LLM effects = typed actions only | SDK tool allowlist | settings deny (non-bypassable) + MCP-only effects |
| **chat config not worker-writable** | — (new surface) | launcher render-target guard (`tasks/`-segment refusal) + worker mounts; **verified in C4** |

The human operating the chat is a **trusted principal** (root-console
equivalent); "a task can never widen its own sandbox" remains a statement
about the *worker*. Single-process fallback mode loses nothing by the y/N
removal: with `BROKER_SOCKET` unset, `publish()` is a hard stub — nothing can
push.

## Phases

- **C1 — spike: DONE (2026-07-16, claude v2.1.211) → GO.**
  (a) MCP `notifications/progress` messages render **live** under the tool
  line (`⎿ step 12/45s elapsed (27%)`) with spinner / elapsed / token count /
  `esc to interrupt` — the experience core holds; (b) deny posture removes
  built-in tools from the session entirely; `permissions.allow` requires the
  directory trust accept (the dialog enumerates pre-approved tools);
  (c) `statusLine`, `claudeMdExcludes`, elicitation all exist in the binary
  (behavioral checks deferred to the C3 selfcheck). Full notes in plan.md.
- **C2 — `spined` daemon + the four engine adaptations above.**
  Acceptance: protocol-level unit tests (workerd-style); legacy REPL still
  green **with its y/N gates** (both approval policies tested); post-ended
  dispatch refused with `session_ended`; per-ticket single-instance lock;
  ledger load-or-seed with persisted `baseSha` (never re-derived on resume);
  `status` budget-exempt; broker caveat line unit-tested.
- **C3 — frontend config + wiring.** Acceptance: render-target guard refuses
  `tasks/`-segment paths; trust stamp automated; `enabledMcpjsonServers`
  present; `.mcp.json` spawns `tsx src/spined/index.ts` **directly** (an
  `npm run` wrapper prints its own banner to stdout and would corrupt the
  JSON-RPC wire before spined's stdio guard exists); pinned CLI install that fails the build on error; MCP timeouts
  pinned above the worker budget; keep-alive progress visible in a real
  session; launcher refuses when the stack is down (container-only);
  `chat-home` volume; selfcheck extension (deny posture + `claudeMdExcludes`
  behavior + `mcp__spine__status` reachability).
- **C4 — verification.** Invariant checklist re-run **including the new
  "chat config not worker-writable" row**; amend
  [agent-orchestration.md](agent-orchestration.md) (Q2 "why not the
  interactive TUI" + invariant 5 "the spine owns the terminal") to reconcile
  its recorded fail-open permission-layer measurement with this design's
  deny-rule posture and MCP-mediated effects; independent review
  (security-sensitive boundary change); live E2E on a demo ticket — chat →
  implement → tests → review → publish through broker SHA with the
  broker-computed caveat visible — plus a resume leg (`--continue` after a
  daemon restart, ledger state preserved).

Working rules as established: implementation delegated to subagents,
verification by the assistant, independent review before commit, everything on
`feat/mrw`.

## Out of scope (other threads)

- **Engine improvements** — *workerd-internal* progress (streaming what the
  worker is actually editing during `run_worker`): the MCP boundary already
  carries progress notifications, so this can land later *without UI
  changes*. The daemon-side keep-alive ticker above is in scope; real inner
  progress is not.
- **feat/mrw pre-merge blockers** (2026-07-16 review: push-guard config
  canonicalization, triage leaf posture, telemetry-network internal-ness
  check) — separate workstream, no dependency either way.
- **Thread B** (browser approval / `mrw serve`) — unchanged; this memo's gate
  policy composes with it (the browser renders the same intent + the
  broker-computed caveat; SHA stays the act).
