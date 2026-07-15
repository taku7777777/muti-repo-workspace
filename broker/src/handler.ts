/**
 * handler.ts — the broker's decision procedure for ONE publish request.
 *
 * Order matters; every branch is fail-CLOSED (default = did not publish):
 *   1. parse the typed request (never trust the coder's shape);
 *   2. load the TRUSTED policy FAIL-CLOSED (F2);
 *   3. constrain repo to a bare name resolving INSIDE the worktrees root;
 *   4. SCAN the coder's LOCAL git config; fail-closed on any exec-/redirect key so
 *      no coder config is ever executed by later read commands;
 *   5. resolve the worktree's ACTUAL branch/HEAD/cleanliness from git (F1-isolated);
 *   6. parse origin → validate host/org against the policy IN-PROCESS → CONSTRUCT a
 *      canonical push URL from the validated pieces (F4);
 *   7. render GROUND TRUTH by FETCHING the branch from that constructed URL into a
 *      broker-private scratch repo and diffing the approved sha against the
 *      freshly-fetched ref (F3); fail-closed on any incompleteness;
 *   7.5. M3: OPTIONALLY consult the advisory reviewer with that SAME ground-truth
 *      diff (broker/src/reviewer.ts) — the broker's only outbound typed call. ANY
 *      failure (feature off, unreachable, timeout, malformed reply) yields a null
 *      verdict and NEVER throws; it cannot block or fail a publish, only annotate
 *      the human gate below;
 *   8. HUMAN approves at the broker, seeing the resolved target + sha AND the
 *      reviewer's verdict, if any (cancellable);
 *   9. F6: re-scan config, re-resolve+re-validate the target, re-confirm the sha —
 *      all IN-PROCESS, synchronously, immediately before push; any mismatch aborts;
 *  10. push the EXACT approved sha to the constructed URL from the scratch repo,
 *      then `gh pr create` against the explicit --repo.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { approveAtBroker } from "./approve.js";
import { GITHUB_TOKEN, WORKTREES_ROOT, loadPolicy } from "./config.js";
import type { Policy } from "./config.js";
import { maybeConsultReviewer } from "./reviewer.js";
import {
  canonicalHttpsUrl,
  coderObjectsDir,
  createScratchRepo,
  currentBranch,
  ghPrCreate,
  headSha,
  isDirty,
  parseRemote,
  pushApprovedSha,
  remoteUrl,
  removeScratch,
  renderGroundTruth,
  scanUntrustedLocalConfig,
} from "./git.js";
import { PublishRequestSchema } from "./types.js";
import type { PublishErrorCode, PublishResponse, PublishRequest } from "./types.js";
import type { Remote } from "./git.js";

function fail(code: PublishErrorCode, error: string): PublishResponse {
  return { ok: false, code, error };
}

/** Resolve <WORKTREES_ROOT>/<repo> and prove it stays inside the root. */
function resolveWorktree(repo: string): string | null {
  const wt = path.resolve(WORKTREES_ROOT, repo);
  const rootWithSep = WORKTREES_ROOT.endsWith(path.sep) ? WORKTREES_ROOT : WORKTREES_ROOT + path.sep;
  if (wt !== WORKTREES_ROOT && !wt.startsWith(rootWithSep)) return null;
  return wt;
}

function worktreeExists(wt: string): boolean {
  try {
    return fs.existsSync(path.join(wt, ".git"));
  } catch {
    return false;
  }
}

/** Resolve + allowlist-validate the push target from the coder's origin, IN-PROCESS.
 *  Returns the constructed canonical URL and its components, or a fail() response. */
function resolveTarget(
  wt: string,
  cfg: Policy,
): { target: Remote; url: string } | PublishResponse {
  const url = remoteUrl(wt);
  if (!url) return fail("remote_unparseable", "origin remote URL is unset or unreadable");
  const parsed = parseRemote(url);
  if (!parsed) return fail("remote_unparseable", `cannot parse host/org/repo from origin URL '${url}'`);
  if (!cfg.allowed_push_hosts.includes(parsed.host)) {
    return fail(
      "host_not_allowed",
      `push host '${parsed.host}' not in allowed_push_hosts [${cfg.allowed_push_hosts.join(", ")}]`,
    );
  }
  if (cfg.allowed_push_orgs.length > 0 && !cfg.allowed_push_orgs.includes(parsed.org)) {
    return fail(
      "org_not_allowed",
      `push org '${parsed.org}' not in allowed_push_orgs [${cfg.allowed_push_orgs.join(", ")}]`,
    );
  }
  const canonical = canonicalHttpsUrl(parsed);
  if (!canonical) return fail("remote_unparseable", `origin components did not form a valid https URL`);
  return { target: parsed, url: canonical };
}

