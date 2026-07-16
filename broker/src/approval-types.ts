/**
 * approval-types.ts — the wire contract for the approval socket
 * (BROKER_APPROVAL_SOCKET), spoken between the broker and `mrw serve`
 * (docs/mrw-cli.md "Thread B"). Mirrors types.ts's shape (zod-validated
 * requests in, a stable JSON-line response out) but is a SEPARATE schema on
 * purpose: types.ts is the coder<->broker publish contract and must stay
 * untouched; this file is the serve<->broker approval contract. Keeping
 * types.ts frozen means nothing here can accidentally widen what a caged
 * coder can send.
 *
 * Framing (approval-server.ts): one newline-terminated JSON request per
 * connection, one newline-terminated JSON response, socket closes. The
 * socket itself authorizes nothing (chmod 0666, like publish.sock) — every
 * op is re-verified against the broker's own in-process ApprovalHub state
 * (gate.ts), never trusted from the wire.
 */
import { z } from "zod";
import type { ApprovalView } from "./approve.js";

// --- requests (serve -> broker) --------------------------------------------

export const ApprovalStatusRequestSchema = z
  .object({ op: z.literal("status"), known: z.string().optional() })
  .strict();

export const ApprovalApproveRequestSchema = z
  .object({ op: z.literal("approve"), id: z.string(), sha: z.string() })
  .strict();

export const ApprovalDeclineRequestSchema = z
  .object({ op: z.literal("decline"), id: z.string() })
  .strict();

export const ApprovalRequestSchema = z.union([
  ApprovalStatusRequestSchema,
  ApprovalApproveRequestSchema,
  ApprovalDeclineRequestSchema,
]);

export type ApprovalStatusRequest = z.infer<typeof ApprovalStatusRequestSchema>;
export type ApprovalApproveRequest = z.infer<typeof ApprovalApproveRequestSchema>;
export type ApprovalDeclineRequest = z.infer<typeof ApprovalDeclineRequestSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;

// --- shared vocabulary -------------------------------------------------------

export type ApprovalChannel = "tty" | "socket";
export type ApprovalDecision = "approved" | "declined" | "canceled";

// Every field of the broker's ApprovalView (approve.ts), PLUS the two fields
// only the wire protocol needs: shortSha (so serve/the page never has to
// re-derive the sha-typed gate's exact comparison string) and ticket (so the
// page can show a ticket chip). All strings are RAW here — serve, not the
// broker, is responsible for HTML-escaping before it reaches a browser.
export type ViewWire = ApprovalView & { shortSha: string; ticket: string | null };

export interface PendingWire {
  id: string; // 32 hex chars — crypto.randomBytes(16).toString("hex")
  startedAt: number; // ms epoch
  attemptsLeft: number;
  view: ViewWire;
}

// `publish` is filled in ONLY after the handler's post-approval push/PR
// attempt completes (hub.reportOutcome) — it stays null for the entire
// window between "approved" and "pushed", which is exactly the "pushing…"
// state serve renders (spec 3.4). It is never filled for declined/canceled.
export type PublishOutcome = { ok: true; prUrl: string | null } | { ok: false; error: string };

export interface OutcomeWire {
  id: string;
  decision: ApprovalDecision;
  channel: ApprovalChannel;
  decidedAt: number;
  publish: PublishOutcome | null;
}

// --- responses (broker -> serve) --------------------------------------------

export type ApprovalStatusResponse = {
  ok: true;
  protocol: 1;
  pending: PendingWire | "unchanged" | null;
  last: OutcomeWire | null;
};

export type ApprovalApproveResponse =
  | { ok: true; result: "approved" }
  | { ok: true; result: "declined"; code: "attempts_exhausted" }
  | { ok: false; code: "no_pending" | "stale" }
  | { ok: false; code: "sha_mismatch"; attemptsLeft: number };

export type ApprovalDeclineResponse =
  | { ok: true; result: "declined" }
  | { ok: false; code: "no_pending" | "stale" };

export type ApprovalErrorResponse = { ok: false; code: "invalid_request"; error: string };

export type ApprovalResponse =
  | ApprovalStatusResponse
  | ApprovalApproveResponse
  | ApprovalDeclineResponse
  | ApprovalErrorResponse;

export function encodeApprovalResponse(res: ApprovalResponse): string {
  return JSON.stringify(res) + "\n";
}
