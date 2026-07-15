/**
 * multi/worktree.ts — create an ISOLATED per-repo worktree for one ticket.
 *
 * Phase 3 uses `git clone --reference <ro-origin> --dissociate` (NOT `git
 * worktree add`) so each repo gets a fully independent checkout with its own
 * HEAD/index — GIT-level isolation: a per-repo coder's commits/branches never
 * touch the shared origin or a sibling repo's git state. (This is NOT OS-level
 * isolation: all worktrees share one RW bind mount, so a coder's Bash can still
 * read/write sibling files. Containment against that is the broker human-gate +
 * per-repo diff review, not the filesystem; the origins are mounted read-only.)
 * The clone is LOCAL — the source is the workspace's
 * read-only origin at repositories/<repo>, so it needs NO network (the caged
 * coder has none). `--reference <origin>` borrows the origin's objects and
 * `--dissociate` then copies them in, so the clone is standalone and fast.
 *
 * For type:'knowledge' repos we clone with --sparse (cone mode: only top-level
 * files checked out) and then narrow the cone to sparse_paths[purpose] with
 * `sparse-checkout set`, which MATERIALIZES those subtrees. (An earlier
 * --no-checkout + set + `checkout -b` sequence left the working tree EMPTY —
 * `checkout -b` at the same HEAD performs no populating checkout — so the coder
 * saw an empty repo. --sparse checks out up front, so `set` has a populated tree
 * to narrow and the feature branch inherits it.)
 *
 * After cloning we point `origin` at the repo's REAL upstream url (repo.url) —
 * the local clone's origin would otherwise be the on-disk path, which the Phase-2
 * broker cannot parse into host/org for a push. The coder still cannot push; the
 * broker (outside the container) is the only thing that reaches that url, and it
 * re-validates and reconstructs the URL from its trusted allowlist regardless.
 *
 * All git runs via spawnSync argv arrays — never a shell.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RepoConfig } from "./types.js";

export interface WorktreeSpec {
  root: string;
  repo: RepoConfig;
  ticket: string;
  /** Branch to create/checkout: <branch_prefix><ticket>. */
  branch: string;
  /** Sparse-checkout purpose (knowledge repos only). */
  purpose: string;
}

interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  status: number | null;
}

function git(cwd: string | null, args: string[]): GitResult {
  const full = cwd ? ["-C", cwd, ...args] : args;
  const r = spawnSync("git", full, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return {
    ok: !r.error && r.status === 0,
    stdout: (r.stdout ?? "").trim(),
    stderr: (r.stderr ?? "").trim(),
    status: r.status,
  };
}

function gitOrThrow(cwd: string | null, args: string[], what: string): string {
  const r = git(cwd, args);
  if (!r.ok) {
    throw new Error(
      `git ${what} failed (status=${r.status}): git ${args.join(" ")}\n${r.stderr || r.stdout}`,
    );
  }
  return r.stdout;
}

/** Does refs/heads/<branch> already exist in the repo at cwd? */
function branchExists(cwd: string, branch: string): boolean {
  return git(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
}

/** Put the worktree on <branch>, creating it if needed. Idempotent. */
function ensureBranch(target: string, branch: string): void {
  const current = git(target, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (current.ok && current.stdout === branch) return;
  if (branchExists(target, branch)) {
    gitOrThrow(target, ["checkout", branch], `checkout ${branch}`);
  } else {
    gitOrThrow(target, ["checkout", "-b", branch], `checkout -b ${branch}`);
  }
}

/**
 * Create (or reuse) the worktree for one repo and return its absolute path.
 * Idempotent: an existing worktree is reused (resumability), which just re-asserts
 * the branch and origin url.
 */
export function setupWorktree(spec: WorktreeSpec): string {
  const { root, repo, ticket, branch, purpose } = spec;
  const origin = path.join(root, "repositories", repo.name);
  const target = path.join(root, "tasks", ticket, "repositories", repo.name);

  if (!fs.existsSync(path.join(origin, ".git")) && !fs.existsSync(path.join(origin, "HEAD"))) {
    throw new Error(
      `origin clone missing for '${repo.name}' at ${origin} — run /setup-workspace first.`,
    );
  }

  const isKnowledge = repo.type === "knowledge";
  const sparsePaths = repo.sparse_paths?.[purpose] ?? [];
  const useSparse = isKnowledge && sparsePaths.length > 0;

  const alreadyThere = fs.existsSync(path.join(target, ".git"));
  if (!alreadyThere) {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    // LOCAL clone: source AND reference are the on-disk origin (no network).
    const cloneArgs = ["clone", "--reference", origin, "--dissociate"];
    // --sparse: clone in cone mode with only top-level files checked out, so the
    // subsequent `sparse-checkout set` narrows a POPULATED tree (not an empty one).
    if (useSparse) cloneArgs.push("--sparse");
    cloneArgs.push(origin, target);
    gitOrThrow(null, cloneArgs, `clone ${repo.name}`);

    if (useSparse) {
      gitOrThrow(target, ["sparse-checkout", "set", "--cone", ...sparsePaths], "sparse-checkout set");
      // Fail closed if the cone produced an empty tree (misconfigured sparse_paths,
      // or a git that didn't materialize) — an empty worktree would silently make
      // the per-repo coder plan/implement/review against nothing.
      const tracked = git(target, ["ls-files"]);
      if (!tracked.ok || tracked.stdout.length === 0) {
        throw new Error(
          `sparse checkout for '${repo.name}' produced an EMPTY working tree ` +
            `(sparse_paths for purpose '${purpose}': ${JSON.stringify(sparsePaths)}). ` +
            "Check the cone paths exist in the repo.",
        );
      }
    } else if (isKnowledge) {
      console.warn(
        `[worktree] ${repo.name}: type=knowledge but no sparse_paths for purpose ` +
          `'${purpose}' — falling back to a FULL checkout.`,
      );
    }
  }

  // Point origin at the real upstream so the broker can resolve the push target
  // (the local clone's origin is the on-disk path). Harmless / idempotent on reuse.
  if (repo.url) {
    gitOrThrow(target, ["remote", "set-url", "origin", repo.url], "remote set-url origin");
  }

  ensureBranch(target, branch);
  return target;
}
