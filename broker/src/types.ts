/**
 * types.ts — the WIRE CONTRACT between the caged coder's harness and the broker.
 *
 * The coder sends exactly ONE typed PublishRequest over the unix socket. It does
 * NOT send a diff to be trusted: the broker renders the ground-truth diff itself
 * from git objects (by sha, in a broker-private repo). The request is only an
 * INTENT ("publish this repo/branch with this title/body"); every field is
 * re-validated on the trusted side before anything is pushed.
 *
 * Framing: one JSON object, newline-terminated, per connection. The broker replies
 * with one newline-terminated PublishResponse and closes. EXACTLY ONE request line
 * is dispatched per connection.
 */
import { z } from "zod";

// A bare repository directory name — never a path. Mirrors the constraint in
// scripts/task/push-create-pr.sh (reject '', flags, '/' and '..'): a value like
// '../../other-repo' must not be able to point git at a repo outside the
// worktrees root.
const BARE_REPO = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "repo must be a bare name (letters, digits, . _ -)")
  .refine((s) => s !== "." && s !== ".." && !s.includes(".."), {
    message: "repo must not be '.', '..', or contain '..'",
  });

// A git branch name. Prefix (branch_prefix from the TRUSTED policy) is checked in
// the handler, not here. Here we only bar control characters, whitespace, and
// obvious ref-injection shapes.
const BRANCH = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._\/-]+$/, "branch has invalid characters")
  .refine((s) => !s.startsWith("/") && !s.endsWith("/") && !s.includes("..") && !s.includes("//"), {
    message: "branch has an invalid shape",
  });

export const PublishRequestSchema = z
  .object({
    repo: BARE_REPO,
    branch: BRANCH,
    title: z.string().min(1).max(1024),
    // Body may be empty-ish but must be a string and size-bounded (it lands in a
    // public PR body). No newlines are stripped — gh receives it verbatim as argv.
    body: z.string().max(64 * 1024),
  })
  .strict();

export type PublishRequest = z.infer<typeof PublishRequestSchema>;

// Every failure the broker can return, as a stable machine code the harness can
// branch on. All are fail-CLOSED: the default posture is "did not publish".
export type PublishErrorCode =
  | "invalid_request" // request did not parse against PublishRequestSchema
  | "config_missing" // TRUSTED policy (BROKER_POLICY_FILE) unreadable/invalid/untrusted-path
  | "repo_not_allowed" // repo is not a bare name / escapes the worktrees root
  | "worktree_missing" // no worktree for this repo on the trusted side
  | "untrusted_config" // coder-writable .git config has exec-/redirect-capable keys
  | "detached_head" // worktree HEAD is detached — no branch to push
  | "branch_mismatch" // request branch != the worktree's actual HEAD branch
  | "branch_not_allowed" // branch does not match branch_prefix
  | "dirty_worktree" // uncommitted/untracked changes present
  | "remote_unparseable" // origin URL could not be parsed for host/org/repo
  | "host_not_allowed" // push host not in allowed_push_hosts
  | "org_not_allowed" // push org not in allowed_push_orgs
  | "fetch_failed" // could not fetch the branch from the constructed remote URL
  | "render_incomplete" // ground-truth diff could not be rendered completely (fail closed)
  | "nothing_to_publish" // no commits ahead of the remote
  | "declined" // human said no at the broker gate
  | "canceled" // approval budget exceeded / client dropped — aborted, never pushed
  | "sha_changed" // worktree HEAD moved between approval and push (replay/TOCTOU)
  | "push_failed" // git push failed
  | "pr_failed" // push succeeded but gh pr create failed
  | "busy"; // broker is already handling another request

export type PublishResponse =
  | { ok: true; sha: string; branch: string; prUrl: string | null }
  | { ok: false; code: PublishErrorCode; error: string; sha?: string };

export function encodeResponse(res: PublishResponse): string {
  return JSON.stringify(res) + "\n";
}
