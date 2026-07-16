/**
 * triage.ts — the "task-up triage leaf": a bounded, read-only, TYPED
 * classifier. Given a ticket's raw text and the workspace's available repo
 * names, it classifies the ticket into { work_type, title, repos, summary }
 * via a single read-only query() (runStructuredQuery, sdk.ts).
 *
 * Unlike runPlan/runReview (steps.ts), this leaf runs HOST-SIDE, OUTSIDE any
 * cage — it is invoked by `mrw task-up` before a task workspace even exists,
 * from an operator's own machine (memo: "operator-run task-up, outside the
 * cage"). It classifies from the PROMPT TEXT ONLY: no `cwd` is set (do not
 * point it at a repo — there is no repo yet), and its tool posture mirrors
 * the read-only judge steps exactly: `tools: READ_ONLY_TOOLS` (base set) AND
 * `disallowedTools: DENY_MUTATION` (deny wins under bypassPermissions — see
 * sdk.ts's baseOptions header on why allowedTools alone is not enough), plus
 * `settingSources: []` so no project CLAUDE.md (there isn't one yet, but the
 * posture is pinned identically to the other read-only leaves regardless).
 * It never edits, never chooses what to publish, and never runs commands.
 *
 * `repos` is schema-typed as a plain string[] (see types.ts's TriageSchema
 * comment: zod cannot express "subset of a runtime list"), so the subset
 * constraint against the caller's availableRepos is enforced HERE, in code,
 * via filterToAvailableRepos() — factored out as a small pure helper so it
 * is unit-testable without a live API call (see test/triage.test.ts).
 */
import { DENY_MUTATION, READ_ONLY_TOOLS, runStructuredQuery } from "./sdk.js";
import { TriageSchema, WORK_TYPES } from "./types.js";
import type { Triage } from "./types.js";

/**
 * Intersect the model's claimed `repos` with the caller-supplied
 * `availableRepos`, preserving the model's ordering and dropping duplicates
 * and any hallucinated name not in `availableRepos`. Pure and side-effect
 * free — the DEFENSIVE filter step the schema itself cannot express.
 */
export function filterToAvailableRepos(repos: string[], availableRepos: string[]): string[] {
  const available = new Set(availableRepos);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of repos) {
    if (available.has(r) && !seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  return out;
}

export async function runTriage(ticketText: string, availableRepos: string[]): Promise<Triage> {
  const prompt =
    "You are the TRIAGE step of an automated pipeline. Read the TICKET below and " +
    "classify it. Choose work_type from the allowed set. Pick a concise title. " +
    "From AVAILABLE REPOS, list ONLY the repos this ticket likely touches (a " +
    "subset; empty if unclear). Give a one-paragraph summary. Do NOT modify " +
    "anything.\n\n" +
    `ALLOWED WORK TYPES: ${WORK_TYPES.join(", ")}\n\n` +
    `AVAILABLE REPOS:\n${availableRepos.join("\n")}\n\n` +
    `TICKET:\n${ticketText}`;

  const result = await runStructuredQuery(TriageSchema, prompt, {
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: "Classify only. Read-only. Never edit or run commands.",
    },
    // Genuinely read-only: restrict the base tool set AND deny mutation
    // tools (see sdk.ts's baseOptions header — allowedTools alone would not
    // remove Edit/Write/Bash under bypassPermissions).
    tools: READ_ONLY_TOOLS,
    disallowedTools: DENY_MUTATION,
    // No project to load settings from (and no repo cwd at all — this step
    // classifies from the prompt text only, never a target-repo CLAUDE.md).
    settingSources: [],
    maxTurns: 8,
  });

  // Enforce the subset constraint in code (the schema can't).
  return { ...result, repos: filterToAvailableRepos(result.repos, availableRepos) };
}
