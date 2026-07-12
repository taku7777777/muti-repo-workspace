/**
 * steps.ts — the four LLM leaves of the pipeline.
 *
 *   runPlan      — read-only; returns a typed Plan verdict.
 *   runImplement — edits the repo to apply the plan (fresh session).
 *   runReview    — READ-ONLY judge of the working diff vs the plan; typed verdict.
 *   runFix       — edits the repo to address review findings and/or test failures.
 *
 * Each is a separate query() → fresh context. Only the typed verdicts (Plan,
 * Review) and the test gate's exit code ever steer the state machine.
 *
 * Tool scoping is REAL: read-only steps set `tools: READ_ONLY_TOOLS` (base set)
 * AND `disallowedTools: DENY_MUTATION` — under bypassPermissions, allowedTools
 * alone would NOT remove Edit/Write/Bash (SDK #115). Read-only steps also drop
 * project settings (settingSources: []) so a malicious target-repo CLAUDE.md
 * cannot instruct the judge.
 */
import { spawnSync } from "node:child_process";
import { PlanSchema, ReviewSchema } from "./types.js";
import type { Plan, Review } from "./types.js";
import {
  DENY_ALWAYS,
  DENY_MUTATION,
  EDIT_TOOLS,
  READ_ONLY_TOOLS,
  runAgentQuery,
  runStructuredQuery,
} from "./sdk.js";

// --- diff capture ------------------------------------------------------------
export interface WorkingDiff {
  diff: string;
  /**
   * false when the diff could NOT be computed completely — git errored, or the
   * output exceeded the buffer (a reviewer-BLINDING vector: pad a file past the
   * limit so `git diff` truncates and the reviewer judges nothing). The
   * orchestrator treats an incomplete diff as fail-closed, never as "approve".
   */
  complete: boolean;
}

/**
 * Harness-computed working diff, injected into the review/fix prompts so REVIEW
 * can stay strictly read-only (no Bash/git). `add -A -N` (intent-to-add) makes
 * NEW files show up in `git diff` without staging their contents.
 *
 * `repoDir` is the worktree to diff. The orchestrator passes it explicitly so a
 * multi-repo driver can diff each per-repo worktree in one process.
 */
export function workingDiff(repoDir: string): WorkingDiff {
  spawnSync("git", ["-C", repoDir, "add", "-A", "-N"], { encoding: "utf8" });
  const r = spawnSync("git", ["-C", repoDir, "diff", "--no-color"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  // r.error is set on ENOBUFS (output too large) or spawn failure; status!==0 on
  // a git error. Either way the diff is not trustworthy → not complete.
  if (r.error || r.status !== 0) {
    return {
      diff:
        "(working diff could not be computed completely — git error or output " +
        "too large; possible reviewer-blinding)",
      complete: false,
    };
  }
  return { diff: r.stdout.trim() || "(no changes in working tree)", complete: true };
}

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
export async function runImplement(
  instruction: string,
  plan: Plan,
  repoDir: string,
): Promise<void> {
  await runAgentQuery(
    "You are the IMPLEMENT step. Apply the plan below to the repository. Make " +
      "the minimal change. Do NOT run git push or publish anything.\n\n" +
      `INSTRUCTION:\n${instruction}\n\nPLAN:\n${JSON.stringify(plan, null, 2)}`,
    {
      cwd: repoDir,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Implement the plan by editing files. Do not push or publish.",
      },
      // Edit-capable, but no network tools (there is no egress for them anyway).
      tools: EDIT_TOOLS,
      disallowedTools: DENY_ALWAYS,
      maxTurns: 80,
    },
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
 * Addresses review findings and/or test failures in a fresh session. Runs only
 * inside the bounded fix loop; after it the orchestrator re-runs the test gate
 * (and review) — the model never declares itself fixed.
 */
export async function runFix(
  instruction: string,
  plan: Plan,
  review: Review | null,
  testOutput: string | null,
  repoDir: string,
): Promise<void> {
  const findingsBlock = review
    ? `REVIEW FINDINGS:\n${JSON.stringify(review.findings, null, 2)}`
    : "REVIEW FINDINGS: (none — this pass is driven by test failures)";
  const testBlock = testOutput
    ? `FAILING TEST OUTPUT (tail):\n${testOutput}`
    : "FAILING TEST OUTPUT: (tests were not the trigger)";

  await runAgentQuery(
    "You are the FIX step. Resolve the review findings and/or test failures " +
      "below by editing the repository. Make the minimal change; stay within the " +
      "plan's scope. Do NOT run git push or publish anything.\n\n" +
      `INSTRUCTION:\n${instruction}\n\nPLAN:\n${JSON.stringify(plan, null, 2)}\n\n` +
      `${findingsBlock}\n\n${testBlock}`,
    {
      cwd: repoDir,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: "Fix the findings/tests by editing files. Do not push or publish.",
      },
      tools: EDIT_TOOLS,
      disallowedTools: DENY_ALWAYS,
      maxTurns: 80,
    },
  );
}