export async function handleRequest(raw: unknown, signal?: AbortSignal): Promise<PublishResponse> {
  // 1. Typed request only.
  const parsedReq = PublishRequestSchema.safeParse(raw);
  if (!parsedReq.success) {
    return fail("invalid_request", `request did not validate: ${parsedReq.error.message}`);
  }
  const req: PublishRequest = parsedReq.data;

  // 2. TRUSTED policy, FAIL-CLOSED.
  let cfg: Policy;
  try {
    cfg = loadPolicy();
  } catch (e) {
    return fail("config_missing", (e as Error).message);
  }

  // 3. Bare repo resolving inside the worktrees root.
  const wt = resolveWorktree(req.repo);
  if (!wt) return fail("repo_not_allowed", `repo '${req.repo}' resolves outside the worktrees root`);
  if (!worktreeExists(wt)) {
    return fail("worktree_missing", `no worktree for '${req.repo}' under ${WORKTREES_ROOT}`);
  }

  // 4. The coder's .git config is UNTRUSTED — fail closed on any exec/redirect key
  //    BEFORE running status/log/diff that could otherwise execute it.
  const bad = scanUntrustedLocalConfig(wt);
  if (bad) return fail("untrusted_config", `coder-writable git config is not trusted: ${bad}`);

  // 5. Ground-truth branch/HEAD/cleanliness from git (F1-isolated), not the coder's claim.
  const actualBranch = currentBranch(wt);
  if (!actualBranch) return fail("worktree_missing", `cannot resolve HEAD for '${req.repo}'`);
  if (actualBranch === "HEAD") return fail("detached_head", `worktree '${req.repo}' is in detached HEAD state`);
  if (actualBranch !== req.branch) {
    return fail("branch_mismatch", `request branch '${req.branch}' != worktree branch '${actualBranch}'`);
  }
  if (!actualBranch.startsWith(cfg.branch_prefix)) {
    return fail("branch_not_allowed", `branch '${actualBranch}' does not match branch_prefix '${cfg.branch_prefix}'`);
  }

  const dirty = isDirty(wt);
  if (dirty === null) return fail("worktree_missing", `cannot read git status for '${req.repo}'`);
  if (dirty) return fail("dirty_worktree", "worktree has uncommitted or untracked changes");

  // 6. Resolve + allowlist-validate the push target IN-PROCESS; construct the URL.
  const t = resolveTarget(wt, cfg);
  if ("ok" in t) return t; // it's a fail() response
  const { target, url } = t;

  const shaBefore = headSha(wt);
  if (!shaBefore) return fail("worktree_missing", `cannot resolve HEAD sha for '${req.repo}'`);

  const objectsDir = coderObjectsDir(wt);
  if (!objectsDir) return fail("worktree_missing", `cannot locate the object store for '${req.repo}'`);

  // 7. Ground truth: fetch the branch from the CONSTRUCTED URL into a broker-private
  //    scratch repo, diff the approved sha against the freshly-fetched ref.
  const scratch = createScratchRepo();
  try {
    const render = renderGroundTruth({
      scratch,
      objectsDir,
      sha: shaBefore,
      url,
      branch: actualBranch,
      token: GITHUB_TOKEN,
    });
    if (!render.ok) return fail(render.code, render.error);
    if (render.unpushed === 0 && render.diff.length === 0) {
      return fail("nothing_to_publish", "no commits ahead of the remote — nothing to publish");
    }

    // 7.5. Advisory reviewer consult (M3, optional). The broker stays
    // LLM-free itself: this is one outbound typed socket call, given the
    // SAME ground-truth diff the human is about to see — never the coder's
    // words. Any failure (env unset, unreachable, timeout, malformed reply)
    // returns null; this call NEVER throws into the publish path.
    const reviewerVerdict = await maybeConsultReviewer(render.diff, req.title, req.body, signal);

    // 8. Human gate (cancellable). No await between here and the push except this one.
    let approved: boolean;
    try {
      approved = await approveAtBroker(
        {
          repo: req.repo,
          branch: actualBranch,
          headSha: shaBefore,
          title: req.title,
          body: req.body,
          host: target.host,
          org: target.org,
          targetRepo: target.repo,
          url,
          commitCount: render.unpushed,
          commitList: render.commitList,
          diffStat: render.diffStat,
          diff: render.diff,
          reviewerVerdict,
        },
        signal,
      );
    } catch (e) {
      // Aborted (approval budget / dropped client) => never pushed.
      return { ok: false, code: "canceled", error: `approval canceled: ${(e as Error).message}`, sha: shaBefore };
    }
    if (!approved) {
      return { ok: false, code: "declined", error: "human declined at the broker gate", sha: shaBefore };
    }

    // 9. F6 — re-validate IN-PROCESS, synchronously, immediately before push. No
    //    await here, so the approval budget cannot interleave between check and push.
    if (signal?.aborted) {
      return { ok: false, code: "canceled", error: "aborted after approval, before push", sha: shaBefore };
    }
    const badNow = scanUntrustedLocalConfig(wt);
    if (badNow) return fail("untrusted_config", `git config changed to untrusted before push: ${badNow}`);

    const t2 = resolveTarget(wt, cfg);
    if ("ok" in t2) return t2;
    if (t2.url !== url) {
      return fail("host_not_allowed", `push target changed after approval ('${url}' -> '${t2.url}'); aborting`);
    }

    const shaNow = headSha(wt);
    if (shaNow !== shaBefore) {
      return {
        ok: false,
        code: "sha_changed",
        error: `worktree HEAD moved after approval (${shaBefore} -> ${shaNow ?? "unknown"}); aborting`,
        sha: shaBefore,
      };
    }

    // 10. Push the EXACT approved sha to the constructed URL, then open the PR.
    const pushed = pushApprovedSha({
      scratch,
      objectsDir,
      sha: shaBefore,
      url,
      branch: actualBranch,
      token: GITHUB_TOKEN,
    });
    if (!pushed.ok) {
      return {
        ok: false,
        code: "push_failed",
        error: `git push failed (status ${pushed.status ?? "null"}): ${(pushed.stderr || pushed.stdout).trim()}`,
        sha: shaBefore,
      };
    }

    const pr = ghPrCreate({
      host: target.host,
      org: target.org,
      repo: target.repo,
      title: req.title,
      body: req.body,
      branch: actualBranch,
      token: GITHUB_TOKEN,
    });
    if (!pr.ok) {
      return {
        ok: false,
        code: "pr_failed",
        error: `push succeeded but gh pr create failed (status ${pr.status ?? "null"}): ${(pr.stderr || pr.stdout).trim()}`,
        sha: shaBefore,
      };
    }

    return { ok: true, sha: shaBefore, branch: actualBranch, prUrl: pr.url };
  } finally {
    removeScratch(scratch);
  }
}
