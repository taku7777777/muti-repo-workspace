/**
 * steps.ts — the LLM leaves of the pipeline, plus the shared prompt/option
 * builders those leaves are made of.
 *
 *   runPlan              — read-only; returns a typed Plan verdict.
 *   runReview            — READ-ONLY judge of a diff vs the plan; typed verdict.
 *   diffTouchesTests      — heuristic used by the publish gate.
 *   buildImplementPrompt /
 *   buildFixPrompt        — the exact prompt text for the edit steps.
 *   editSessionOptions    — the exact tool posture (cwd/systemPrompt/tools/
 *                           disallowedTools/maxTurns) for the edit steps.
 *
 * Plan and review are in-process, read-only leaves — they always run HERE
 * (the orchestrator container never needs a writable worktree to plan or
 * judge). Implement and fix are NOT run from this file: they edit the repo,
 * which the split topology's worker daemon (workerd/handlers.ts) — or, in the
 * single-container fallback, exec.ts — is the only place allowed to do. Both
 * consumers build the identical prompt/options from the functions below, so
 * there is exactly ONE source of truth for what "implement" and "fix" mean,
 * regardless of which side of the container boundary runs them.
 *
 * Each LLM step is a separate query() → fresh context. Only the typed
 * verdicts (Plan, Review) and the test gate's exit code ever steer the state
 * machine.
 *
 * Tool scoping is REAL: read-only steps set `tools: READ_ONLY_TOOLS` (base set)
 * AND `disallowedTools: DENY_MUTATION` — under bypassPermissions, allowedTools
 * alone would NOT remove Edit/Write/Bash (SDK #115). Read-only steps also drop
 * project settings (settingSources: []) so a malicious target-repo CLAUDE.md
 * cannot instruct the judge.
 */
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { PlanSchema, ReviewSchema } from "./types.js";
import type { Plan, Review } from "./types.js";
import {
  DENY_ALWAYS,
  DENY_MUTATION,
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  runStructuredQuery,
} from "./sdk.js";

/**
 * Heuristic: does the working diff touch test files or the test runner config?
 * If so, the green test gate may not be INDEPENDENT of the coder (it could have
 * edited/skipped tests or the `test` script). The orchestrator surfaces this and
 * requires an extra explicit human ack before publish.
 */
export function diffTouchesTests(diff: string): boolean {
  const headerPaths = diff
    .split("\n")
    .filter((l) => l.startsWith("diff --git "))
    .join("\n")
    .toLowerCase();
  const testPathRe =
    /(^|\/)__tests__\/|\.test\.|\.spec\.|_test\.|(^|\/)tests?\/|\.e2e\.|(^|\/)e2e\/|vitest\.config|jest\.config|\.mocharc|playwright\.config|conftest\.py/;
  if (testPathRe.test(headerPaths)) return true;
  // package.json whose "test" script line is added/removed in the diff.
  if (/package\.json/.test(headerPaths) && /^[+-].*"test"\s*:/m.test(diff)) return true;
  return false;
}

// --- PLAN --------------------------------------------------------------------
// `repoDir` is the worktree the step operates on (set as the SDK session `cwd`);
// the module-level CWD is only a default for the single-repo CLI, so every step
// takes it explicitly to support a multi-repo driver in one process.
export async function runPlan(instruction: string, repoDir: string): Promise<Plan> {
  return runStructuredQuery(
    PlanSchema,
    "You are the PLAN step of an automated pipeline. Read the repository and " +
      "produce a concise implementation plan for the instruction below. Do NOT " +
      "modify any files. Set ready_to_implement=false if the instruction is too " +
      "ambiguous or unsafe to implement. Return the required structured output.\n\n" +
      `INSTRUCTION:\n${instruction}`,
    {
      cwd: repoDir,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Plan only. Use read-only tools. Do not edit or run commands.",
      },
      // Genuinely read-only: restrict the base tool set AND deny mutation tools.
      tools: READ_ONLY_TOOLS,
      disallowedTools: DENY_MUTATION,
      // Judge independence: do NOT load the target repo's CLAUDE.md/.claude.
      settingSources: [],
      maxTurns: 40,
    },
  );
}

