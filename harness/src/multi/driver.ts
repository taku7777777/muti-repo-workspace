/**
 * multi/driver.ts — the Phase 3 MULTI-REPO DRIVER (bespoke TypeScript, NO takt).
 *
 * ONE ticket spanning N repos: a per-repo coder pipeline (the Phase-1
 * runOrchestrator) with CROSS-REPO human gates. It runs INSIDE the caged coder
 * container; the per-repo checkouts are LOCAL clones (no network), and publishing
 * still goes ONLY through the human-gated Phase-2 broker. No new egress, no token.
 *
 * Flow:
 *   1. resolve repos (config/repos.json, --repos to subset) + load ticket state.
 *   2. SKIP repos already 'published' (resumability); set up an isolated worktree
 *      per remaining repo (clone --reference --dissociate; knowledge → sparse).
 *   3. COMBINED PLAN view: read-only plan every remaining repo, show them together,
 *      take ONE combined approve-plan gate.
 *   4. Run repos SEQUENTIALLY through runOrchestrator (each repo keeps ALL Phase-1
 *      gates: bounded fix loop, incomplete-diff hard stop, test-gate exit-code
 *      truth). Before each repo's publish gate the driver prints a COMBINED
 *      pre-publish summary, then defers to the built-in publish gate (diff view +
 *      test-independence caveat) and the broker's AUTHORITATIVE gate.
 *   5. Persist each repo's outcome as it happens. On a non-published outcome, STOP
 *      and report EXACTLY which repos were and were not published.
 *
 * HONESTY: true atomicity across N GitHub repos is IMPOSSIBLE. Publishing is
 * sequential and each push is independent; if a later repo fails, earlier pushes
 * are already public. The driver never claims otherwise and never reports silent
 * partial success — it stops and prints the full ledger.
 *
 * Run:  npm run drive -- --ticket ABC-1 --repos app,knowledge "the instruction"
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { runPlan } from "../steps.js";
import { humanApproval } from "../gates.js";
import {
  runOrchestrator,
  defaultApprovePublish,
  type OrchestratorResult,
  type PrePublishInfo,
} from "../orchestrator.js";
import { execSetupWorktree } from "../exec.js";
import type { Plan } from "../types.js";
import { loadRepos, loadWorkspace, resolveWorkspaceRoot, selectRepos } from "./config.js";
import { loadState, saveState, setRepoState, statePath } from "./state.js";
import type { DriverArgs, RepoConfig, TicketState } from "./types.js";

// A repo that still needs work this run, with its isolated worktree + pre-plan.
interface WorkItem {
  name: string;
  repoDir: string;
  plan: Plan;
  /** HEAD recorded at worktree setup — the base of the orchestrator's
   *  commit-range diff (gitops.ts's commitRangeDiff). */
  baseSha: string;
}

// ---------------------------------------------------------------------------
// arg parsing
// ---------------------------------------------------------------------------
export function parseArgs(argv: string[]): DriverArgs {
  let ticket = "";
  let purpose = "";
  let repos: string[] = [];
  const rest: string[] = [];

  const takeValue = (inline: string | undefined, i: number): [string, number] => {
    if (inline !== undefined) return [inline, i];
    const next = argv[i + 1];
    if (next === undefined) throw new Error("missing value for a flag");
    return [next, i + 1];
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    const eq = tok.indexOf("=");
    const flag = tok.startsWith("--") ? (eq >= 0 ? tok.slice(0, eq) : tok) : "";
    const inline = tok.startsWith("--") && eq >= 0 ? tok.slice(eq + 1) : undefined;
    if (flag === "--ticket") {
      [ticket, i] = takeValue(inline, i);
    } else if (flag === "--purpose") {
      [purpose, i] = takeValue(inline, i);
    } else if (flag === "--repos") {
      let csv: string;
      [csv, i] = takeValue(inline, i);
      repos = csv.split(",").map((s) => s.trim()).filter(Boolean);
    } else {
      rest.push(tok);
    }
  }

  return { ticket, purpose, repos, instruction: rest.join(" ").trim() };
}

// ---------------------------------------------------------------------------
// combined views
// ---------------------------------------------------------------------------
function renderCombinedPlan(ticket: string, items: WorkItem[]): void {
  console.log(`\n================ COMBINED PLAN (ticket ${ticket}) ================`);
  console.log(`This ticket spans ${items.length} repo(s). Review the whole scope before`);
  console.log(`approving. Each repo is then implemented and published INDEPENDENTLY.\n`);
  for (const it of items) {
    const p = it.plan;
    console.log(`── ${it.name} ${p.ready_to_implement ? "" : "  [NOT READY — will stop here]"}`);
    console.log(`   summary: ${p.summary}`);
    for (const s of p.steps) console.log(`     - ${s}`);
    if (p.risks.length) {
      console.log(`   risks:`);
      for (const r of p.risks) console.log(`     ! ${r}`);
    }
    console.log("");
  }
  console.log(`==================================================================\n`);
}

