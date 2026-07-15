/**
 * orchestrator.ts — the coded control flow (the "state machine").
 *
 * User Decision: the control plane is a HAND-WRITTEN TypeScript pipeline over
 * @anthropic-ai/claude-agent-sdk `query()` — NO takt. Determinism comes from
 * this coded flow; LLMs are the leaves. The only deciders are (a) the typed
 * verdicts the model returns (Plan.ready_to_implement, Review.verdict) validated
 * in code, (b) the harness-run test gate's EXIT CODE, and (c) explicit human
 * readline gates. The model never self-reports pass/fail.
 *
 * Phase 1 loop (this file):
 *
 *   PLAN ──ready?──▶ [human approve-plan] ──▶ IMPLEMENT
 *                                                 │
 *                                                 ▼
 *              ┌─────────── REVIEW (read-only) + TEST-GATE ───────────┐
 *              │                                                       │
 *      approve & tests pass                              request_changes OR tests red
 *              │                                                       │
 *              ▼                                             attempts left? ──no──▶ FAIL-CLOSED
 *     [show diff + approve-publish]                                   │yes
 *              │                                                       ▼
 *              ▼                                                     FIX ──▶ (back to REVIEW+TEST)
 *      publish (Phase 2 broker)
 *
 * The fix ⇄ review/test loop is BOUNDED by MAX_FIX_ATTEMPTS (default 3) and stops
 * FAIL-CLOSED: no publish gate is even offered unless the tree is both approved
 * and green, AND the reviewed diff was computed completely (an incomplete diff —
 * a reviewer-blinding vector — is a hard stop, never an approve).
 *
 * Phase 3 refactor: the state machine is now an exported, RE-USABLE async
 * function `runOrchestrator({ instruction, repoDir })` that RETURNS a typed
 * OrchestratorResult and NEVER calls process.exit — so a multi-repo driver can
 * call it per repo in one process (see harness/src/multi/driver.ts). Every
 * Phase-1 gate and fail-closed behavior is preserved verbatim. The human gates
 * are DELEGABLE (approvePlan / approvePublish): omitted ⇒ the built-in
 * interactive readline gates run (the single-repo CLI is unchanged); supplied ⇒
 * the driver batches them into COMBINED cross-repo views. The gate LOGIC (what
 * must be true to pass) never changes; only WHERE the human is asked.
 *
 * M1 refactor: IMPLEMENT/FIX/the test gate no longer run directly in this
 * process — they go through exec.ts's mode switch, which either RPCs the
 * worker daemon (split-container topology) or runs in-process (fallback).
 * Either way the worker/fallback commits deterministically after
 * implement/fix, so the loop's diff is the READ-ONLY commit range
 * `baseSha..HEAD` (gitops.ts's commitRangeDiff) instead of a working-tree
 * diff — the thing that makes this file's own read-only `git diff` work even
 * when repoDir is mounted `:ro` (the orchestrator container).
 *
 * Run (single repo):  npm run orchestrate -- "add a --version flag to the CLI"
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CWD, MAX_FIX_ATTEMPTS } from "./sdk.js";
import { buildFixPrompt, buildImplementPrompt, diffTouchesTests, runPlan, runReview } from "./steps.js";
import { humanApproval } from "./gates.js";
import { publish } from "./publish.js";
import { commitRangeDiff, revParseHead } from "./gitops.js";
import { execFix, execImplement, execTests } from "./exec.js";
import type { Plan, Review } from "./types.js";

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/** Context handed to a delegated gate so it can label output per repo. */
export interface GateContext {
  repoDir: string;
  label: string;
}

/** Everything a publish gate needs to let a human decide, shown from ground the
 *  harness computed (diff) — never from a model claim. */
export interface PrePublishInfo {
  label: string;
  repoDir: string;
  planSummary: string;
  review: Review | null;
  /** Harness-computed working diff (complete — an incomplete diff never reaches here). */
  diff: string;
  /** The change touches test files / the test command → the green gate may not be
   *  independent of the coder; the publish gate demands an extra explicit ack. */
  touchesTests: boolean;
}

