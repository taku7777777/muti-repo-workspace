/**
 * wire.ts — the SAME approval-socket wire contract broker/src/approval-types.ts
 * declares (implementation contract §1), RE-DECLARED here with zod rather than
 * imported. This mirrors reviewer/src/types.ts vs broker/src/reviewer.ts: serve
 * ships as its own package/image and must not depend on broker source, so a
 * malformed or unexpected broker reply is VALIDATED here, never blindly cast.
 *
 * Every string field on `ViewWireSchema` is UNTRUSTED-FOR-RENDERING even though
 * the broker itself is a trusted process: it is forwarding the coder's own
 * title/body verbatim (see broker/src/approve.ts's ApprovalView doc comment).
 * serve must escape every one of these fields at the point it turns them into
 * HTML — see src/html.ts and assets/app.js. Nothing here does any escaping;
 * this file only proves the SHAPE of what the broker sent.
 */
import { z } from "zod";

// --- verdict / view -----------------------------------------------------

const ReviewerVerdictWireSchema = z.object({
  verdict: z.enum(["approve", "concerns"]),
  notes: z.string(),
});
export type ReviewerVerdictWire = z.infer<typeof ReviewerVerdictWireSchema>;

// Every ApprovalView field (broker/src/approve.ts) plus the two the approval
// protocol adds on top (§1): shortSha and ticket.
export const ViewWireSchema = z.object({
  repo: z.string(),
  branch: z.string(),
  headSha: z.string(),
  title: z.string(),
  body: z.string(),
  host: z.string(),
  org: z.string(),
  targetRepo: z.string(),
  url: z.string(),
  commitCount: z.number(),
  commitList: z.string(),
  diffStat: z.string(),
  diff: z.string(),
  // Tri-state exactly like broker/src/approve.ts's ApprovalView.reviewerVerdict:
  // null = feature off (render nothing), "unavailable" = feature on but the
  // consult failed (render an explicit no-verdict line), object = a verdict.
  reviewerVerdict: z.union([ReviewerVerdictWireSchema, z.literal("unavailable"), z.null()]),
  // Broker-computed test-independence caveat (broker/src/caveat.ts, Thread C):
  // true = the diff touches test files/config, so a green test gate may not be
  // independent of the coder's edits. Advisory only, like reviewerVerdict.
  // OPTIONAL with a false default so serve keeps working against brokers from
  // either side of the field's introduction (zod would otherwise silently
  // strip an undeclared key — hiding from the browser a caveat the TTY shows).
  testCaveat: z.boolean().optional().default(false),
  shortSha: z.string(),
  ticket: z.string().nullable(),
});
export type ViewWire = z.infer<typeof ViewWireSchema>;

export const PendingWireSchema = z.object({
  id: z.string(),
  startedAt: z.number(),
  attemptsLeft: z.number(),
  view: ViewWireSchema,
});
export type PendingWire = z.infer<typeof PendingWireSchema>;

const PublishResultWireSchema = z.union([
  z.object({ ok: z.literal(true), prUrl: z.string().nullable() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PublishResultWire = z.infer<typeof PublishResultWireSchema>;

export const OutcomeWireSchema = z.object({
  id: z.string(),
  decision: z.enum(["approved", "declined", "canceled"]),
  channel: z.enum(["tty", "socket"]),
  decidedAt: z.number(),
  publish: z.union([PublishResultWireSchema, z.null()]),
});
export type OutcomeWire = z.infer<typeof OutcomeWireSchema>;

// --- op: status -----------------------------------------------------------

export const StatusResponseSchema = z.object({
  ok: z.literal(true),
  protocol: z.literal(1),
  pending: z.union([PendingWireSchema, z.literal("unchanged"), z.null()]),
  last: z.union([OutcomeWireSchema, z.null()]),
});
export type StatusResponse = z.infer<typeof StatusResponseSchema>;

export function statusRequest(known?: string): unknown {
  return known !== undefined ? { op: "status", known } : { op: "status" };
}

// --- op: approve ------------------------------------------------------------

export const ApproveResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.literal("approved") }),
  z.object({ ok: z.literal(true), result: z.literal("declined"), code: z.literal("attempts_exhausted") }),
  z.object({ ok: z.literal(false), code: z.literal("sha_mismatch"), attemptsLeft: z.number() }),
  z.object({ ok: z.literal(false), code: z.literal("no_pending") }),
  z.object({ ok: z.literal(false), code: z.literal("stale") }),
  z.object({ ok: z.literal(false), code: z.literal("invalid_request"), error: z.string() }),
]);
export type ApproveResponse = z.infer<typeof ApproveResponseSchema>;

export function approveRequest(id: string, sha: string): unknown {
  return { op: "approve", id, sha };
}

// --- op: decline ------------------------------------------------------------

export const DeclineResponseSchema = z.union([
  z.object({ ok: z.literal(true), result: z.literal("declined") }),
  z.object({ ok: z.literal(false), code: z.literal("no_pending") }),
  z.object({ ok: z.literal(false), code: z.literal("stale") }),
  z.object({ ok: z.literal(false), code: z.literal("invalid_request"), error: z.string() }),
]);
export type DeclineResponse = z.infer<typeof DeclineResponseSchema>;

export function declineRequest(id: string): unknown {
  return { op: "decline", id };
}

// --- serve-local, NOT part of the wire protocol -----------------------------
//
// serve's own memory-ring summary of an outcome it has observed, enriched
// from its view cache (see broker-client.ts). Shape pinned by implementation
// contract §3.3's "history" bullet. `repo` here is the GITHUB target repo
// (ViewWire.targetRepo), not the worktree dirname (ViewWire.repo) — paired
// with `org` the way the header's `org/targetRepo` meta chip is, since a
// history row that is meant to read like "org/repo @ branch" would be
// useless with a bare worktree directory name instead. See serve's report
// for this call-out; the contract names the field "repo" without picking
// which ApprovalView field it echoes.
//
// `ticket` is an ADDITIVE extension beyond the contract's literal field
// list (id/decision/channel/decidedAt/title/org/repo/branch/shortSha/prUrl):
// the idle state (§3.4) is required to show a "workspace/ticket label", but
// Pending is null while idle and the wire protocol's own Outcome carries no
// ticket — ViewWire.ticket is the ONLY place a ticket ever appears on the
// wire, and it only exists attached to a Pending. Carrying it into the
// history ring is the sole way serve can show a best-effort ticket label on
// an idle page that has already seen at least one publish this session (a
// truly fresh boot still shows no ticket, honestly, since none has been
// observed yet). Nothing REQUIRED is removed or changed by this addition.
export interface OutcomeSummary {
  id: string;
  decision: "approved" | "declined" | "canceled";
  channel: "tty" | "socket";
  decidedAt: number;
  title: string;
  org: string;
  repo: string;
  branch: string;
  shortSha: string;
  prUrl: string | null;
  ticket: string | null;
}
