/**
 * spine/executor.ts — the DISPOSE side of "propose → validate → execute": the
 * only place a `SpineAction` turns into a real effect. Everything here reuses
 * the SAME primitives the coded (non-LLM-orchestrated) pipeline uses —
 * exec.ts's mode switch, gitops.ts's read-only diff, steps.ts's plan/review,
 * publish.ts's broker intent — so an orchestrator LLM can never buy more
 * capability than the Phase-1 harness already had; it can only sequence and
 * narrate it differently (memo: "the LLM proposes, a small coded spine
 * disposes").
 *
 * Two invariants this file is the enforcement point for:
 *   - Invariant 5 ("the spine owns the terminal"): `askHuman`/`say` are
 *     INJECTED by the REPL (spine/repl.ts), never created here. This file
 *     must never open its own readline — a human question always resolves to
 *     what the human actually typed into the ONE terminal interface.
 *   - Serial execution: a second dispatch() while one is in flight is refused
 *     with `busy`, never queued silently — the ledger/terminal are not
 *     re-entrant.
 */
import { execImplement, execTests } from "../exec.js";
import { commitRangeDiff, revParseHead } from "../gitops.js";
import { diffTouchesTests, runPlan, runReview } from "../steps.js";
import { showForApproval } from "../orchestrator.js";
import { publish } from "../publish.js";
import type { Plan } from "../types.js";
import type { SpineLedger, RepoLedgerEntry } from "./ledger.js";
import type { ActionResult, SpineAction } from "./actions.js";

export interface EndedInfo {
  kind: "done" | "abort";
  message: string;
}

export interface ExecutorDeps {
  ledger: SpineLedger;
  /**
   * The ticket-level instruction (spine/index.ts's initial CLI instruction, or
   * a placeholder when none was given). `plan_repo` and `review_diff`'s
   * fallback plan both need SOME instruction text to hand the read-only
   * steps.ts sessions — but the action surface's `plan_repo{repo}` and
   * `review_diff{repo}` deliberately carry no instruction field of their own
   * (per the M2 action list; only run_worker does, since that is the step
   * whose wording the orchestrator LLM is meant to compose turn by turn).
   * DESIGN DECISION (flag for verifier): this ticket-level instruction is a
   * fixed string threaded through for the life of the session; it is NOT
   * re-derived from the chat so far. If a ticket's scope changes entirely
   * mid-conversation, the human/orchestrator must express that through
   * run_worker's per-call instruction — plan_repo/review_diff will keep
   * judging against the original framing.
   */
  instruction: string;
  /** Owned by the REPL (spine/repl.ts) — this file must never create its own. */
  askHuman: (question: string) => Promise<string>;
  say: (line: string) => void;
}

export interface Executor {
  dispatch(action: SpineAction): Promise<ActionResult>;
  isEnded(): boolean;
  endedInfo(): EndedInfo | null;
}

// A minimal, always-valid Plan used only when review_diff runs before any
// plan_repo call for that repo (steps.ts's ReviewSchema/PlanSchema require a
// non-empty `steps` array). The reviewer still judges the ACTUAL diff against
// the ticket instruction; this just avoids a spurious step_failed for a
// legitimate "review without a prior plan" flow.
function minimalPlan(repo: string): Plan {
  return {
    summary: `(no plan recorded for '${repo}' — reviewing directly against the ticket instruction.)`,
    steps: ["(no explicit plan on record)"],
    risks: [],
    ready_to_implement: true,
  };
}

/** The exact WORKER prompt template: embeds the ledger's recorded plan (if
 *  any) plus the model-supplied instruction. Deliberately generic — per the
 *  M2 plan's SIMPLIFY note, the spine does not distinguish an "implement" run
 *  from a "fix" run; sequencing that judgment is exactly what the orchestrator
 *  LLM is for. The tool posture (what the worker step can actually DO) is
 *  still pinned entirely by exec.ts → steps.ts's editSessionOptions(), never
 *  by this prompt text. */
function buildWorkerPrompt(plan: Plan | null, instruction: string): string {
  const planBlock = plan
    ? `PLAN on record for this repo (from an earlier plan_repo call):\n${JSON.stringify(plan, null, 2)}`
    : "PLAN: (none recorded for this repo yet — use the instruction below as the sole scope.)";
  return (
    "You are the WORKER step, dispatched by an orchestrator LLM operating under a coded spine. " +
    "Apply the instruction below by editing the repository. Make the minimal change that satisfies " +
    "it. Do NOT run git push or publish anything — publishing is a separate, human-gated step you " +
    "have no access to.\n\n" +
    `${planBlock}\n\nINSTRUCTION:\n${instruction}`
  );
}

