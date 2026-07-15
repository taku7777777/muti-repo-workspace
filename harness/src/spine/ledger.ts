/**
 * spine/ledger.ts — the per-repo INVARIANT LEDGER (docs/agent-orchestration.md
 * invariant 2: "no publish intent without a green test gate AND an independent
 * review of the harness-computed diff, both recorded by the spine in this
 * run") plus the action/worker-run BUDGETS (invariant 3: "all loops are
 * bounded ... exhaustion is fail-closed").
 *
 * Every method here is a PURE function of the ledger's own state — no SDK
 * import, no I/O except `persist()` — so ledger.test.ts can exercise every
 * transition without a model or a filesystem mock. `executor.ts` is the only
 * caller; it is the one place that turns a harness step's outcome into a
 * ledger record.
 *
 * The load-bearing rule (memo invariant 2, spelled out per-repo): the moment a
 * worker run MOVES a repo's HEAD, any previously recorded test/review verdict
 * attests a sha that no longer exists at HEAD and is therefore INVALIDATED —
 * `recordWorkerRun` clears both. `canPublish` re-checks the sha match anyway
 * (defense in depth), but the invalidation is what makes a stale "tests were
 * green ten actions ago" verdict impossible to smuggle through.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { Plan, Review } from "../types.js";

// --- budgets (NaN-defensive, same pattern as sdk.ts's MAX_FIX_ATTEMPTS) ------
// A non-numeric/negative env value must not silently produce NaN or a
// negative bound — either would make `used >= max` never fire and the
// "bounded loop" invariant would silently stop being bounded.
function parseNonNegativeInt(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isInteger(n) && n >= 0 ? n : def;
}
export const MRW_SPINE_MAX_ACTIONS = parseNonNegativeInt(process.env.MRW_SPINE_MAX_ACTIONS, 100);
export const MRW_SPINE_MAX_WORKER_RUNS = parseNonNegativeInt(process.env.MRW_SPINE_MAX_WORKER_RUNS, 12);

export interface RepoLedgerEntry {
  repoDir: string;
  baseSha: string;
  headSha: string;
  plan: Plan | null;
  testGreen: { sha: string } | null;
  reviewApproved: { sha: string; review: Review } | null;
  published: { sha: string; prUrl: string | null } | null;
}

export interface LedgerRepoInit {
  repoDir: string;
  baseSha: string;
}

export interface LedgerBudgets {
  maxActions?: number;
  maxWorkerRuns?: number;
}

/** A cheap yes/no with a reason on refusal — used for both budget consumption
 *  and the publish gate so callers (executor.ts) branch on the same shape. */
export type LedgerCheck = { ok: true } | { ok: false; reason: string };

// Serializable snapshot — what persist()/snapshot() write. Kept separate from
// the live Map-backed class so JSON.stringify never has to know about Map.
export interface LedgerSnapshot {
  ticket: string;
  actionsUsed: number;
  maxActions: number;
  workerRunsUsed: number;
  maxWorkerRuns: number;
  repos: Record<string, RepoLedgerEntry>;
  updatedAt: string;
}

export class SpineLedger {
  readonly ticket: string;
  private readonly maxActions: number;
  private readonly maxWorkerRuns: number;
  /** Directory persist() writes to when called with no argument — resolved
   *  once by the caller (spine/index.ts, via multi/state.ts's stateDir) so
   *  every mid-session persist() after a dispatch (executor.ts) needs no args,
   *  while unit tests can still pass an explicit scratch dir. */
  private readonly defaultDir: string | null;
  private readonly repos: Map<string, RepoLedgerEntry>;
  private actionsUsed = 0;
  private workerRunsUsed = 0;

  constructor(
    ticket: string,
    repos: Record<string, LedgerRepoInit>,
    budgets?: LedgerBudgets,
    defaultDir?: string,
  ) {
    this.ticket = ticket;
    this.maxActions = budgets?.maxActions ?? MRW_SPINE_MAX_ACTIONS;
    this.maxWorkerRuns = budgets?.maxWorkerRuns ?? MRW_SPINE_MAX_WORKER_RUNS;
    this.defaultDir = defaultDir ?? null;
    this.repos = new Map(
      Object.entries(repos).map(([name, init]) => [
        name,
        {
          repoDir: init.repoDir,
          baseSha: init.baseSha,
          headSha: init.baseSha,
          plan: null,
          testGreen: null,
          reviewApproved: null,
          published: null,
        } satisfies RepoLedgerEntry,
      ]),
    );
  }

  // --- repo lookups -----------------------------------------------------------
  hasRepo(name: string): boolean {
    return this.repos.has(name);
  }

  repoNames(): string[] {
    return [...this.repos.keys()];
  }

  /** The live entry (mutated in place by the record* methods below) or
   *  undefined for an unknown repo — callers map that to ActionResult's
   *  `repo_unknown` code. */
  getRepo(name: string): RepoLedgerEntry | undefined {
    return this.repos.get(name);
  }

  // --- budgets ------------------------------------------------------------
  budgetsSnapshot(): { actionsUsed: number; maxActions: number; workerRunsUsed: number; maxWorkerRuns: number } {
    return {
      actionsUsed: this.actionsUsed,
      maxActions: this.maxActions,
      workerRunsUsed: this.workerRunsUsed,
      maxWorkerRuns: this.maxWorkerRuns,
    };
  }

