# LLM orchestrator on rails (design memo)

**Status: DESIGN, agreed 2026-07-15 — not built.** Companion to
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
5. **Human interaction cannot be skipped or answered by the LLM.** The spine
   owns the terminal; `ask_human` returns what the human actually typed. The
   broker's sha-typed gate remains the authoritative publish approval.
6. **The transition rules themselves are not writable from any cage**
   (see topology — the spine runs where neither worker nor orchestrator
   sessions can write).

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