function renderPrePublishLedger(
  state: TicketState,
  order: string[],
  current: string,
): void {
  console.log(`\n========== COMBINED PRE-PUBLISH SUMMARY (ticket ${state.ticket}) ==========`);
  console.log(
    `Publishing is SEQUENTIAL and NOT atomic across GitHub repos. Each repo is\n` +
      `pushed through the broker on its own; if a later repo fails, the pushes\n` +
      `already made are PUBLIC and are not rolled back. Repo status so far:\n`,
  );
  for (const name of order) {
    const st = state.repos[name];
    let tag: string;
    if (name === current) tag = "now →  ";
    else if (st?.outcome === "published") tag = "done   ";
    else if (st && st.outcome !== "pending") tag = `${st.outcome}`;
    else tag = "pending";
    const extra = st?.sha ? `  sha=${st.sha}${st.prUrl ? ` pr=${st.prUrl}` : ""}` : "";
    console.log(`   [${tag}] ${name}${extra}`);
  }
  console.log(`\nThe diff + final confirm for '${current}' follow below.`);
  console.log(`=======================================================================`);
}

function renderFinalReport(
  root: string,
  state: TicketState,
  selected: RepoConfig[],
  skipped: string[],
): void {
  console.log(`\n================ TICKET REPORT: ${state.ticket} ================`);
  const published: string[] = [];
  const notPublished: string[] = [];
  const notAttempted: string[] = [];
  for (const repo of selected) {
    const st = state.repos[repo.name];
    if (!st || st.outcome === "pending") {
      notAttempted.push(repo.name);
    } else if (st.outcome === "published") {
      published.push(repo.name);
    } else {
      notPublished.push(repo.name);
    }
  }
  console.log(`PUBLISHED (${published.length}):`);
  for (const n of published) {
    const st = state.repos[n];
    const via = skipped.includes(n) ? " (already published on a prior run)" : "";
    console.log(`   ✓ ${n}${st?.sha ? `  sha=${st.sha}` : ""}${st?.prUrl ? ` pr=${st.prUrl}` : ""}${via}`);
  }
  if (notPublished.length) {
    console.log(`\nSTOPPED / NOT PUBLISHED (${notPublished.length}):`);
    for (const n of notPublished) {
      const st = state.repos[n];
      console.log(`   ✗ ${n}  outcome=${st?.outcome}${st?.reason ? `  (${st.reason})` : ""}`);
    }
  }
  if (notAttempted.length) {
    console.log(`\nNOT ATTEMPTED (sequence stopped before these) (${notAttempted.length}):`);
    for (const n of notAttempted) console.log(`   · ${n}`);
  }
  console.log(`\nState persisted at ${statePath(root, state.ticket)} — re-run to resume.`);
  console.log(`===============================================================\n`);
}

