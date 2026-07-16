# LLM orchestrator on rails (design memo)

**Status: BUILT (M1–M3) + live-validated 2026-07-15; M4 finalized. Build
record: devcontainer-status.md items 5–7.** Companion to
[agent-roles.md](agent-roles.md) (what the roles are) and
[agent-dispatch.md](agent-dispatch.md) (how roles hand off). This memo settles
how the container path's control plane evolves: from the Phase 1–3 **coded
harness** (every decision hard-coded, LLMs as leaves) to an **orchestrator
LLM** that owns judgment and the human dialogue — without giving up a single
security invariant.

> 🇯🇵 日本語版: [agent-orchestration.ja.md](agent-orchestration.ja.md)

## Motivation

The coded harness is deterministic but rigid: gates fire at fixed points with
fixed y/N phrasing, the human cannot steer mid-flow ("tweak the plan" is not an
option), and what gets shown to the human is hard-coded rather than judged.
The macOS path's orchestrator (an interactive Claude) has the opposite
profile: flexible and conversational, but its sequencing lives inside a
semi-trusted LLM. This memo takes the middle: **the LLM proposes, a small
coded spine disposes.**

## The two kinds of decisions

The key split (from the 2026-07-15 discussion):

| Kind | Examples | Owner |
|---|---|---|
| **Flow judgment inside the cage** | re-plan or proceed; keep fixing or escalate; *what* to show the human, *when* and *how* to ask | **orchestrator LLM** — misjudgment's blast radius is bounded by the cage and the gates below |
| **Security-relevant transitions** | test gate truth; review-before-publish; bounded loops; publish only as a typed intent; human gates cannot be skipped | **coded spine** — these are invariants, not judgments |

An orchestrator LLM reads worker output — attacker-influenceable content — so
it must be treated as injectable. What an injected orchestrator must never be
able to do is not "push" (the broker guards that) but (a) skip quality gates
and (b) curate what the human sees into a lie. (a) is closed by the spine,
(b) is mitigated by the broker-side reviewer + the broker's ground-truth
rendering at the authoritative gate.

## Architecture: propose → validate → execute

```
orchestrator LLM (Agent SDK session, read-only tools)
   │  proposes ONE typed action at a time, e.g.
   │  { action: "run_worker", instruction: … }
   │  { action: "run_tests" } { action: "ask_human", question: … }
   │  { action: "request_publish", repo: …, branch: … }
   ▼
coded spine (the slimmed-down harness — a program)
   ├─ validates the action against the transition rules (invariants below)
   ├─ executes it (spawns worker session / runs tests / prompts human / sends
   │  the broker intent) — the LLM never executes anything itself
   └─ feeds the typed result back to the orchestrator session
```

