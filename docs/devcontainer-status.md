# Dev Container orchestrator — build status & roadmap

Companion to the design in [../devcontainer-orchestrator-architecture.md](../../devcontainer-orchestrator-architecture.md).
This tracks what is **built + statically validated** vs what remains.
**Live-boot status (2026-07-15): ALL phases (0–3) have now run live.** The
stack boots, the egress self-check passes all 6 assertions from inside the
coder, the Phase 1 pipeline completed a full cycle on a demo repo (subscription
OAuth token injected from the macOS Keychain), the Phase 2 broker performed a
real publish (typed intent → ground-truth render → sha typed at the broker →
push of exactly the approved sha → `gh pr create`, taku7777777/phase2-demo#1),
and the Phase 3 driver drove a 2-repo ticket (DEMO-1) end-to-end: local
`--reference` worktrees, one combined plan gate, sequential per-repo pipelines,
two broker-gated publishes landing exactly the approved shas
(phase2-demo#2, phase3-docs#1), honest ledger + resumable state throughout.
The egress self-check still passes after every publish.

## Built & validated (Phase 0–3)

| Phase | What | Validation |
|---|---|---|
| **0** | Caged coder container (`cap_drop: ALL`, no NET_ADMIN, internal-only network) + Squid egress-allowlist sidecar (Approach A) + egress self-check | compose/JSON/shell syntax; self-check asserts blocked-vs-allowed + no docker.sock + no push credential |
| **1** | Bespoke SDK harness (`harness/`, NO takt): plan→[approve-plan]→implement→review⇄fix(bounded)→test-gate→[approve-publish]. Read-only plan/review via `tools`+`disallowedTools`; test-gate branches on exit code only; incomplete-diff = fail-closed | `tsc` green vs `@anthropic-ai/claude-agent-sdk` 0.3.205; 3 blocking security fixes applied |
| **2** | Out-of-container publish broker (`broker/`) over a unix socket: renders ground truth from a freshly-fetched ref, human approves at the broker by typing the sha, pushes the approved sha to a broker-constructed allowlist-validated URL. Coder holds no token/egress | `tsc` green; trust-model redesign cleared 4 blocking security findings + 3 re-verify blockers |
| **3** | Multi-repo driver (`harness/src/multi/`): callable `runOrchestrator` per repo, `clone --reference --dissociate` isolated worktrees (cone sparse for knowledge repos), cross-repo combined gates, resumable ticket state; origins mounted read-only | `tsc` green; security lens "ship"; sparse empty-tree blocker fixed |

Key security properties (by construction, verified by design review; the
network-boundary and no-credential assertions are now also live-verified by the
Phase 0 self-check):
- The C-3 escape is gone: the boundary is the Linux network namespace, so an
  in-shell `$(...)` has nowhere to escape to.
- The coder never holds a push token or GitHub egress; publishing is a typed,
  human-gated, ground-truth-rendered operation on the trusted side.
- Read-only judge steps are genuinely read-only; the test gate's pass/fail is an
  observed exit code, never a model claim.

## Live-boot roadmap (required before Phase 4/5)

1. ~~Phase 0: boot the stack + egress self-check~~ **DONE 2026-07-14** —
   `scripts/devcontainer-up.sh` (Keychain-injected auth), self-check 6/6 PASS.
2. ~~Phase 1: run the harness on a single repo end-to-end~~ **DONE 2026-07-14** —
   full cycle on a demo repo; publish gate declined by design (no broker in the loop).
3. ~~Phase 2: drive one publish through the broker~~ **DONE 2026-07-15** —
   fine-grained PAT (single-repo, 7-day) in the broker only; policy baked with
   `allowed_push_orgs=[taku7777777]`; `BROKER_WORKTREES_DIR` pointed at
   `tasks/<T>/repositories` (worktrees under `repositories/` are `:ro` for the
   coder); the remote ref landed on exactly the approved sha.
4. ~~Phase 3: run one multi-repo ticket~~ **DONE 2026-07-15** — ticket DEMO-1
   across phase2-demo (code) + phase3-docs (docs): combined plan gate caught a
   first attempt whose per-repo plans cross-scoped into the sibling repo (human
   declined; see findings below), the re-scoped run published both repos through
   the broker, and the remote refs match the approved shas exactly.
5. ~~First role-split increment: the orchestrator/worker container split~~
   **BUILT + LIVE-VALIDATED 2026-07-15** (M1 of
   [agent-orchestration.md](agent-orchestration.md)). The coder cage is now two
   cells: a **worker** (tasks/ rw only; harness/repositories `:ro`; **no broker
   socket** — it cannot even request a publish) running a typed newline-JSON
   RPC daemon (`harness/src/workerd/`, cloned from the broker socket pattern)
   for setup/implement/fix/test steps, and an **orchestrator** (whole workspace
   `:ro` at the mount level; holds the only broker socket + the worker RPC
   socket; spine ledger on a private notes volume via `MRW_STATE_DIR`) running
   the coded spine + read-only PLAN/REVIEW sessions. The worker daemon commits
   deterministically after implement/fix (`mrw:`-prefixed messages), so the
   review/publish diff is the read-only commit range `baseSha..HEAD` — computed
   by the orchestrator, never claimed by the worker — and worktrees are always
   clean for the broker. Single-container fallback kept (`WORKERD_SOCKET`
   unset ⇒ in-process, same commit semantics). Live-validated: role self-checks
   pass in both cages; a full driver cycle ran with plan/review on the `:ro`
   mount, implement/tests over the RPC, and a stub publish recorded in the
   notes-volume ledger. Remaining M2/M3 (orchestrator LLM on rails, broker-side
   reviewer) per [agent-orchestration.md](agent-orchestration.md).

M1 first-boot friction found and fixed (all live, none static):
- A named volume layered over the `:ro` harness bind initializes from the
  HOST's `node_modules` (darwin binaries, host-uid ownership) → `npm ci`
  EACCES. Fix: both cages copy the harness to container-local disk and install
  there (`scripts/prepare-harness-run.sh`); `MRW_WORKSPACE_ROOT` pins the
  workspace root since the module path no longer lives in the tree.
- GNU tar on colima/virtiofs intermittently reports "file changed as we read
  it" (exit 1) for an unchanging tree — treat exit 1 as a warning, ≥2 as fatal.
- `PIPESTATUS` must be snapshotted in a single statement (any following
  command, even an assignment, clobbers it).
- `humanApproval` robustness (found when the smoke run died silently at the
  last gate): stdin EOF left readline's promise unsettled and node exited 0
  mid-await without recording an outcome. EOF now resolves as a fail-closed
  DECLINE.

Post-run hardening (found during a design walkthrough after the live runs,
FIXED 2026-07-15): the broker's *source* was the one runtime input still read
from the coder-writable tree — deps and policy were baked into the image, but
`npm start` executed `/broker/src` bind-mounted (`:ro`) from `../broker/src`,
which on the host lives inside the workspace tree the coder mounts RW. A
prompt-injected coder could therefore tamper the broker's code and have it run
(with the token) at the next broker restart. Fix: bake `broker/src` +
`tsconfig.json` into the image (write-stripped) and drop the mount — everything
the broker executes is now fixed at build, a trusted human-initiated moment.

First-boot friction found and fixed (exactly the class of issue static checks
cannot surface):
- Bind-mounted `harness/node_modules` carried macOS (darwin-arm64) esbuild
  binaries into the Linux container — fixed by running `.devcontainer/postCreate.sh`
  (in-container `npm ci`) when attaching via `docker compose exec` instead of the
  VS Code devcontainer flow.
- Known cosmetic issue (open): the REVIEW step's structured summary occasionally
  carries trailing model-output tag fragments (`</summary>`, `</invoke>`), which
  flow verbatim into the broker-rendered PR body. Harmless but ugly — the harness
  should sanitize/strip the structured review text before it reaches publish.
- Phase 3 finding (open): per-repo plan scoping is **prompt-level only**. The
  driver hands every repo's planner the full ticket instruction; on the first
  DEMO-1 run one planner planned edits in the *sibling* repo (worktrees share
  `tasks/<T>/repositories/`, and cross-repo edits would not appear in that
  repo's own diff/review). The combined plan gate caught it, and an instruction
  that says "change ONLY the repo in your working directory" fixes it — but a
  structural fix (per-repo worktree isolation via mounts, or the read-only judge
  container) is the durable answer.
- Phase 3 finding (open): on resume, the driver keeps the **stored** instruction
  and ignores the newly-given one even when *nothing* has been published yet
  (the consistency guard is only needed once a repo has shipped). Workaround:
  delete `tasks/<ticket>/` to start fresh. Consider allowing an instruction
  update while `published` is empty.
- Zod v4's `z.toJSONSchema()` stamps the draft 2020-12 meta-schema ref, which the
  bundled Claude Code CLI's ajv (draft-07) cannot resolve — fixed with
  `target: "draft-7"` in `harness/src/sdk.ts`.

## Phase 4 — egress hardening (designed, NOT built)

The Phase 0 Squid allowlist resolves C-3's catastrophic legs but does not meet
"physically cannot exfiltrate": a plain domain allowlist has no TLS inspection, so
domain-fronting through an allowed host and DNS-tunneling remain, and the Anthropic
API token must live inside the boundary for the SDK to work. Phase 4 closes these:

- **TLS-terminating egress proxy** (mitmproxy / Squid SSL-bump / Envoy) with a
  container-trusted CA, so allowlisting is on the real host+path, not just the
  cleartext CONNECT/SNI.
- **Allowlist-only DNS resolver** in the egress sidecar (the coder gets no external
  resolver), closing DNS-tunnel exfil.
- **LLM egress proxy**: route Anthropic auth through a proxy (`ANTHROPIC_BASE_URL`)
  so no usable credential sits inside the coder boundary.
- **Read-only GitHub fetch proxy** for `git+https`/`go get`/submodule deps, kept
  separate from the (broker-only) push path.

Build after Phase 0–3 are proven live, because each of these is easiest to validate
against a working plain-allowlist baseline.

## Phase 5 — retire the macOS/cmux layer (DEFERRED until live validation)

**Do not execute until the container path is confirmed working on a real machine.**
Deleting the working macOS/seatbelt/cmux system before the replacement is proven
would remove the only currently-operational path. When ready, remove:
`scripts/lib/effects/cmux.sh`, the four cmux skill scripts, `.worker-target`
pinning, `~/.cmux-wait` screen-scraping, open-task Step 6.5 trust-setup, the
`TASK_DIR_H`/`to_home_path` byte-matching, the empty-`.git`-file trick, and the
`sandbox{}` blocks — and convert `update-task-sandbox.sh` from seatbelt-JSON edits
to console-side firewall/mount edits. Keep `pre-push` (moved into the broker) and
the append-only handoff protocol (as an audit trail).
