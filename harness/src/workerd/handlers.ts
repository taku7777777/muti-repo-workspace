/**
 * workerd/handlers.ts — the worker daemon's dispatch table: turns one
 * validated WorkerRequest into the effect it names, using primitives that
 * already exist elsewhere (multi/worktree.ts, gitops.ts, sdk.ts, steps.ts,
 * gates.ts). This file adds NO new git/SDK logic of its own — it wires the
 * DAEMON-SIDE containment + tool posture around them.
 *
 * Containment: the request carries {ticket, repo} as BARE NAMES, never paths
 * (enforced by protocol.ts's zod schema — see BARE_NAME there). This file
 * still re-derives tasks/<ticket>/repositories/<repo> itself and asserts with
 * path.resolve that it lands inside <root>/tasks before touching disk — the
 * same defense-in-depth posture as the broker's resolveWorktree()
 * (broker/src/handler.ts), even though the schema already makes an escape
 * impossible.
 *
 * Tool posture: for run_implement/run_fix the DAEMON pins editSessionOptions()
 * (steps.ts: cwd/systemPrompt/tools/disallowedTools/maxTurns) — never the
 * orchestrator's request. An injected orchestrator can vary req.prompt freely;
 * it can never widen the tool set (see protocol.ts's header comment).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { resolveWorkspaceRoot } from "../multi/config.js";
import { setupWorktree } from "../multi/worktree.js";
import { commitAll, revParseHead } from "../gitops.js";
import { runAgentQuery } from "../sdk.js";
import { editSessionOptions } from "../steps.js";
import { testGate } from "../gates.js";
import { WorkerRequestSchema } from "./protocol.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";

// NaN-defensive parse, same pattern as sdk.ts's MAX_FIX_ATTEMPTS: a
// non-numeric env value must not silently produce NaN, which would make
// `spawnSync(..., {timeout: NaN})` (gates.ts) treat it as "no timeout" and
// quietly un-bound the test gate inside the serial daemon.
//
// Read here (not threaded in from index.ts) so there is exactly one place
// that parses WORKERD_TEST_TIMEOUT_MS; index.ts imports the resulting
// constant back for its startup banner instead of re-parsing the env var.
function parseMs(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : def;
}
export const WORKERD_TEST_TIMEOUT_MS = parseMs(process.env.WORKERD_TEST_TIMEOUT_MS, 15 * 60 * 1000);

/** Resolve tasks/<ticket>/repositories/<repoName> and assert it stays inside
 *  <root>/tasks. Throws on escape — callers map that to "worktree_invalid". */
function resolveContainedTarget(root: string, ticket: string, repoName: string): string {
  const target = path.resolve(root, "tasks", ticket, "repositories", repoName);
  const tasksRoot = path.resolve(root, "tasks");
  const tasksRootWithSep = tasksRoot.endsWith(path.sep) ? tasksRoot : tasksRoot + path.sep;
  if (target !== tasksRoot && !target.startsWith(tasksRootWithSep)) {
    throw new Error(`target '${target}' escapes the tasks root '${tasksRoot}'`);
  }
  return target;
}

function hasGitDir(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

export async function handleWorkerRequest(
  raw: unknown,
  signal: AbortSignal,
): Promise<WorkerResponse> {
  const parsed = WorkerRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "invalid_request", error: parsed.error.message };
  }
  const req: WorkerRequest = parsed.data;
  const root = resolveWorkspaceRoot();

  switch (req.op) {
    case "setup_worktree":
      return handleSetupWorktree(root, req);
    case "run_implement":
      return handleEditStep(root, req, "implement", signal);
    case "run_fix":
      return handleEditStep(root, req, "fix", signal);
    case "run_tests":
      return handleRunTests(root, req);
  }
}

