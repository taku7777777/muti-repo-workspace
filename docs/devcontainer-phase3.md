# Phase 3 — the multi-repo driver (one ticket, N repos, cross-repo gates)

Phase 0 caged the coder (network boundary, no push credential, no GitHub egress).
Phase 1 gave it a deterministic `plan→implement→review⇄fix→test→approve` pipeline
per repo. Phase 2 replaced the publish stub with an out-of-container, human-gated
broker. Phase 3 lets **one ticket span N repos**: a per-repo coder pipeline driven
sequentially, with **cross-repo human gates**, resumable progress, and an honest
partial-failure story.

It runs **inside the caged coder container**. The per-repo checkouts are **local
clones** (no network), and publishing still goes **only** through the Phase-2
broker. No new egress, no token, no weakening of Phase 0–2 containment.

## What changed

### 1. `runOrchestrator` — the Phase-1 state machine, now reusable

`harness/src/orchestrator.ts` no longer *is* a script; it **exports** the state
machine:

```ts
runOrchestrator(opts: {
  instruction: string;
  repoDir: string;            // the worktree this pipeline operates on
  label?: string;             // repo name in logs
  plan?: Plan;                // skip the internal PLAN step (driver pre-planned)
  approvePlan?: (plan, ctx) => Promise<boolean>;      // delegable gate
  approvePublish?: (info: PrePublishInfo) => Promise<boolean>; // delegable gate
}): Promise<OrchestratorResult>
```

```ts
type OrchestratorResult = {
  outcome: "published" | "declined" | "not_ready" | "failed";
  sha?: string; prUrl?: string | null; reason?: string;
};
```

It **never calls `process.exit`** and returns a typed result. **Every Phase-1
gate and fail-closed behavior is preserved verbatim:**

- approve-plan (human) — now *delegable* so the driver can batch it into one
  combined gate; omitted ⇒ the identical interactive `y/N` prompt.
- IMPLEMENT → REVIEW (read-only) + TEST-GATE with a **bounded** fix loop
  (`MAX_FIX_ATTEMPTS`, fail-closed once exhausted).
- **incomplete-diff hard stop** — a diff that couldn't be computed completely is
  never reviewed/approved; it returns `failed`.
- **test-gate exit-code truth** — `testGate(repoDir)` branches on `status === 0`
  only; the model never self-reports pass/fail.
- approve-publish (human) — shows the harness-computed diff and, if the change
  touched tests/the test command, demands a separate **test-independence** ack,
  then the final `Publish?`. This gate is *delegable*; the driver **wraps** it
  (prepends a combined summary) and then **defers to the same built-in gate**, so
  the diff view and the caveat are never lost.
- PUBLISH via the Phase-2 broker — the broker's out-of-container human gate stays
  the **authoritative** one; a broker refusal throws → `failed`.

A **thin single-repo CLI** remains: `npm run orchestrate -- "<instruction>"`
calls `runOrchestrator` against `REPO_DIR` (or cwd) and maps the outcome to an
exit code (`failed`→1, otherwise 0). Importing the module (from the driver) does
**not** start the CLI — it runs only when it is the process entrypoint.

Because every step now takes an explicit `repoDir` (threaded through
`steps.ts`, `gates.ts`, `publish.ts` as the SDK `cwd` / `git -C` target), the
driver can run N repos in **one process** — the old module-level `CWD` would have
pinned every repo to the same directory.

### 2. `harness/src/multi/*` — the driver

| File | Role |
|---|---|
| `multi/driver.ts` | CLI + `runDriver`: resolve repos, set up worktrees, combined plan gate, sequential per-repo `runOrchestrator`, combined pre-publish summary, honest reporting, resumability. |
| `multi/worktree.ts` | `setupWorktree`: `git clone --reference <origin> --dissociate` (LOCAL, no network) into `tasks/<ticket>/repositories/<repo>` on branch `<branch_prefix><ticket>`; `type:'knowledge'` ⇒ `--no-checkout` + cone sparse-checkout from `sparse_paths[purpose]`; points `origin` at the real upstream url for the broker. All git via `spawnSync` argv arrays. |
| `multi/config.ts` | Resolve the workspace root; load + validate `config/repos.json` and `config/workspace.json`; `selectRepos` (subset via `--repos`, unknown names are a hard error). |
| `multi/state.ts` | Load/save the ticket state file atomically (temp + rename). |
| `multi/types.ts` | Zod contracts for the config files and the ticket state. |

## Cross-repo gates

Repos run **sequentially**. The driver surfaces two combined views:

