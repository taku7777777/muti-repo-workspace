/**
 * workerd/protocol.ts — the WIRE CONTRACT between the orchestrator container's
 * spine and the worker container's daemon.
 *
 * Same trust posture as the broker contract (broker/src/types.ts): the request
 * is a typed INTENT, validated fail-closed on the receiving side. Identifiers
 * are bare names (never paths) — the DAEMON resolves
 * tasks/<ticket>/repositories/<repo> itself and contains it under the
 * worktrees root, so a compromised orchestrator cannot point a step at an
 * arbitrary path.
 *
 * The prompt text IS orchestrator-composed (steps.ts owns the wording — no
 * duplication drift), but the daemon pins the TOOL POSTURE (tools /
 * disallowedTools / maxTurns / cwd) itself: an arbitrary prompt buys exactly
 * today's coder power, contained by the worker cage.
 *
 * Framing: one newline-terminated JSON request per connection; one
 * newline-terminated response; exactly one dispatch per connection.
 */
import { z } from "zod";
import { RepoConfigSchema } from "../multi/types.js";

// Generous: prompts embed the plan JSON, review findings, and test-output tails.
export const MAX_REQUEST_BYTES = 1024 * 1024;

// A ticket id / bare repo dir name — never a path (mirrors broker BARE_REPO).
const BARE_NAME = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "must be a bare name (letters, digits, . _ -)")
  .refine((s) => s !== "." && s !== ".." && !s.includes(".."), {
    message: "must not be '.', '..', or contain '..'",
  });

// A git branch name (mirrors broker BRANCH; prefix policy is not checked here —
// the broker re-validates it at publish time regardless).
const BRANCH = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._\/-]+$/, "branch has invalid characters")
  .refine(
    (s) => !s.startsWith("/") && !s.endsWith("/") && !s.includes("..") && !s.includes("//"),
    { message: "branch has an invalid shape" },
  );

const PROMPT = z.string().min(1).max(512 * 1024);
const COMMIT_MESSAGE = z.string().min(1).max(1024);

export const WorkerRequestSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("setup_worktree"),
      ticket: BARE_NAME,
      branch: BRANCH,
      purpose: z.string().min(1).max(64),
      // The full repo config entry (name/url/type/sparse_paths) — the daemon
      // validates the name again and uses url only as a remote string.
      repo: RepoConfigSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("run_implement"),
      ticket: BARE_NAME,
      repo: BARE_NAME,
      prompt: PROMPT,
      commitMessage: COMMIT_MESSAGE,
    })
    .strict(),
  z
    .object({
      op: z.literal("run_fix"),
      ticket: BARE_NAME,
      repo: BARE_NAME,
      prompt: PROMPT,
      commitMessage: COMMIT_MESSAGE,
    })
    .strict(),
  z
    .object({
      op: z.literal("run_tests"),
      ticket: BARE_NAME,
      repo: BARE_NAME,
    })
    .strict(),
]);
export type WorkerRequest = z.infer<typeof WorkerRequestSchema>;

// Every failure the daemon can return. All fail-CLOSED: the default posture is
// "the step did not complete" — the spine treats any non-ok as a hard stop.
export type WorkerErrorCode =
  | "invalid_request" // request did not parse against WorkerRequestSchema
  | "busy" // daemon is handling another step (serial by construction)
  | "worktree_invalid" // ticket/repo did not resolve to a contained worktree
  | "setup_failed" // clone/sparse/branch setup failed
  | "step_failed" // the SDK session errored / non-success result
  | "commit_failed" // git add/commit after the step failed
  | "tests_failed_to_run" // the test command could not be spawned at all
  | "timeout" // per-op budget exceeded — the step was aborted
  | "internal"; // unexpected daemon error

export type WorkerResponse =
  | { ok: true; op: "setup_worktree"; repoDir: string; baseSha: string }
  | { ok: true; op: "run_implement" | "run_fix"; committed: boolean; headSha: string }
  | {
      ok: true;
      op: "run_tests";
      pass: boolean;
      status: number | null;
      /** 200-line tail of combined stdout+stderr (fed to the fix step). */
      output: string;
    }
  | { ok: false; code: WorkerErrorCode; error: string };

export function encodeWorkerResponse(res: WorkerResponse): string {
  return JSON.stringify(res) + "\n";
}
