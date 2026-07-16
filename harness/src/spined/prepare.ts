/**
 * spined/prepare.ts — the "prepare" step (`npm run spine-prepare`).
 *
 * docs/mrw-chat.md "New pieces": "Prepare is the launcher's job, not the
 * daemon's" — `mrw chat` (C3) runs this ONCE, synchronously, BEFORE spawning
 * spined via `.mcp.json`. It performs exactly the preamble spine/index.ts's
 * `cli()` runs up front — fail-closed credential guard, ticket-pattern
 * check, `selectRepos`, a worktree per repo (`execSetupWorktree` — RPC'd to
 * the worker daemon in split-container mode) — then seeds a FRESH
 * `SpineLedger`, records the ticket-level instruction via
 * `ledger.setInstruction()` (Engine adaptation C: this is what
 * `SpineLedger.load()` later hands back to spined's `createExecutor()`), and
 * persists. It never opens a session or a daemon, so spined itself only ever
 * has to LOAD an already-seeded ledger and can start fast (stdio MCP servers
 * have a startup timeout — see spined/index.ts's header).
 *
 * Deliberately NOT shared code with spine/index.ts's `cli()`: that file is
 * out of this phase's file scope (docs/mrw-chat.md Phase C2 hard
 * constraints), and its own header already established the norm of
 * re-implementing a small preamble per entrypoint rather than coupling
 * entrypoints together (see spine/index.ts's parseChatArgs comment, mirrored
 * here by spined/args.ts's parseSpinedArgs).
 *
 * RESEED GUARD (independent review, SHOULD-FIX #2): re-running this CLI
 * against a ticket that already has a persisted ledger is a footgun —
 * `new SpineLedger(...)` seeds a FRESH ledger, silently RESETTING every
 * consumed budget and re-deriving each repo's `baseSha` from the worktree's
 * CURRENT HEAD, which is exactly what Engine adaptation C (ledger.ts's
 * `load()`) exists to prevent for a resumed spined session. So prepare.ts
 * itself now refuses to reseed:
 *   (a) when `<ledgerDir>/spine-ledger.json` already exists, UNLESS `--force`
 *       is passed (an explicit, named admission that budgets/baseSha are
 *       about to be wiped);
 *   (b) UNCONDITIONALLY (never bypassed by --force) when the ticket's
 *       `spined.lock` looks like it could be held by a LIVE daemon
 *       (`lock.ts`'s `isLockPotentiallyLive` — a read-only peek, never a
 *       lock acquisition/takeover) — reseeding under a running daemon would
 *       either be immediately overwritten by its next persist() or corrupt
 *       whatever it is mid-dispatching against; there is no safe "--force"
 *       for that case, only "stop the daemon first".
 * Both checks run BEFORE any config is loaded or any worktree touched, so a
 * refusal is instant and side-effect-free.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execSetupWorktree } from "../exec.js";
import { loadRepos, loadWorkspace, resolveWorkspaceRoot, selectRepos } from "../multi/config.js";
import { stateDir } from "../multi/state.js";
import type { RepoConfig } from "../multi/types.js";
import { SpineLedger } from "../spine/ledger.js";
import { parseSpinedArgs } from "./args.js";
import { isLockPotentiallyLive } from "./lock.js";

export async function prepare(argv: string[], opts?: { root?: string }): Promise<number> {
  // Same fail-closed credential guard as spine/index.ts's cli(): worktree
  // setup itself needs no credential, but a prepared-then-immediately-used
  // daemon would fail on its very first run_worker/plan_repo/review_diff
  // without one — refuse loudly up front instead.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    return 2;
  }

  let args;
  try {
    args = parseSpinedArgs(argv);
  } catch (e) {
    console.error((e as Error).message);
    return 2;
  }
  if (!args.ticket) {
    console.error('Usage: npm run spine-prepare -- --ticket T-1 [--repos a,b] [--purpose p] "<initial instruction>"');
    return 2;
  }

  const root = opts?.root ?? resolveWorkspaceRoot();
  // Same ledger home as spine/index.ts's cli() (multi/state.ts's stateDir) —
  // computed FIRST, before any config is read, so the reseed guards below
  // are instant and side-effect-free (see this file's header).
  const ledgerDir = stateDir(root, args.ticket);
  const ledgerFile = path.join(ledgerDir, "spine-ledger.json");

  // (b) UNCONDITIONAL — never bypassed by --force. A read-only peek
  // (isLockPotentiallyLive never acquires/mutates the lock itself).
  if (isLockPotentiallyLive(ledgerDir)) {
    console.error(
      `[spine-prepare] a spined daemon may already be running for ticket '${args.ticket}' ` +
        `(lock present at ${path.join(ledgerDir, "spined.lock")}) — refusing to reseed while it might be ` +
        "running. Stop the daemon first, then re-run spine-prepare.",
    );
    return 2;
  }

  // (a) bypassable with --force — an explicit, named admission that
  // budgets/baseSha are about to be reset for this ticket.
  if (fs.existsSync(ledgerFile) && !args.force) {
    console.error(
      `[spine-prepare] a ledger already exists at ${ledgerFile} — re-running spine-prepare would silently ` +
        "reset consumed action/worker-run budgets and re-derive each repo's baseSha from the CURRENT HEAD " +
        "(exactly what Engine adaptation C exists to prevent for a resumed spined session). Pass --force to " +
        "reseed anyway (this WIPES recorded plan/test/review/published state and budgets for this ticket).",
    );
    return 2;
  }

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

  console.log(`[spine-prepare] ticket=${args.ticket} branch=${branch} purpose=${purpose}`);
  console.log(`[spine-prepare] repos: ${selected.map((r) => r.name).join(", ")}`);

  // Set up (or reuse) each repo's worktree and seed the ledger with its
  // {repoDir, baseSha} — the SAME primitive spine/index.ts's cli() uses, so
  // split-container mode Just Works here too.
  const repoInit: Record<string, { repoDir: string; baseSha: string }> = {};
  for (const repo of selected) {
    console.log(`[spine-prepare] preparing worktree for ${repo.name} …`);
    const setup = await execSetupWorktree({ root, repo, ticket: args.ticket, branch, purpose });
    repoInit[repo.name] = setup;
  }

  // ledgerDir was already resolved above (before the reseed guards) — same
  // directory spined/index.ts's SpineLedger.load() resolves to.
  const ledger = new SpineLedger(args.ticket, repoInit, undefined, ledgerDir);

  const instruction =
    args.instruction || "(no initial instruction given — take the scope from the human's chat messages.)";
  // Engine adaptation C: persist the ticket-level instruction so spined's
  // SpineLedger.load() can hand it back to createExecutor() without
  // re-asking — see ledger.ts's setInstruction() header.
  ledger.setInstruction(instruction);
  ledger.persist();

  console.log(`[spine-prepare] ledger seeded at ${ledgerDir} — spined can now be started for this ticket.`);
  return 0;
}

// Run the CLI only when this module is the process entrypoint (same pattern
// as spine/index.ts/spined/index.ts) — importing prepare.ts must never run
// the prepare step or exit the process.
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
  prepare(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
