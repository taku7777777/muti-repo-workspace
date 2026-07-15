/**
 * spine/index.ts — the M2 chat CLI:
 *   npm run chat -- --ticket T-1 [--repos a,b] [--purpose p] [initial instruction...]
 *
 * Wires the whole propose→validate→execute stack for one ticket: sets up a
 * worktree per selected repo (execSetupWorktree — same primitive the Phase-3
 * driver uses, RPC'd to the worker daemon in split-container mode), builds a
 * fresh SpineLedger seeded with each repo's {repoDir, baseSha}, builds the
 * executor and the orchestrator LLM session over it, and hands control to the
 * terminal REPL. No behavior is added here beyond wiring + the system-context
 * text — every actual decision still routes through spine/executor.ts.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSetupWorktree } from "../exec.js";
import { loadRepos, loadWorkspace, resolveWorkspaceRoot, selectRepos } from "../multi/config.js";
import { stateDir } from "../multi/state.js";
import type { RepoConfig } from "../multi/types.js";
import { createExecutor } from "./executor.js";
import { SpineLedger } from "./ledger.js";
import { createRepl } from "./repl.js";
import { createSpineSession } from "./session.js";

interface ChatCliArgs {
  ticket: string;
  purpose: string;
  repos: string[];
  /** Rest args joined — the initial human instruction, if given up front. */
  instruction: string;
}

// Mirrors multi/driver.ts's parseArgs (same flag shape: --ticket/--purpose/
// --repos, rest = free text) — re-implemented locally per the M2 plan's
// "factor or re-implement small" note rather than importing driver.ts's
// internals (that file's parseArgs is scoped to the drive CLI; duplicating
// ~20 lines of flag parsing here is cheaper than coupling the two entry
// points together).
export function parseChatArgs(argv: string[]): ChatCliArgs {
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

function buildSystemContext(info: {
  ticket: string;
  branch: string;
  purpose: string;
  repos: Array<{ name: string; repoDir: string }>;
  initialInstruction: string;
}): string {
  const repoLines = info.repos.map((r) => `  - ${r.name}  (worktree: ${r.repoDir})`).join("\n");
  return [
    `You are the ORCHESTRATOR for ticket ${info.ticket} (branch ${info.branch}, purpose ${info.purpose}).`,
    "",
    `Repos in scope for this ticket:\n${repoLines || "  (none selected)"}`,
    "",
    info.initialInstruction
      ? `Initial instruction from the human:\n${info.initialInstruction}`
      : "No initial instruction was given up front — take the scope entirely from the human's chat messages.",
    "",
    "You have NO direct tools to edit files, run shell commands, or push code. You act ONLY by calling",
    "the spine's typed tools; every result you get back from them is ground truth from the coded spine —",
    "never trust your own or a worker's claims about test/review status over what a tool call returned:",
    "  run_worker(repo, instruction)   — apply an instruction by editing+committing a repo. Also used",
    "                                     for follow-up fixes; there is no separate fix tool.",
    "  run_tests(repo)                 — the harness-run test gate; its exit code is the ONLY test truth.",
    "  plan_repo(repo)                 — a read-only implementation plan, used for review context and",
    "                                     the eventual publish body.",
    "  review_diff(repo)               — an independent, read-only review of the committed diff.",
    "  request_publish(repo)           — ask to publish. Requires a green run_tests AND an approving",
    "                                     review_diff, both of the CURRENT head, plus explicit human",
    "                                     approval you cannot see or answer yourself. A missing/stale",
    "                                     requirement comes back as a typed error naming exactly what to",
    "                                     do next — treat that as an instruction, not a dead end.",
    "  ask_human(question)             — ask the human something and wait for their typed answer.",
    "  show_human(content)             — show the human something; no reply is collected.",
    "  done(summary) / abort(reason)   — end this session, successfully or not.",
    "",
    "Call done() once every repo the human wants published is published (or explicitly left as-is by",
    "the human's own decision). Call abort() if you must give up — never just stop responding.",
  ].join("\n");
}

export async function cli(): Promise<number> {
  // Same fail-closed credential guard as orchestrator.ts/driver.ts/workerd's
  // cli()s: refuse before doing any worktree setup, not mid-session.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    return 2;
  }

  let args: ChatCliArgs;
  try {
    args = parseChatArgs(process.argv.slice(2));
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (!args.ticket) {
    console.error('Usage: npm run chat -- --ticket T-1 [--repos a,b] [--purpose p] "<initial instruction>"');
    return 2;
  }

  const root = resolveWorkspaceRoot();
  const workspace = loadWorkspace(root);
  const allRepos = loadRepos(root);

  if (workspace.ticket_id_pattern) {
    const re = new RegExp(workspace.ticket_id_pattern);
    if (!re.test(args.ticket)) {
      console.error(`Ticket '${args.ticket}' does not match ticket_id_pattern ${workspace.ticket_id_pattern}.`);
      return 2;
    }
  }

  const purpose = args.purpose || workspace.default_purpose;
  const branch = `${workspace.branch_prefix}${args.ticket}`;
  let selected: RepoConfig[];
  try {
    selected = selectRepos(allRepos, args.repos);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (selected.length === 0) {
    console.error("No repos selected — pass --repos or configure config/repos.json with at least one entry.");
    return 2;
  }

  console.log(`[chat] ticket=${args.ticket} branch=${branch} purpose=${purpose}`);
  console.log(`[chat] repos: ${selected.map((r) => r.name).join(", ")}`);

  // Set up (or reuse) each repo's worktree and seed the ledger with its
  // {repoDir, baseSha} — the SAME primitive the Phase-3 driver uses
  // (multi/driver.ts), so split-container mode Just Works here too.
  const repoInit: Record<string, { repoDir: string; baseSha: string }> = {};
  const repoList: Array<{ name: string; repoDir: string }> = [];
  for (const repo of selected) {
    console.log(`[chat] preparing worktree for ${repo.name} …`);
    const setup = await execSetupWorktree({ root, repo, ticket: args.ticket, branch, purpose });
    repoInit[repo.name] = setup;
    repoList.push({ name: repo.name, repoDir: setup.repoDir });
  }

  // The ledger's home is MRW_STATE_DIR/<ticket> when set, else
  // tasks/<ticket> — multi/state.ts's stateDir() already implements that
  // override (see its header for why the orchestrator container needs it:
  // its workspace mount is `:ro` and tasks/ is worker-writable).
  const ledgerDir = stateDir(root, args.ticket);
  const ledger = new SpineLedger(args.ticket, repoInit, undefined, ledgerDir);

  const instruction =
    args.instruction || "(no initial instruction given — take the scope from the human's chat messages.)";

  const repl = createRepl();
  const executor = createExecutor({ ledger, instruction, askHuman: repl.askHuman, say: repl.say });
  const systemContext = buildSystemContext({
    ticket: args.ticket,
    branch,
    purpose,
    repos: repoList,
    initialInstruction: args.instruction,
  });
  const session = createSpineSession({ systemContext, executor });

  await repl.run({
    session,
    executor,
    ledgerSummary: `[chat] ticket=${args.ticket} repos=${selected.map((r) => r.name).join(", ")} — ledger: ${ledgerDir}`,
  });

  const info = executor.endedInfo();
  return info?.kind === "abort" ? 1 : 0;
}

// Run the CLI only when this module is the process entrypoint (same pattern
// as orchestrator.ts/multi/driver.ts) — importing spine/index.ts must never
// start the CLI or exit the process.
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