export interface OrchestratorOptions {
  instruction: string;
  /** The worktree the whole pipeline operates on (SDK cwd + git -C target). */
  repoDir: string;
  /** Log label (repo name in multi-repo runs). Defaults to the repoDir basename. */
  label?: string;
  /**
   * Pre-computed plan. When provided the internal PLAN step is SKIPPED and this
   * plan drives IMPLEMENT — used by the multi-repo driver, which plans every repo
   * up front to build a COMBINED plan view. When omitted, runOrchestrator plans
   * internally (single-repo CLI behavior).
   */
  plan?: Plan;
  /**
   * approve-plan gate. Omitted ⇒ the interactive readline gate. The driver
   * injects the decision already taken at its COMBINED plan gate. The gate is
   * never removed — the human still approves; only WHERE is batched.
   */
  approvePlan?: (plan: Plan, ctx: GateContext) => Promise<boolean>;
  /**
   * approve-publish gate. Omitted ⇒ defaultApprovePublish (diff view +
   * test-independence caveat + final confirm). The driver WRAPS it to prepend a
   * COMBINED pre-publish summary, then defers to the default so the diff view and
   * caveat are never lost.
   */
  approvePublish?: (info: PrePublishInfo) => Promise<boolean>;
  /**
   * The repo's HEAD sha recorded at worktree setup, used as the base of the
   * commit-range diff (commitRangeDiff in gitops.ts). Recorded by the driver
   * at execSetupWorktree() time (see multi/driver.ts's WorkItem.baseSha); when
   * omitted, the single-repo CLI records HEAD itself right before IMPLEMENT.
   */
  baseSha?: string;
}

/**
 * The typed outcome of one repo's pipeline. `outcome` is the single field a
 * caller branches on; it maps 1:1 to a CLI exit code.
 *  - published: pushed via the broker (sha/prUrl set) OR completed in Phase-1
 *    stub mode (BROKER_SOCKET unset → nothing pushed; reason notes it, sha unset).
 *  - declined:  a human said no at a gate. Clean stop, no error.
 *  - not_ready: PLAN reported ready_to_implement=false. Clean stop.
 *  - failed:    a fail-closed stop (incomplete diff, fix budget exhausted, broker
 *               refusal / publish error). The caller must treat it as an error.
 */