This is the agent-dispatch principle ("caged roles emit typed intents; the
trusted side validates and executes") applied to flow control, and it is the
same shape as Claude Code itself (the model picks tools; the harness enforces
permissions).

## Invariants the spine enforces (coded, non-negotiable)

1. **Test truth is an exit code.** `run_tests` is executed by the spine;
   the verdict is `status === 0`. An orchestrator claim of "tests pass" is
   never an input to any transition.
2. **No publish intent without a green test gate AND an independent review**
   of the harness-computed diff, both recorded by the spine in this run.
3. **All loops are bounded** (fix attempts, worker respawns, total budget).
   Exhaustion is fail-closed, never "one more try".
4. **Publish is only ever a typed intent** over the broker socket; the
   orchestrator cannot compose git/gh commands (it has no Bash at all).
5. **Human interaction cannot be skipped or answered by the LLM.** The
   broker's sha-typed gate remains the authoritative publish approval on
   every path. On the legacy REPL path the spine additionally owns the
   terminal (`ask_human` returns what the human actually typed). On the
   Thread-C chat path ([mrw-chat.md](mrw-chat.md)) the chat itself is the
   human channel, so the in-chat y/N gates are gone *by design* (a chat
   reply would be model-mediated and worthless as a gate): the publish-path
   human act lives only at the broker, and `ask_human`/`show_human` are not
   exposed over MCP.
6. **The transition rules themselves are not writable from any cage**
   (see topology — the spine runs where neither worker nor orchestrator
   sessions can write).

Implemented in harness/src/spine/ledger.ts + executor.ts; unit-tested in
harness/test/ledger.test.ts.

## Topology: four containers + the broker-side reviewer

Decided 2026-07-15 (Q1: separate containers — the roles land in different
cells of the [agent-roles.md](agent-roles.md) boundary matrix, and separation
is what makes the rails *real*: a worker with Bash in the same container could
tamper the spine's code/state; a worker in its own container cannot).

| Container | Boundary (OS layer) | Runs |
|---|---|---|
| **orchestrator** (= the read-only judge container from agent-roles § Adoption order, extended) | worktrees **:ro**; small handoff/notes dir rw; egress anthropic-only; **holds the broker socket** | the coded spine + the orchestrator LLM session + PLAN/REVIEW sessions (same boundary cell → one profile) |
| **worker** | worktrees **rw**; egress anthropic-only; **no broker socket** | IMPLEMENT/FIX sessions, test execution |
| **broker** | LLM-free; token holder; source/policy/deps baked into the image | typed-intent validation, ground truth, sha-typed human gate, push + PR |
| **broker-side reviewer** (advisory) | write none; egress anthropic-only; input from the broker only | one review session per publish request |

Two hardenings fall out of this topology for free:

- The worker loses even the ability to *request* publish (no socket).
- The orchestrator's read-only stance is enforced by **mounts** (OS layer),
  not just `tools`/`disallowedTools` (app layer) — the app layer remains as
  role semantics, per the two-layer rule (Q3).

## The orchestrator LLM surface (Q2: SDK, with a dialogue skin)

Decision: **Agent SDK**, not the interactive TUI and not headless `-p` calls.

- The rails require typed actions and interception — that is the SDK's native
  shape (structured output, tool definitions, session continuity). The
  harness already runs on it.
- The interactive TUI is the *preferred UX* (acknowledged explicitly) but its
  agent loop cannot be railed: the spine cannot validate transitions inside
  it, and its in-app permission layer is fail-open by this workspace's own
  measurements. **Revisit if Claude Code grows harness-level hooks** that let
  an external program validate every action of an interactive session.
- **UX requirement** carried from that trade-off: the spine must provide a
  dialogue surface that approximates the interactive experience — a terminal
  chat loop where human input becomes user turns of the orchestrator session
  and the orchestrator's questions/reports stream back. The human talks to
  the orchestrator; the spine is invisible middleware. What to ask, when, and
  how to phrase it is the orchestrator's judgment (that is the point); *that
  the human is asked* at the invariant gates is the spine's.

**Thread C update (2026-07-16/17, decided with the operator —
[mrw-chat.md](mrw-chat.md)):** the revisit condition above is satisfied,
though not the way this section anticipated. Instead of hooks railing the
interactive loop, the *effects boundary moved*: the spine now also runs as a
standalone stdio MCP daemon (`harness/src/spined/`), and an interactive
Claude Code session holds no capability beyond its typed `mcp__spine__*`
tools — the loop no longer needs railing because every effect still crosses
`executor.dispatch()`. Two claims above, reconciled with the C1/C3 live
measurements (claude v2.1.211):

- *"its in-app permission layer is fail-open by this workspace's own
  measurements"* — that measurement was of the permission-**prompt** layer
  (a human can approve past an `ask`). `permissions.deny` rules measured
  the opposite: fail-closed and non-bypassable — denied built-ins are
  **removed from the session's tool set entirely**. The Thread-C posture
  uses deny outright plus pre-allowed MCP tools, leaving no prompts to
  mis-approve.
- The "dialogue surface" UX requirement is now met by Claude Code itself;
  `spine/repl.ts` remains as the headless/fallback surface.

The SDK decision in this section still stands for every non-interactive
leaf (PLAN / REVIEW / IMPLEMENT / triage) — Thread C moved only the one
genuinely conversational surface.

## Broker-side reviewer (agreed, 3 conditions + 1 extension)

1. **The broker stays LLM-free.** The reviewer is its own container; the
   broker adds exactly one outbound typed call (diff in → verdict out) with a
   timeout.
2. **Advisory only, fail-visible.** The verdict is displayed alongside the
   ground truth at the sha-typed gate; a missing/failed reviewer is shown as
   "no verdict" and the human decides. The verdict never automates a push.
3. **Input is broker-rendered ground truth only.** Coder-authored text (PR
   body etc.) may be attached but labeled untrusted/unverified.
4. *(extension, agreed)* For large diffs, hand the diff over as a **file in a
   broker-writable-only location** (e.g. a named volume mounted ro in the
   reviewer) instead of inline payload; grow this channel as needed.

## Relationship to the existing roadmap

This memo **absorbs** the "read-only judge container" increment
(agent-roles § Adoption order): the judge container *is* the orchestrator
container. Suggested build order:

1. Orchestrator container with the spine + PLAN/REVIEW moved in (worktrees
   :ro, broker socket moved here) — worker container keeps only
   IMPLEMENT/FIX + tests.
2. Orchestrator LLM session + typed-action loop + dialogue surface.
3. Broker-side reviewer.
4. Then Phase 4 egress hardening as planned.

## Open questions

- Transport between orchestrator and worker containers: reuse the
  broker-socket pattern (typed request/response over a named-volume unix
  socket) vs a handoff-file protocol like the macOS path. Leaning socket for
  commands + files for bulky artifacts.
- Worker session lifetime: one SDK session per instruction vs a resident
  worker process. Per-instruction is simpler and matches today's harness.
- How much of today's `runOrchestrator` survives as spine code (most of
  `gates.ts` / `publish.ts` should carry over unchanged).
- Reviewer independence config: `settingSources: []` and a distinct model
  alias are cheap; decide whether the broker-side reviewer should also see
  the coder's test output (leaning no — ground truth only).

## Resolution of the open questions

All four questions above were settled during the M1–M3 build; this section
records what was actually decided and built, cross-referenced to
[devcontainer-status.md](devcontainer-status.md) items 5–7.

- **Transport.** Settled on the socket side of the "leaning" call: each
  orchestrator↔worker edge is a **typed newline-JSON unix socket**
  (`harness/src/workerd/protocol.ts` — one newline-terminated JSON request per
  connection, one newline-terminated JSON response, exactly one dispatch per
  connection), a direct clone of the broker-socket pattern from Phase 2. No
  handoff-file protocol was built for this edge; the broker-side reviewer's
  large-diff channel (open question 4, below) is the one place a file *is*
  used, per the extension agreed in "Broker-side reviewer" above.
- **Worker session lifetime.** Settled on "one SDK session per instruction":
  the worker daemon (`harness/src/workerd/handlers.ts`) runs a fresh SDK
  session per `run_implement`/`run_fix` RPC, matching Phase-1 behavior. There
  is no resident, multi-instruction worker process.
- **How much of `runOrchestrator` survives.** Most of it, as predicted —
  `gates.ts` (the test gate + `humanApproval`) and `publish.ts` (the broker
  client) carried over **completely unchanged**, byte-for-byte the same code
  the M2 spine (`spine/executor.ts`) calls. `steps.ts` split along a seam the
  memo didn't spell out: `runPlan`/`runReview` stayed whole functions (reused
  directly by the spine), while the implement/fix steps split into
  **prompt-builders** (`buildImplementPrompt`/`buildFixPrompt`) and a shared
  **option-builder** (`editSessionOptions`) so the daemon and the
  single-container fallback build byte-identical sessions from one source of
  truth. `orchestrator.ts`'s old `workingDiff()` (an `git add -A -N` + `git
  diff`, which needs a writable index) is gone; every diff — spine, classic
  pipeline, and multi-repo driver alike — is now `gitops.ts`'s
  `commitRangeDiff(repoDir, baseSha)`, a pure read of git objects that works
  on the orchestrator's `:ro` mount, made possible by the worker/fallback now
  committing **deterministically** after every implement/fix step (the
  "deterministic-commit contract").
- **Reviewer independence / input.** Settled on "ground truth only, no test
  output": `reviewer/src/handler.ts`'s prompt hands the reviewer the
  broker-rendered diff plus the coder's title/body (explicitly labeled
  UNTRUSTED) — never the coder's test output. `settingSources: []` and a
  read-only, tool-less SDK session (`reviewer/src/sdk.ts`) give the
  independence the memo asked for; the reviewer runs in its own image-baked
  container rather than merely a distinct model alias.
- **Single-container fallback.** Kept, and load-bearing rather than
  incidental: `harness/src/exec.ts`'s mode switch runs every effectful step
  (`setup_worktree`/`run_implement`/`run_fix`/`run_tests`) via RPC when
  `WORKERD_SOCKET` is set, or in-process otherwise, calling the *same*
  primitives either way — so the split topology and the single-container path
  share one diff/commit semantics rather than two.

Where reality deviated from the memo, stated plainly:

- **No separate fix tool at the spine action level.** The wire protocol
  (`workerd/protocol.ts`) still has distinct `run_implement`/`run_fix` ops
  (used by the classic `runOrchestrator` pipeline's bounded fix loop), but the
  M2 spine's action surface (`spine/actions.ts`) exposes only a single
  `run_worker` action, which always dispatches `execImplement`. There is no
  `run_fix` action the orchestrator LLM can call — to "fix" something, it
  just calls `run_worker` again with a new instruction. Re-instruction, not a
  distinct fix primitive, is how the orchestrator LLM iterates.
- **Plan/Review read the orchestrator's single `:ro` mount, not a per-repo
  mount.** The topology table above describes "worktrees :ro" as if scoped
  per repository; the actual `docker-compose.yml` mounts the **entire
  workspace** read-only at one point (`..:/workspaces/muti-repo-workspace:ro`)
  into the orchestrator container. PLAN/REVIEW sessions (and the spine itself)
  read worktrees through that single whole-workspace mount rather than a
  worktree-scoped one.