// --- IMPLEMENT ---------------------------------------------------------------
/** The exact IMPLEMENT prompt, shared by exec.ts (fallback) and
 *  workerd/handlers.ts (split mode, via the RPC request's `prompt` field). */
export function buildImplementPrompt(instruction: string, plan: Plan): string {
  return (
    "You are the IMPLEMENT step. Apply the plan below to the repository. Make " +
    "the minimal change. Do NOT run git push or publish anything.\n\n" +
    `INSTRUCTION:\n${instruction}\n\nPLAN:\n${JSON.stringify(plan, null, 2)}`
  );
}

// --- REVIEW ------------------------------------------------------------------
/**
 * READ-ONLY reviewer. Gets the harness-computed diff in-prompt and may open files
 * with Read/Grep/Glob for context, but has NO Edit/Write/Bash (enforced via
 * tools/disallowedTools, not just allowedTools). Returns a typed verdict.
 */
export async function runReview(
  instruction: string,
  plan: Plan,
  diff: string,
  repoDir: string,
): Promise<Review> {
  return runStructuredQuery(
    ReviewSchema,
    "You are the REVIEW step: a strict, read-only code reviewer. Judge whether " +
      "the WORKING DIFF below correctly and safely implements the PLAN for the " +
      "INSTRUCTION. You may read files for context but must not modify anything. " +
      "Return verdict='approve' only if the diff fully satisfies the plan with no " +
      "blocker/major issues; otherwise verdict='request_changes' with findings.\n\n" +
      `INSTRUCTION:\n${instruction}\n\n` +
      `PLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `WORKING DIFF:\n${diff}`,
    {
      cwd: repoDir,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Review only. Read-only tools. Never edit files or run commands.",
      },
      tools: READ_ONLY_TOOLS,
      disallowedTools: DENY_MUTATION,
      settingSources: [],
      maxTurns: 40,
    },
  );
}

// --- FIX ---------------------------------------------------------------------
/**
 * The exact FIX prompt, addressing review findings and/or test failures.
 * Consumed only inside the bounded fix loop; after it the orchestrator
 * re-runs the test gate (and review) — the model never declares itself fixed.
 * Shared by exec.ts (fallback) and workerd/handlers.ts (split mode).
 */
export function buildFixPrompt(
  instruction: string,
  plan: Plan,
  review: Review | null,
  testOutput: string | null,
): string {
  const findingsBlock = review
    ? `REVIEW FINDINGS:\n${JSON.stringify(review.findings, null, 2)}`
    : "REVIEW FINDINGS: (none — this pass is driven by test failures)";
  const testBlock = testOutput
    ? `FAILING TEST OUTPUT (tail):\n${testOutput}`
    : "FAILING TEST OUTPUT: (tests were not the trigger)";

  return (
    "You are the FIX step. Resolve the review findings and/or test failures " +
    "below by editing the repository. Make the minimal change; stay within the " +
    "plan's scope. Do NOT run git push or publish anything.\n\n" +
    `INSTRUCTION:\n${instruction}\n\nPLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
    `${findingsBlock}\n\n${testBlock}`
  );
}

// --- shared edit-session tool posture -----------------------------------------
/**
 * The exact Options for an implement/fix session (cwd, systemPrompt preset +
 * append, tools, disallowedTools, maxTurns) — everything EXCEPT the prompt
 * text. Both the daemon (workerd/handlers.ts) and the fallback (exec.ts) call
 * this so the TOOL POSTURE is pinned in exactly one place: an injected
 * orchestrator can vary the prompt but never the tool set (see protocol.ts's
 * header comment on this split).
 */
export function editSessionOptions(repoDir: string, kind: "implement" | "fix"): Partial<Options> {
  return {
    cwd: repoDir,
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append:
        kind === "implement"
          ? "Implement the plan by editing files. Do not push or publish."
          : "Fix the findings/tests by editing files. Do not push or publish.",
    },
    // Edit-capable, but no network tools. (WebFetch is dead anyway — no
    // egress; WebSearch runs server-side via the API, so this deny is the
    // actual control for it — see DENY_ALWAYS in sdk.ts.)
    tools: EDIT_TOOLS,
    disallowedTools: DENY_ALWAYS,
    maxTurns: 80,
  };
}