export interface OrchestratorResult {
  outcome: "published" | "declined" | "not_ready" | "failed";
  sha?: string;
  prUrl?: string | null;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Default (single-repo, interactive) gates — the exact Phase-1 human prompts.
// Exported so the multi-repo driver can reuse the publish gate (diff view +
// test-independence caveat) after prepending its combined summary.
// ---------------------------------------------------------------------------

/** Print the plan/review summary and a bounded slice of the reviewed diff so the
 *  human approves what they can actually see (not just a machine claim). */
export function showForApproval(
  planSummary: string,
  review: Review | null,
  diff: string,
): void {
  console.log("\n----- change under review -----");
  console.log(`plan:   ${planSummary}`);
  if (review) console.log(`review: ${review.summary}`);
  const lines = diff.split("\n");
  const shown = lines.slice(0, 200).join("\n");
  console.log("\ndiff (first 200 lines; inspect the full diff with `git diff`):");
  console.log(shown);
  if (lines.length > 200) console.log(`… (${lines.length - 200} more diff lines)`);
  console.log("----- end -----\n");
}

/** The Phase-1 approve-plan gate: a single interactive y/N. */
export async function defaultApprovePlan(_plan: Plan, _ctx: GateContext): Promise<boolean> {
  return humanApproval("Approve this plan and proceed to implement?");
}

/**
 * The Phase-1 approve-publish gate, VERBATIM: show the diff, and if the change
 * touched tests/the test command, require a SEPARATE explicit ack that the green
 * gate may not be independent of the coder — then the final Publish? y/N.
 */
export async function defaultApprovePublish(info: PrePublishInfo): Promise<boolean> {
  showForApproval(info.planSummary, info.review, info.diff);

  if (info.touchesTests) {
    console.warn(
      "[warn] this change modifies test files or the test command, so the green " +
        "test gate may not be independent of the coder's edits.",
    );
    if (!(await humanApproval("Acknowledge the test-independence caveat and continue?"))) {
      console.log("Stopped at the test-independence caveat. Done.");
      return false;
    }
  }

  return humanApproval("Tests green and review approved. Publish?");
}

// Target-vs-harness separation: if the agent operates ON the harness repo itself
// (repoDir is at/above the harness), a Write-capable step could edit
// gates.ts/orchestrator.ts and neuter the gates. Warn loudly.
function warnIfTargetIsHarness(repoDir: string): void {
  const harnessDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = path.resolve(repoDir);
  if (target === harnessDir || harnessDir.startsWith(target + path.sep)) {
    console.warn(
      "\n[warn] the target repo (repoDir) contains this harness — a coder step " +
        "could edit the harness's own gates. Point repoDir at a separate " +
        "worktree for real work.\n",
    );
  }
}

// ---------------------------------------------------------------------------
// The state machine — reusable, returns a typed result, never exits the process.
// ---------------------------------------------------------------------------
export async function runOrchestrator(
  opts: OrchestratorOptions,
): Promise<OrchestratorResult> {
  const { instruction, repoDir } = opts;
  const label = opts.label ?? path.basename(path.resolve(repoDir));
  const approvePlan = opts.approvePlan ?? defaultApprovePlan;
  const approvePublish = opts.approvePublish ?? defaultApprovePublish;
  warnIfTargetIsHarness(repoDir);

  // STATE: PLAN --------------------------------------------------------------
  console.log(`\n=== PLAN (${label}) ===`);
  let plan: Plan;
  if (opts.plan) {
    plan = opts.plan;
    console.log("(using the pre-computed plan from the driver's combined plan view)");
  } else {
    plan = await runPlan(instruction, repoDir);
  }
  console.log(JSON.stringify(plan, null, 2));
  if (!plan.ready_to_implement) {
    console.log("\nPlan reports it is not ready to implement — stopping.");
    return { outcome: "not_ready", reason: "plan.ready_to_implement=false" };
  }

  // GATE: approve-plan (explicit human, possibly batched by the driver) -------
  console.log(`\n=== HUMAN GATE: approve plan (${label}) ===`);
  if (!(await approvePlan(plan, { repoDir, label }))) {
    console.log("Plan declined by human. Done.");
    return { outcome: "declined", reason: "plan declined" };
  }

  // The base of the commit-range diff (gitops.ts's commitRangeDiff). The
  // driver records this at execSetupWorktree() time; the single-repo CLI has
  // no such pre-pass, so it records HEAD itself, right before the worktree's
  // first commit gets made.
  const baseSha = opts.baseSha ?? revParseHead(repoDir);

  // STATE: IMPLEMENT ---------------------------------------------------------
  console.log(`\n=== IMPLEMENT (${label}) ===`);
  await execImplement({
    repoDir,
    prompt: buildImplementPrompt(instruction, plan),
    commitMessage: `mrw: IMPLEMENT ${label}`,
  });

  // STATE: REVIEW + TEST-GATE, with a BOUNDED fix loop -----------------------
  // Invariant to leave this block "clean": the diff was computed COMPLETELY,
  // review verdict === 'approve', AND the harness test gate exited 0.
  let attempt = 0;
  let lastReview: Review | null = null;
  let lastDiff = "";
  while (true) {
    console.log(
      `\n=== REVIEW + TEST-GATE (${label}) (fix attempts used: ${attempt}/${MAX_FIX_ATTEMPTS}) ===`,
    );

    // READ-ONLY commit-range diff <baseSha>..HEAD (gitops.ts). An INCOMPLETE
    // diff (git error / oversize) is a hard stop — never let the reviewer
    // judge a blinded/empty diff and approve.
    const wd = commitRangeDiff(repoDir, baseSha);
    if (!wd.complete) {
      console.error(`\n[diff] ${wd.diff}\nFAIL-CLOSED — cannot review an incomplete commit-range diff.`);
      return { outcome: "failed", reason: "incomplete commit-range diff (fail-closed)" };
    }
    lastDiff = wd.diff;

    const review = await runReview(instruction, plan, wd.diff, repoDir);
    lastReview = review;
    console.log(`[review] verdict=${review.verdict}, findings=${review.findings.length}`);
    if (review.findings.length) {
      console.log(JSON.stringify(review.findings, null, 2));
    }

    // TEST-GATE is the non-negotiable exit-code decider.
    const test = await execTests(repoDir);
    console.log(`[test-gate] ${test.pass ? "PASSED" : "FAILED"}`);

    if (review.verdict === "approve" && test.pass) break;

    if (attempt >= MAX_FIX_ATTEMPTS) {
      console.error(
        `\nStill not clean after ${MAX_FIX_ATTEMPTS} fix attempt(s) — ` +
          "FAIL-CLOSED. No publish gate offered.",
      );
      return {
        outcome: "failed",
        reason: `not clean after ${MAX_FIX_ATTEMPTS} fix attempt(s)`,
      };
    }

    // STATE: FIX (addresses findings and/or the failing test output) ---------
    attempt++;
    console.log(`\n=== FIX (attempt ${attempt}/${MAX_FIX_ATTEMPTS}) (${label}) ===`);
    await execFix({
      repoDir,
      prompt: buildFixPrompt(
        instruction,
        plan,
        review.verdict === "request_changes" ? review : null,
        test.pass ? null : test.output,
      ),
      commitMessage: `mrw: FIX ${label} attempt ${attempt}`,
    });
  }

  // GATE: approve-publish (explicit human, shown the actual change) -----------
  console.log(`\n=== HUMAN GATE: approve publish (${label}) ===`);
  const info: PrePublishInfo = {
    label,
    repoDir,
    planSummary: plan.summary,
    review: lastReview,
    diff: lastDiff,
    touchesTests: diffTouchesTests(lastDiff),
  };
  if (!(await approvePublish(info))) {
    console.log("Publish declined by human. Done.");
    return { outcome: "declined", reason: "publish declined" };
  }

  // STATE: PUBLISH -----------------------------------------------------------
  // Hands a typed intent to the out-of-container broker; the broker re-renders the
  // ground-truth diff and runs the AUTHORITATIVE human gate before any push. A
  // broker refusal throws → caught here → fail-closed 'failed'.
  try {
    const res = await publish({ plan, review: lastReview, diff: lastDiff }, repoDir);
    if (res.published) {
      return { outcome: "published", sha: res.sha, prUrl: res.prUrl };
    }
    // Phase-1 stub (BROKER_SOCKET unset): the flow completed but nothing pushed.
    return { outcome: "published", reason: "stub (BROKER_SOCKET unset) — nothing pushed" };
  } catch (err) {
    console.error(`[publish] ${(err as Error).message}`);
    return { outcome: "failed", reason: `publish failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Thin single-repo CLI: 'npm run orchestrate -- "<instruction>"'. Calls
// runOrchestrator against REPO_DIR (or cwd) and maps the result to an exit code.
// ---------------------------------------------------------------------------
export async function cli(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    return 2;
  }
  const instruction = process.argv.slice(2).join(" ").trim();
  if (!instruction) {
    console.error('Usage: npm run orchestrate -- "<human instruction>"');
    return 2;
  }

  const result = await runOrchestrator({ instruction, repoDir: CWD });
  console.log(
    `\n[orchestrator] outcome=${result.outcome}` +
      (result.reason ? ` (${result.reason})` : "") +
      (result.sha ? ` sha=${result.sha}` : "") +
      (result.prUrl ? ` pr=${result.prUrl}` : ""),
  );
  switch (result.outcome) {
    case "published":
    case "declined":
    case "not_ready":
      return 0; // clean stops (published / human-declined / not-ready) — exit 0
    case "failed":
      return 1; // fail-closed
  }
}

// Run the CLI only when this module is the process entrypoint — importing it
// (e.g. from the multi-repo driver) must NOT start the CLI or exit the process.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  cli()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