async function handleSetupWorktree(
  root: string,
  req: Extract<WorkerRequest, { op: "setup_worktree" }>,
): Promise<WorkerResponse> {
  let target: string;
  try {
    target = resolveContainedTarget(root, req.ticket, req.repo.name);
  } catch (e) {
    return { ok: false, code: "worktree_invalid", error: (e as Error).message };
  }
  try {
    const repoDir = setupWorktree({
      root,
      repo: req.repo,
      ticket: req.ticket,
      branch: req.branch,
      purpose: req.purpose,
    });
    if (path.resolve(repoDir) !== target) {
      // setupWorktree() derives the same tasks/<ticket>/repositories/<repo>
      // formula internally (multi/worktree.ts); a mismatch means the two
      // derivations diverged — fail closed rather than trust whatever path it
      // actually wrote to.
      return {
        ok: false,
        code: "worktree_invalid",
        error: `setupWorktree resolved to '${repoDir}', expected '${target}'`,
      };
    }
    const baseSha = revParseHead(repoDir);
    return { ok: true, op: "setup_worktree", repoDir, baseSha };
  } catch (e) {
    return { ok: false, code: "setup_failed", error: (e as Error).message };
  }
}

async function handleEditStep(
  root: string,
  req: Extract<WorkerRequest, { op: "run_implement" | "run_fix" }>,
  kind: "implement" | "fix",
  signal: AbortSignal,
): Promise<WorkerResponse> {
  let repoDir: string;
  try {
    repoDir = resolveContainedTarget(root, req.ticket, req.repo);
  } catch (e) {
    return { ok: false, code: "worktree_invalid", error: (e as Error).message };
  }
  if (!hasGitDir(repoDir)) {
    return {
      ok: false,
      code: "worktree_invalid",
      error: `no worktree at ${repoDir} — run setup_worktree first`,
    };
  }

  // A fresh AbortController chained from the server's per-op budget signal:
  // when the budget fires (or the client drops), server.ts aborts `signal`,
  // and this listener propagates the abort into the actual running SDK
  // session via Options.abortController (sdk.d.ts:1287, confirmed present in
  // @anthropic-ai/claude-agent-sdk@0.3.205) — so the step is really cancelled,
  // not just abandoned while it keeps editing in the background.
  const ac = new AbortController();
  if (signal.aborted) ac.abort();
  else signal.addEventListener("abort", () => ac.abort());

  try {
    await runAgentQuery(req.prompt, { ...editSessionOptions(repoDir, kind), abortController: ac });
  } catch (e) {
    return { ok: false, code: "step_failed", error: (e as Error).message };
  }

  try {
    const { committed, headSha } = commitAll(repoDir, req.commitMessage);
    return { ok: true, op: req.op, committed, headSha };
  } catch (e) {
    return { ok: false, code: "commit_failed", error: (e as Error).message };
  }
}

async function handleRunTests(
  root: string,
  req: Extract<WorkerRequest, { op: "run_tests" }>,
): Promise<WorkerResponse> {
  let repoDir: string;
  try {
    repoDir = resolveContainedTarget(root, req.ticket, req.repo);
  } catch (e) {
    return { ok: false, code: "worktree_invalid", error: (e as Error).message };
  }
  if (!hasGitDir(repoDir)) {
    return {
      ok: false,
      code: "worktree_invalid",
      error: `no worktree at ${repoDir} — run setup_worktree first`,
    };
  }
  // testGate() (gates.ts) already folds a spawn failure or a killed
  // (timed-out) run into pass:false/status:null rather than throwing, so
  // there is no separate "tests_failed_to_run" path to reach from here — that
  // code is reserved in protocol.ts for taxonomy symmetry with the broker,
  // but a dispatched run_tests always answers ok:true here; a bad exit code
  // is INFORMATION for the fix loop, not a daemon failure.
  const result = testGate(repoDir, WORKERD_TEST_TIMEOUT_MS);
  return { ok: true, op: "run_tests", pass: result.pass, status: result.status, output: result.output };
}
