/**
 * types.ts — the WIRE CONTRACT between the broker and the advisory reviewer
 * (M3, see docs/agent-orchestration.md "Broker-side reviewer" + the plan's
 * M3 section).
 *
 * Mirrors broker/src/types.ts's posture: the broker sends exactly ONE typed
 * ReviewerRequest over the unix socket, framed as one newline-terminated
 * JSON object; this process replies with one newline-terminated
 * ReviewerResponse and closes (see server.ts's exactly-one-dispatch guard).
 *
 * This is ADVISORY ONLY. Nothing in this contract can force a publish: the
 * broker treats a null/failed consult (see broker/src/reviewer.ts) as a
 * perfectly legal outcome it renders as "no verdict" at the sha-typed human
 * gate (broker/src/approve.ts). The reviewer therefore does not need to be
 * trusted the way the broker's own policy/config is — a wrong or missing
 * verdict degrades to "the human decides from the diff alone", never to an
 * unreviewed push.
 */
import { z } from "zod";

export const ReviewerRequestSchema = z
  .object({
    // Path INSIDE REVIEWER_DIFF_DIR for large diffs (the reviewer
    // re-validates containment itself — see handler.ts's isInside(), which
    // mirrors broker/src/config.ts's isInside() check).
    diffPath: z.string().max(4096).optional(),
    // Small diffs may be sent inline instead and skip the file round-trip
    // entirely (broker/src/reviewer.ts's INLINE_THRESHOLD_BYTES = 64 KiB;
    // capped here at 4x that for headroom).
    diffInline: z.string().max(256 * 1024).optional(),
    title: z.string().max(1024),
    // UNTRUSTED, coder-authored PR body text. Passed through so the model
    // can reason about it, but handler.ts's prompt labels it explicitly as
    // DATA, never as instructions — see the prompt-injection note there.
    untrustedBody: z.string().max(64 * 1024),
  })
  .strict()
  .refine((v) => (v.diffPath !== undefined) !== (v.diffInline !== undefined), {
    message: "exactly one of diffPath or diffInline must be present",
  });

export type ReviewerRequest = z.infer<typeof ReviewerRequestSchema>;

// The structured-output shape the SDK session itself must return (handler.ts
// passes this schema straight to sdk.ts's runStructuredQuery).
export const ReviewerVerdictSchema = z.object({
  verdict: z.enum(["approve", "concerns"]),
  notes: z.string(),
});
export type ReviewerVerdict = z.infer<typeof ReviewerVerdictSchema>;

// Every failure this process can return, as a stable machine code the
// broker can branch on. Every one of these collapses to "null verdict" on
// the broker side (broker/src/reviewer.ts) — none of them are fatal to a
// publish.
export type ReviewerErrorCode =
  | "invalid_request" // request did not parse against ReviewerRequestSchema
  | "busy" // reviewer is already handling another request (serial by construction)
  | "diff_unreadable" // diffPath escaped REVIEWER_DIFF_DIR, was missing, or exceeded the read cap
  | "session_failed" // the SDK session errored / returned a non-success result
  | "timeout" // per-request budget exceeded — the session was aborted
  | "internal"; // unexpected reviewer error

export type ReviewerResponse =
  | ({ ok: true } & ReviewerVerdict)
  | { ok: false; code: ReviewerErrorCode; error: string };

export const MAX_REQUEST_BYTES = 512 * 1024;

export function encodeReviewerResponse(res: ReviewerResponse): string {
  return JSON.stringify(res) + "\n";
}
