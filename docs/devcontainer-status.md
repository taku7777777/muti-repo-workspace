# Dev Container orchestrator — build status & roadmap

Companion to the design in [../devcontainer-orchestrator-architecture.md](../../devcontainer-orchestrator-architecture.md).
This tracks what is **built + statically validated** vs what remains, and the one
caveat that matters: **nothing here has been booted live yet** — it was authored
and adversarially reviewed on a host without the `docker compose` v2 plugin, so
every claim below is from `tsc`/syntax/adversarial-review, not a running system.

## Built & validated (Phase 0–3)

| Phase | What | Validation |
|---|---|---|
| **0** | Caged coder container (`cap_drop: ALL`, no NET_ADMIN, internal-only network) + Squid egress-allowlist sidecar (Approach A) + egress self-check | compose/JSON/shell syntax; self-check asserts blocked-vs-allowed + no docker.sock + no push credential |
| **1** | Bespoke SDK harness (`harness/`, NO takt): plan→[approve-plan]→implement→review⇄fix(bounded)→test-gate→[approve-publish]. Read-only plan/review via `tools`+`disallowedTools`; test-gate branches on exit code only; incomplete-diff = fail-closed | `tsc` green vs `@anthropic-ai/claude-agent-sdk` 0.3.205; 3 blocking security fixes applied |
| **2** | Out-of-container publish broker (`broker/`) over a unix socket: renders ground truth from a freshly-fetched ref, human approves at the broker by typing the sha, pushes the approved sha to a broker-constructed allowlist-validated URL. Coder holds no token/egress | `tsc` green; trust-model redesign cleared 4 blocking security findings + 3 re-verify blockers |
| **3** | Multi-repo driver (`harness/src/multi/`): callable `runOrchestrator` per repo, `clone --reference --dissociate` isolated worktrees (cone sparse for knowledge repos), cross-repo combined gates, resumable ticket state; origins mounted read-only | `tsc` green; security lens "ship"; sparse empty-tree blocker fixed |

Key security properties (by construction, verified by design review — not yet live):
- The C-3 escape is gone: the boundary is the Linux network namespace, so an
  in-shell `$(...)` has nowhere to escape to.
- The coder never holds a push token or GitHub egress; publishing is a typed,
  human-gated, ground-truth-rendered operation on the trusted side.
- Read-only judge steps are genuinely read-only; the test gate's pass/fail is an
  observed exit code, never a model claim.

## Next: boot it live (required before Phase 4/5)

On a host with Docker Desktop + the Compose v2 plugin:
1. Phase 0: `docker compose -f .devcontainer/docker-compose.yml up -d --build` then
   the egress self-check (see [devcontainer-phase0.md](devcontainer-phase0.md)).
2. Phase 1: run the harness on a single repo end-to-end.
3. Phase 2: `export BROKER_GITHUB_TOKEN=…`, edit `config/broker-policy.json`, and
   drive one publish through the broker (see [devcontainer-phase2.md](devcontainer-phase2.md)).
4. Phase 3: run one multi-repo ticket (see [devcontainer-phase3.md](devcontainer-phase3.md)).

Expect first-boot friction (image builds, `npm ci` re-installing Linux binaries,
socket volume perms, model-id/API specifics) — that is exactly what a live boot
surfaces and static checks cannot.

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
