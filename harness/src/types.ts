/**
 * types.ts — the machine-checkable contracts of the pipeline.
 *
 * These Zod schemas are the ONLY things the state machine trusts from a model:
 * a query() step returns structured output, we validate it here, and the parsed
 * value BRANCHES the coded control flow. The model's prose is never a decision.
 *
 * zod is v4 — schema-to-JSON-Schema goes through z.toJSONSchema(...) in sdk.ts.
 */
import { z } from "zod";

// --- PLAN --------------------------------------------------------------------
// The plan step reads the repo (read-only) and proposes an implementation.
// `ready_to_implement` lets the model fail-closed (e.g. instruction too vague);
// the state machine halts when it is false, BEFORE the human plan gate.
export const PlanSchema = z.object({
  summary: z.string(),
  steps: z.array(z.string()).min(1),
  risks: z.array(z.string()),
  ready_to_implement: z.boolean(),
});
export type Plan = z.infer<typeof PlanSchema>;

// --- REVIEW ------------------------------------------------------------------
// The review step is a READ-ONLY judge of the working diff against the plan.
// `verdict` branches the loop: 'approve' clears the review gate; 'request_changes'
// routes into a bounded fix loop. Findings are carried verbatim into the fix step.
export const ReviewFindingSchema = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  // Optional file hint; the fix step uses it to locate the change.
  file: z.string().optional(),
  detail: z.string(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

export const ReviewSchema = z.object({
  verdict: z.enum(["approve", "request_changes"]),
  findings: z.array(ReviewFindingSchema),
  summary: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

// --- TRIAGE ------------------------------------------------------------------
// The "task-up triage leaf" (see triage.ts): a bounded, read-only classifier
// run HOST-SIDE by `mrw task-up`, outside any cage, BEFORE a task workspace
// exists. It reads only the ticket text (no repo cwd) and pre-fills
// title/repos/work_type for create-workspace.sh. `repos` is typed as a plain
// string[] here — zod cannot express "subset of a runtime-supplied list" — so
// the subset constraint against the caller's availableRepos is enforced in
// code (triage.ts's filterToAvailableRepos), not by this schema.
export const WORK_TYPES = ["feature", "bugfix", "docs", "refactor", "chore", "test", "spike"] as const;
export const TriageSchema = z.object({
  work_type: z.enum(WORK_TYPES),
  title: z.string().min(1).max(120),
  repos: z.array(z.string()), // MUST be a subset of the available repo names passed in
  summary: z.string(),
});
export type Triage = z.infer<typeof TriageSchema>;