  /** Consume one unit of the total-action budget. Called for EVERY dispatched
   *  action (executor.ts) before any work happens — so even a rejected/failed
   *  action still counts against the budget (an injected orchestrator cannot
   *  get free retries by spamming invalid actions). */
  consumeAction(): LedgerCheck {
    if (this.actionsUsed >= this.maxActions) {
      return { ok: false, reason: `MRW_SPINE_MAX_ACTIONS exhausted (${this.actionsUsed}/${this.maxActions})` };
    }
    this.actionsUsed++;
    return { ok: true };
  }

  /** Consume one unit of the worker-run budget, additionally to consumeAction
   *  (run_worker spends both budgets — it is both an action and a worker run). */
  consumeWorkerRun(): LedgerCheck {
    if (this.workerRunsUsed >= this.maxWorkerRuns) {
      return {
        ok: false,
        reason: `MRW_SPINE_MAX_WORKER_RUNS exhausted (${this.workerRunsUsed}/${this.maxWorkerRuns})`,
      };
    }
    this.workerRunsUsed++;
    return { ok: true };
  }

  // --- record* transitions -------------------------------------------------
  /** After a run_worker step: if HEAD moved, the previously recorded
   *  test/review verdicts attest a sha that no longer exists at HEAD —
   *  INVALIDATE both (memo invariant 2). A no-op step (committed:false, same
   *  headSha) leaves everything as-is. */
  recordWorkerRun(repo: string, outcome: { committed: boolean; headSha: string }): void {
    const entry = this.repos.get(repo);
    if (!entry) return; // unknown repo — callers must check hasRepo() first; silently ignored here (pure state, no throw)
    if (entry.headSha !== outcome.headSha) {
      entry.testGreen = null;
      entry.reviewApproved = null;
    }
    entry.headSha = outcome.headSha;
  }

  recordTests(repo: string, pass: boolean, atSha: string): void {
    const entry = this.repos.get(repo);
    if (!entry) return;
    entry.testGreen = pass ? { sha: atSha } : null;
  }

  recordReview(repo: string, review: Review, atSha: string): void {
    const entry = this.repos.get(repo);
    if (!entry) return;
    entry.reviewApproved = review.verdict === "approve" ? { sha: atSha, review } : null;
  }

  recordPlan(repo: string, plan: Plan): void {
    const entry = this.repos.get(repo);
    if (!entry) return;
    entry.plan = plan;
  }

  recordPublished(repo: string, sha: string, prUrl: string | null): void {
    const entry = this.repos.get(repo);
    if (!entry) return;
    entry.published = { sha, prUrl };
  }

  // --- the publish gate ------------------------------------------------------
  /** ok only if: a plan is recorded, tests are green AT the current HEAD, and
   *  an approving review is recorded of the current HEAD. Names exactly what
   *  is missing/stale so the model (and the human, via request_publish's
   *  typed error) sees a precise, actionable reason — never a bare refusal. */
  canPublish(repo: string): LedgerCheck {
    const entry = this.repos.get(repo);
    if (!entry) return { ok: false, reason: `unknown repo '${repo}'` };
    if (!entry.plan) {
      return { ok: false, reason: `no plan recorded for '${repo}' — call plan_repo first` };
    }
    if (!entry.testGreen) {
      return { ok: false, reason: `no green test run recorded for '${repo}' — call run_tests` };
    }
    if (entry.testGreen.sha !== entry.headSha) {
      return {
        ok: false,
        reason: `tests were green at ${entry.testGreen.sha} but HEAD has since moved to ${entry.headSha} — re-run run_tests`,
      };
    }
    if (!entry.reviewApproved) {
      return { ok: false, reason: `no approving review recorded for '${repo}' — call review_diff` };
    }
    if (entry.reviewApproved.sha !== entry.headSha) {
      return {
        ok: false,
        reason: `review approved ${entry.reviewApproved.sha} but HEAD has since moved to ${entry.headSha} — re-run review_diff`,
      };
    }
    return { ok: true };
  }

  // --- persistence -------------------------------------------------------
  snapshot(): LedgerSnapshot {
    return {
      ticket: this.ticket,
      actionsUsed: this.actionsUsed,
      maxActions: this.maxActions,
      workerRunsUsed: this.workerRunsUsed,
      maxWorkerRuns: this.maxWorkerRuns,
      repos: Object.fromEntries(this.repos.entries()),
      updatedAt: new Date().toISOString(),
    };
  }

  /** Atomic write (temp + rename — same pattern as multi/state.ts's
   *  saveState) to <dir>/spine-ledger.json. `dir` defaults to the directory
   *  resolved at construction time (spine/index.ts passes multi/state.ts's
   *  stateDir(root, ticket), which already implements the MRW_STATE_DIR
   *  override — see that file's header for why: the orchestrator container's
   *  workspace mount is `:ro` and tasks/ is worker-writable, so the ledger
   *  must NOT default to living there in split-container mode). Tests pass an
   *  explicit scratch dir instead of relying on the constructor default. */
  persist(dir?: string): void {
    const target = dir ?? this.defaultDir;
    if (!target) {
      throw new Error("SpineLedger.persist(): no directory given and none resolved at construction");
    }
    fs.mkdirSync(target, { recursive: true });
    const file = path.join(target, "spine-ledger.json");
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.snapshot(), null, 2) + "\n");
    fs.renameSync(tmp, file);
  }
}
