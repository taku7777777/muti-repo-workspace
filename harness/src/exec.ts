/**
 * exec.ts — the mode switch between split-container RPC and in-process
 * fallback for the three effectful pipeline steps (setup/implement-fix/tests).
 *
 * WORKERD_SOCKET set   ⇒ RPC to the worker daemon (split topology): this
 *   process is the orchestrator container, whose workspace mount is `:ro`; the
 *   worker container owns the writable worktree and is the only place that
 *   runs the SDK session + the deterministic post-step commit.
 * WORKERD_SOCKET unset ⇒ in-process (host dev loop / single-container
 *   fallback). This path calls the SAME primitives the daemon calls
 *   (editSessionOptions()/runAgentQuery() from steps.ts/sdk.ts, commitAll()
 *   from gitops.ts) — including the deterministic commit — so there is ONE
 *   diff semantics (gitops.ts's commitRangeDiff) regardless of topology. See
 *   gitops.ts's header for why the old workingDiff() approach is gone.
 */
import * as path from "node:path";
import { resolveWorkspaceRoot } from "./multi/config.js";
import { setupWorktree } from "./multi/worktree.js";
import type { WorktreeSpec } from "./multi/worktree.js";
import { commitAll, revParseHead } from "./gitops.js";
import type { CommitResult } from "./gitops.js";
import { testGate } from "./gates.js";
import type { TestResult } from "./gates.js";
import { editSessionOptions } from "./steps.js";
import { runAgentQuery } from "./sdk.js";
import { rpcRunFix, rpcRunImplement, rpcRunTests, rpcSetupWorktree } from "./workerd/client.js";

export interface SetupOutcome {
  repoDir: string;
  baseSha: string;
}

/**
 * Split mode carries {ticket, repo} — bare names, never a path (protocol.ts).
 * Derive that pair from a worktree path by requiring it sit EXACTLY at
 * tasks/<ticket>/repositories/<repo> under the workspace root. Throws
 * otherwise: split mode only works for worktrees the driver itself created
 * (multi/worktree.ts uses this same layout); an ad hoc REPO_DIR (the
 * single-repo CLI) cannot be split-mode'd, and we fail loudly rather than
 * silently guess.
 */
function deriveTicketRepo(repoDir: string): { ticket: string; repo: string } {
  const root = resolveWorkspaceRoot();
  const rel = path.relative(root, path.resolve(repoDir));
  const parts = rel.split(path.sep);
  if (parts.length !== 4 || parts[0] !== "tasks" || parts[2] !== "repositories") {
    throw new Error(
      `split mode (WORKERD_SOCKET set) requires worktrees under tasks/<ticket>/repositories/<repo> ` +
        `— got '${repoDir}' (relative to workspace root: '${rel}')`,
    );
  }
  return { ticket: parts[1], repo: parts[3] };
}

/** Create (or reuse) a repo's worktree and record its base sha, via the
 *  worker daemon in split mode or in-process otherwise. */
export async function execSetupWorktree(spec: WorktreeSpec): Promise<SetupOutcome> {
  if (process.env.WORKERD_SOCKET) {
    const res = await rpcSetupWorktree({
      ticket: spec.ticket,
      branch: spec.branch,
      purpose: spec.purpose,
      repo: spec.repo,
    });
    return { repoDir: res.repoDir, baseSha: res.baseSha };
  }
  const repoDir = setupWorktree(spec);
  return { repoDir, baseSha: revParseHead(repoDir) };
}

interface EditStepArgs {
  repoDir: string;
  prompt: string;
  commitMessage: string;
}

async function execEditStep(args: EditStepArgs, kind: "implement" | "fix"): Promise<CommitResult> {
  if (process.env.WORKERD_SOCKET) {
    const { ticket, repo } = deriveTicketRepo(args.repoDir);
    const rpc = kind === "implement" ? rpcRunImplement : rpcRunFix;
    return rpc({ ticket, repo, prompt: args.prompt, commitMessage: args.commitMessage });
  }
  await runAgentQuery(args.prompt, editSessionOptions(args.repoDir, kind));
  return commitAll(args.repoDir, args.commitMessage);
}

/** Run the IMPLEMENT step and commit the result. */
export function execImplement(args: EditStepArgs): Promise<CommitResult> {
  return execEditStep(args, "implement");
}

/** Run the FIX step and commit the result. */
export function execFix(args: EditStepArgs): Promise<CommitResult> {
  return execEditStep(args, "fix");
}

/** Run the test gate against a worktree, via the worker daemon in split mode
 *  or in-process otherwise. */
export async function execTests(repoDir: string): Promise<TestResult> {
  if (process.env.WORKERD_SOCKET) {
    const { ticket, repo } = deriveTicketRepo(repoDir);
    return rpcRunTests({ ticket, repo });
  }
  return testGate(repoDir);
}