function isYes(answer: string): boolean {
  return /^y(es)?$/i.test(answer.trim());
}

export function createExecutor(deps: ExecutorDeps): Executor {
  const { ledger, instruction: ticketInstruction, askHuman, say } = deps;

  let busy = false;
  let ended: EndedInfo | null = null;
  // Per-repo worker-run sequence numbers, purely for the commit message label
  // (`mrw: WORKER <repo> run <n>`) — NOT the same counter as the ledger's
  // workerRunsUsed budget (that one is global across all repos).
  const workerRunSeq = new Map<string, number>();

  function nextWorkerRunSeq(repo: string): number {
    const n = (workerRunSeq.get(repo) ?? 0) + 1;
    workerRunSeq.set(repo, n);
    return n;
  }

  /** Resolve `name` to its ledger entry or a typed repo_unknown failure —
   *  every action carrying a repo field starts with this. */
  function requireRepo(name: string): { entry: RepoLedgerEntry } | { failure: ActionResult } {
    const entry = ledger.getRepo(name);
    if (!entry) {
      return {
        failure: {
          ok: false,
          code: "repo_unknown",
          error: `unknown repo '${name}' — this ticket's repos: ${ledger.repoNames().join(", ") || "(none)"}`,
        },
      };
    }
    return { entry };
  }

  async function runAction(action: SpineAction): Promise<ActionResult> {
    // Every action consumes the total-action budget FIRST, before any
    // validation of ITS OWN payload — an injected orchestrator burning
    // actions on garbage still burns budget (memo invariant 3: bounded,
    // fail-closed exhaustion, no "one more try").
    const budget = ledger.consumeAction();
    if (!budget.ok) {
      return { ok: false, code: "budget_exhausted", error: budget.reason };
    }

    switch (action.action) {
      case "run_worker": {
        const r = requireRepo(action.repo);
        if ("failure" in r) return r.failure;
        const workerBudget = ledger.consumeWorkerRun();
        if (!workerBudget.ok) {
          return { ok: false, code: "budget_exhausted", error: workerBudget.reason };
        }
        const seq = nextWorkerRunSeq(action.repo);
        const prompt = buildWorkerPrompt(r.entry.plan, action.instruction);
        try {
          const outcome = await execImplement({
            repoDir: r.entry.repoDir,
            prompt,
            commitMessage: `mrw: WORKER ${action.repo} run ${seq}`,
          });
          ledger.recordWorkerRun(action.repo, outcome);
          return { ok: true, committed: outcome.committed, headSha: outcome.headSha };
        } catch (e) {
          return { ok: false, code: "step_failed", error: (e as Error).message };
        }
      }

      case "run_tests": {
        const r = requireRepo(action.repo);
        if ("failure" in r) return r.failure;
        try {
          const result = await execTests(r.entry.repoDir);
          const atSha = revParseHead(r.entry.repoDir);
          ledger.recordTests(action.repo, result.pass, atSha);
          return { ok: true, pass: result.pass, status: result.status, output: result.output };
        } catch (e) {
          return { ok: false, code: "step_failed", error: (e as Error).message };
        }
      }

      case "review_diff": {
        const r = requireRepo(action.repo);
        if ("failure" in r) return r.failure;
        // READ-ONLY commit-range diff <baseSha>..HEAD (gitops.ts). An
        // INCOMPLETE diff is a hard, fail-closed stop — never let the
        // reviewer judge a blinded/truncated diff and record an approval
        // (same reviewer-blinding rule as orchestrator.ts's main loop).
        const wd = commitRangeDiff(r.entry.repoDir, r.entry.baseSha);
        if (!wd.complete) {
          return {
            ok: false,
            code: "step_failed",
            error: `commit-range diff could not be computed completely — fail-closed: ${wd.diff}`,
          };
        }
        const plan = r.entry.plan ?? minimalPlan(action.repo);
        try {
          const review = await runReview(ticketInstruction, plan, wd.diff, r.entry.repoDir);
          const atSha = revParseHead(r.entry.repoDir);
          ledger.recordReview(action.repo, review, atSha);
          return { ok: true, verdict: review.verdict, findings: review.findings, summary: review.summary };
        } catch (e) {
          return { ok: false, code: "step_failed", error: (e as Error).message };
        }
      }

      case "plan_repo": {
        const r = requireRepo(action.repo);
        if ("failure" in r) return r.failure;
        try {
          const plan = await runPlan(ticketInstruction, r.entry.repoDir);
          ledger.recordPlan(action.repo, plan);
          return { ok: true, plan };
        } catch (e) {
          return { ok: false, code: "step_failed", error: (e as Error).message };
        }
      }

      case "ask_human": {
        const answer = await askHuman(action.question);
        return { ok: true, answer };
      }

      case "show_human": {
        say(`[orchestrator] ${action.content}`);
        return { ok: true };
      }

      case "request_publish": {
        const r = requireRepo(action.repo);
        if ("failure" in r) return r.failure;
        // The invariant gate FIRST — the model sees exactly what is missing,
        // never a chance to bypass it via the human-approval step below
        // (memo invariant 2).
        const gate = ledger.canPublish(action.repo);
        if (!gate.ok) {
          return { ok: false, code: "invariants_not_met", error: gate.reason };
        }
        // Re-derive the diff read-only (cheap, and re-proves completeness
        // right before showing it — canPublish already guarantees it matches
        // what review_diff judged, since reviewApproved.sha === headSha).
        const wd = commitRangeDiff(r.entry.repoDir, r.entry.baseSha);
        if (!wd.complete) {
          return {
            ok: false,
            code: "step_failed",
            error: `commit-range diff became incomplete before publish — fail-closed: ${wd.diff}`,
          };
        }

        // Human approval — reuses orchestrator.ts's showForApproval (diff
        // view) + steps.ts's diffTouchesTests (test-independence caveat), but
        // asks via the injected askHuman so the SPINE's single terminal
        // interface remains the only place a human answer can come from
        // (invariant 5).
        showForApproval(r.entry.plan?.summary ?? "(no plan recorded)", r.entry.reviewApproved?.review ?? null, wd.diff);

        if (diffTouchesTests(wd.diff)) {
          const ack = await askHuman(
            "[warn] this change touches test files or the test command, so the green test gate " +
              "may not be independent of the worker's edits. Acknowledge and continue? [y/N]",
          );
          if (!isYes(ack)) {
            return { ok: false, code: "publish_declined", error: "declined at the test-independence caveat" };
          }
        }

        const finalAnswer = await askHuman("Tests green and review approved. Publish? [y/N]");
        if (!isYes(finalAnswer)) {
          return { ok: false, code: "publish_declined", error: "human declined publish" };
        }

        try {
          const res = await publish(
            { plan: r.entry.plan!, review: r.entry.reviewApproved!.review, diff: wd.diff },
            r.entry.repoDir,
          );
          if (res.published) {
            ledger.recordPublished(action.repo, res.sha, res.prUrl);
            return { ok: true, published: true, sha: res.sha, prUrl: res.prUrl };
          }
          return { ok: true, published: false, note: "stub (BROKER_SOCKET unset) — nothing pushed" };
        } catch (e) {
          return { ok: false, code: "publish_failed", error: (e as Error).message };
        }
      }

      case "done": {
        ended = { kind: "done", message: action.summary };
        return { ok: true };
      }

      case "abort": {
        ended = { kind: "abort", message: action.reason };
        return { ok: true };
      }

      default: {
        // Exhaustiveness check: a new SpineAction variant that forgets a case
        // here is a compile error, not a silent no-op.
        const _exhaustive: never = action;
        void _exhaustive;
        return { ok: false, code: "invalid_action", error: "unrecognized action" };
      }
    }
  }

  async function dispatch(action: SpineAction): Promise<ActionResult> {
    if (busy) {
      return { ok: false, code: "busy", error: "the spine is already executing an action — wait for it to finish" };
    }
    busy = true;
    try {
      return await runAction(action);
    } finally {
      busy = false;
      // Persist after EVERY dispatch (success or failure) so a crash mid-session
      // never loses more than the in-flight action's own state.
      ledger.persist();
    }
  }

  return {
    dispatch,
    isEnded: () => ended !== null,
    endedInfo: () => ended,
  };
}