// ---------------------------------------------------------------------------
// driver
// ---------------------------------------------------------------------------
export async function runDriver(args: DriverArgs): Promise<number> {
  if (!args.ticket) {
    console.error('Missing --ticket. Usage: npm run drive -- --ticket ABC-1 [--repos a,b] [--purpose dev] "<instruction>"');
    return 2;
  }
  if (!args.instruction) {
    console.error('Missing instruction. Usage: npm run drive -- --ticket ABC-1 "<instruction>"');
    return 2;
  }

  const root = resolveWorkspaceRoot();
  const workspace = loadWorkspace(root);
  const allRepos = loadRepos(root);

  // Validate the ticket id against the workspace pattern (it becomes a branch
  // name and on-disk path segment).
  if (workspace.ticket_id_pattern) {
    const re = new RegExp(workspace.ticket_id_pattern);
    if (!re.test(args.ticket)) {
      console.error(`Ticket '${args.ticket}' does not match ticket_id_pattern ${workspace.ticket_id_pattern}.`);
      return 2;
    }
  }

  const purpose = args.purpose || workspace.default_purpose;
  const branch = `${workspace.branch_prefix}${args.ticket}`;
  const selected = selectRepos(allRepos, args.repos);

  // Load or initialize ticket state (resumability).
  let state = loadState(root, args.ticket);
  if (!state) {
    state = {
      ticket: args.ticket,
      instruction: args.instruction,
      branch,
      purpose,
      repos: {},
      updatedAt: new Date().toISOString(),
    };
    saveState(root, args.ticket, state);
  } else if (state.instruction !== args.instruction) {
    console.warn(
      `[driver] resuming ticket ${args.ticket}; the stored instruction differs from the one given.\n` +
        `         stored:  ${state.instruction}\n         given:   ${args.instruction}\n` +
        `         Keeping the stored instruction for consistency with already-published repos.`,
    );
  }
  const instruction = state.instruction;

  // Skip repos already published (resume); everything else is work.
  const skipped = selected.filter((r) => state!.repos[r.name]?.outcome === "published").map((r) => r.name);
  const todo = selected.filter((r) => state!.repos[r.name]?.outcome !== "published");

  console.log(`\n[driver] ticket=${args.ticket} branch=${branch} purpose=${purpose}`);
  console.log(`[driver] repos: ${selected.map((r) => r.name).join(", ")}`);
  if (skipped.length) console.log(`[driver] skipping already-published: ${skipped.join(", ")}`);

  if (todo.length === 0) {
    console.log(`[driver] nothing to do — all selected repos already published.`);
    renderFinalReport(root, state, selected, skipped);
    return 0;
  }

  // Set up isolated worktrees and run the read-only COMBINED PLAN pre-pass.
  const work: WorkItem[] = [];
  for (const repo of todo) {
    console.log(`\n[driver] preparing worktree for ${repo.name} …`);
    const setup = await execSetupWorktree({ root, repo, ticket: args.ticket, branch, purpose });
    const repoDir = setup.repoDir;
    setRepoState(root, args.ticket, state, repo.name, {
      outcome: "pending",
      branch,
      worktree: repoDir,
    });
    console.log(`[driver] planning ${repo.name} (read-only) …`);
    const plan = await runPlan(instruction, repoDir);
    work.push({ name: repo.name, repoDir, plan, baseSha: setup.baseSha });
  }

  // COMBINED plan view + ONE combined approve-plan gate (the cross-repo gate).
  renderCombinedPlan(args.ticket, work);
  if (!(await humanApproval(`Approve this plan across ${work.length} repo(s) and proceed to implement + (sequentially) publish?`))) {
    console.log(`[driver] combined plan declined by human. Nothing implemented.`);
    for (const it of work) {
      setRepoState(root, args.ticket, state, it.name, {
        outcome: "declined",
        reason: "combined plan declined",
        branch,
        worktree: it.repoDir,
      });
    }
    renderFinalReport(root, state, selected, skipped);
    return 0;
  }

  const order = work.map((w) => w.name);

  // SEQUENTIAL per-repo pipeline. Each repo keeps every Phase-1 gate; the
  // approve-plan gate is the combined one already taken (so we pass ()=>true and
  // the pre-computed plan), and the publish gate is the built-in one with a
  // combined summary prepended.
  for (let i = 0; i < work.length; i++) {
    const it = work[i];
    console.log(`\n########## REPO ${i + 1}/${work.length}: ${it.name} ##########`);

    const approvePublish = async (info: PrePublishInfo): Promise<boolean> => {
      renderPrePublishLedger(state!, order, it.name);
      return defaultApprovePublish(info);
    };

    let result: OrchestratorResult;
    try {
      result = await runOrchestrator({
        instruction,
        repoDir: it.repoDir,
        label: it.name,
        plan: it.plan,
        baseSha: it.baseSha,
        approvePlan: async () => true, // already approved at the combined gate
        approvePublish,
      });
    } catch (err) {
      result = { outcome: "failed", reason: `driver caught: ${(err as Error).message}` };
    }

    setRepoState(root, args.ticket, state, it.name, {
      outcome: result.outcome,
      sha: result.sha,
      prUrl: result.prUrl,
      reason: result.reason,
      branch,
      worktree: it.repoDir,
    });

    if (result.outcome !== "published") {
      console.error(
        `\n[driver] STOP: '${it.name}' outcome=${result.outcome}` +
          `${result.reason ? ` (${result.reason})` : ""}. ` +
          `NOT continuing to the remaining repo(s) — no silent partial success.`,
      );
      renderFinalReport(root, state, selected, skipped);
      // Human decline is a clean stop (0); anything else is fail-closed (1).
      return result.outcome === "declined" ? 0 : 1;
    }
  }

  console.log(`\n[driver] all ${work.length} repo(s) published for ticket ${args.ticket}.`);
  renderFinalReport(root, state, selected, skipped);
  return 0;
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------
export async function cli(): Promise<number> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    return 2;
  }
  const args = parseArgs(process.argv.slice(2));
  return runDriver(args);
}

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