- **Combined plan view.** Before any implementation, the driver runs the
  **read-only** PLAN step for every not-yet-published repo, prints them together,
  and takes **one** combined approve-plan gate. That single approval is the
  cross-repo plan gate; each repo's `runOrchestrator` then runs with the
  pre-computed plan and `approvePlan: () => true` (no double gate, no re-plan).
- **Combined pre-publish summary.** Immediately before each repo's publish gate,
  the driver prints the full ledger (which repos are already published — with
  shas — which is publishing now, which are pending), then defers to the built-in
  publish gate (diff + caveat + confirm) and the broker's authoritative gate.

## Atomicity — the honest part

**True atomicity across N GitHub repos is impossible.** Publishing is sequential
and each push is independent; once repo *k* is pushed it is **public** and is not
rolled back if repo *k+1* later fails. The driver never pretends otherwise:

- On any non-`published` outcome mid-sequence it **STOPS** and does **not** touch
  the remaining repos.
- It prints a report listing exactly which repos were **published** (with
  sha/PR), which **stopped/failed** (with the reason), and which were **not
  attempted**. No silent partial success.
- Exit code: all published ⇒ 0; a human decline ⇒ 0 (clean stop, partial report);
  any fail-closed / not-ready ⇒ 1.

## Resumability

Per-repo progress is persisted to `tasks/<ticket>/phase3-state.json` after every
repo (publishing is the checkpoint). A re-run:

- **skips** repos whose recorded outcome is `published`,
- re-plans + re-runs everything else,

so a mid-sequence failure can be fixed and the ticket re-driven — it resumes at
the first not-yet-published repo. Writes are atomic (temp file + `rename`); a
corrupt state file is ignored (never trusted) and the ticket simply re-plans.

> Note: in **stub mode** (`BROKER_SOCKET` unset) nothing is ever pushed but the
> flow completes as `published` (reason notes the stub). A re-run will then skip
> that repo. That is a dev-only convenience; with the broker wired, `published`
> means a real, human-approved, git-verified push.

## Running it

```bash
# Inside the caged coder container, from the harness dir.
# All selected repos from config/repos.json:
npm run drive -- --ticket ABC-1 "add a --version flag and document it"

# A subset, in this order, with an explicit sparse-checkout purpose:
npm run drive -- --ticket ABC-1 --repos example-app,example-knowledge --purpose task \
  "add a --version flag and document it in the knowledge base"
```

Flags: `--ticket <id>` (required; validated against `ticket_id_pattern`),
`--repos <csv>` (optional subset, order-preserving), `--purpose <name>`
(optional; defaults to `default_purpose`). Everything else is the instruction.

The branch is `<branch_prefix><ticket>` (e.g. `feat/ABC-1`) in every repo. The
worktrees land at `tasks/<ticket>/repositories/<repo>`. Publishing uses the
Phase-2 broker exactly as in Phase 2 — set `BROKER_SOCKET` in the coder and run
the broker (see `docs/devcontainer-phase2.md`); unset ⇒ stub (no push).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MRW_WORKSPACE_ROOT` | resolved from the module (`…/harness/src/multi` → up 3) | Workspace root containing `config/`, `repositories/`, `tasks/`. |
| `REPO_DIR` | cwd | Single-repo CLI target only (`npm run orchestrate`). The driver sets each repo's dir itself. |
| `BROKER_SOCKET` | *(unset ⇒ stub)* | Same as Phase 2 — the publish socket. |
| `TEST_COMMAND` | `npm test` | Operator-pinned test-gate command, run per repo worktree. |
| `MAX_FIX_ATTEMPTS` | `3` | Bound on each repo's fix loop. |
| `HARNESS_MODEL` | `sonnet` | Model alias for every step. |

The driver reads `branch_prefix`, `default_purpose`, `ticket_id_pattern` from
`config/workspace.json` and the repo list (`name`, `url`, `type`, `sparse_paths`)
from `config/repos.json`.

## What Phase 3 does and does NOT change

**Does:** one ticket across N repos with a per-repo coder and cross-repo human
gates; a combined plan gate and a combined pre-publish summary; sequential,
broker-gated publishing; resumable per-repo state; an explicit, honest
partial-failure report.

**Does NOT:** give the coder a token, push capability, or GitHub egress (clones
are local; publish still goes only through the Phase-2 broker); make publishing
atomic across repos (impossible — stated plainly and handled by stopping +
reporting); change any Phase-1 gate's decision logic or the broker's
authoritative gate.
