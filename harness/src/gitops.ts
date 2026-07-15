/**
 * gitops.ts — the harness's non-LLM git primitives.
 *
 *   commitAll       — the DETERMINISTIC post-step commit (worker side / fallback).
 *   revParseHead    — read HEAD (used to record a repo's base sha before work).
 *   commitRangeDiff — the READ-ONLY diff <baseSha>..HEAD the orchestrator
 *                     computes for review + the human publish gate.
 *
 * Why commit-range instead of the old workingDiff (`git add -A -N` + `git
 * diff`): intent-to-add WRITES the index, which is impossible on the
 * orchestrator container's read-only worktree mount. Instead the worker daemon
 * commits deterministically after every implement/fix step, so
 *   (a) the diff becomes a pure read of git objects (works on :ro), computed by
 *       the ORCHESTRATOR — reviewer-blinding stays closed because the worker
 *       never supplies the diff, and
 *   (b) the worktree is always clean for the broker's dirty_worktree check
 *       (removing the live-validated wart where ticket instructions had to say
 *       "commit your work").
 *
 * All git runs via spawnSync argv arrays — never a shell.
 */
import { spawnSync } from "node:child_process";

const MAX_DIFF_BUFFER = 64 * 1024 * 1024;

// Commit identity is pinned per-invocation with -c (worker containers have no
// global git identity, and we never write the worktree's .git/config).
const COMMIT_IDENTITY = [
  "-c",
  "user.name=mrw-worker",
  "-c",
  "user.email=mrw-worker@local",
];

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function git(repoDir: string, args: string[]): GitResult {
  const r = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    maxBuffer: MAX_DIFF_BUFFER,
  });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status,
  };
}

/** HEAD of the repo, or throw (a repo without a readable HEAD is not workable). */
export function revParseHead(repoDir: string): string {
  const r = git(repoDir, ["rev-parse", "HEAD"]);
  if (!r.ok || !r.stdout) {
    throw new Error(`rev-parse HEAD failed in ${repoDir}: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

export interface CommitResult {
  /** false when the step changed nothing — a valid outcome, judged by review. */
  committed: boolean;
  headSha: string;
}

/**
 * Stage everything and commit with the SPINE-supplied message. "Nothing to
 * commit" is not an error; any git failure throws (→ fail-closed upstream).
 */
export function commitAll(repoDir: string, message: string): CommitResult {
  const add = git(repoDir, ["add", "-A"]);
  if (!add.ok) {
    throw new Error(`git add -A failed in ${repoDir}: ${add.stderr || add.stdout}`);
  }
  const status = git(repoDir, ["status", "--porcelain"]);
  if (!status.ok) {
    throw new Error(`git status failed in ${repoDir}: ${status.stderr || status.stdout}`);
  }
  if (status.stdout.length === 0) {
    return { committed: false, headSha: revParseHead(repoDir) };
  }
  const commit = git(repoDir, [...COMMIT_IDENTITY, "commit", "-m", message]);
  if (!commit.ok) {
    throw new Error(`git commit failed in ${repoDir}: ${commit.stderr || commit.stdout}`);
  }
  return { committed: true, headSha: revParseHead(repoDir) };
}

export interface RangeDiff {
  diff: string;
  /**
   * false when the diff could NOT be computed completely — git errored or the
   * output exceeded the buffer (a reviewer-BLINDING vector: pad a file past the
   * limit so the diff truncates and the reviewer judges nothing). The
   * orchestrator treats an incomplete diff as fail-closed, never as "approve".
   */
  complete: boolean;
}

/** READ-ONLY diff of everything the pipeline produced: <baseSha>..HEAD. */
export function commitRangeDiff(repoDir: string, baseSha: string): RangeDiff {
  const r = spawnSync("git", ["-C", repoDir, "diff", "--no-color", baseSha, "HEAD"], {
    encoding: "utf8",
    maxBuffer: MAX_DIFF_BUFFER,
  });
  if (r.error || r.status !== 0) {
    return {
      diff:
        "(commit-range diff could not be computed completely — git error or " +
        "output too large; possible reviewer-blinding)",
      complete: false,
    };
  }
  return { diff: r.stdout.trim() || "(no committed changes since the base sha)", complete: true };
}
