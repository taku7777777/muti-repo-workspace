/**
 * gate.ts — ApprovalHub: the single in-process source of truth for "what
 * publish is pending, and who decided it" (docs/mrw-cli.md "Thread B").
 *
 * decide() is the ONLY entry point handler.ts calls. It registers one
 * pending approval, starts the TTY approver (default: the existing
 * approveAtBroker, unchanged) under a CHILD abort controller, and races it
 * against socket decisions submitted via submitApprove()/submitDecline().
 * First decision wins; the loser is abandoned (the TTY prompt is aborted so
 * it stops blocking on stdin). This preserves the pre-Thread-B behavior
 * exactly when nothing ever calls submitApprove/submitDecline (e.g.
 * BROKER_APPROVAL_SOCKET unset, so approval-server.ts is never started):
 * the socket side of the race simply never settles, and TTY always "wins".
 *
 * Node 18 has no AbortSignal.any() (that needs >=20.3), so the external
 * `signal` (server.ts's approval budget / dropped-client abort) is chained
 * into the TTY's child controller BY HAND, and separately raced directly so
 * an external abort ALWAYS rejects decide() — even if a socket submission is
 * landing at the same instant — preserving handler.ts's existing `canceled`
 * semantics (fail closed: a request whose budget expired or whose client
 * dropped must never be read as "approved" just because a browser click
 * happened to arrive in the same tick).
 *
 * One hub per broker process. server.ts's `busy` flag already serializes
 * publish requests, so at most one decide() call is ever in flight — but
 * submitApprove/submitDecline/status can arrive concurrently from separate
 * approval-socket connections (serve polls /api/state while a human is
 * mid-type). Every method here is synchronous (no `await` inside), so
 * within one call there is no interleaving; Node's run-to-completion model
 * guarantees decide()'s own continuation (which clears `pending`) runs
 * before the next queued socket connection's callback, so a resolved
 * pending cannot be "decided" twice.
 */
import * as crypto from "node:crypto";
import { approveAtBroker } from "./approve.js";
import type { ApprovalView } from "./approve.js";
import type {
  ApprovalApproveResponse,
  ApprovalChannel,
  ApprovalDecision,
  ApprovalDeclineResponse,
  OutcomeWire,
  PendingWire,
  PublishOutcome,
  ViewWire,
} from "./approval-types.js";

const ATTEMPTS_INIT = 3;

export type TtyApprover = (view: ApprovalView, signal: AbortSignal) => Promise<boolean>;

export interface DecideResult {
  approved: boolean;
  channel: ApprovalChannel;
}

interface PendingState {
  id: string;
  startedAt: number;
  attemptsLeft: number;
  view: ViewWire;
  resolveSocket: (approved: boolean) => void;
  // Set the instant a socket op decides this pending, synchronously — BEFORE
  // decide()'s own continuation has a chance to clear `pending` (that only
  // happens on the next microtask). Without this, two submitApprove calls
  // arriving back-to-back could both see the same live pending and both try
  // to resolve it; resolveSocket() itself is idempotent (native Promise
  // semantics) but this flag also makes the SECOND caller observe a clean
  // "no_pending" instead of silently doing nothing.
  resolved: boolean;
}

export class ApprovalHub {
  private pending: PendingState | null = null;
  private last: OutcomeWire | null = null;

  status(known?: string): { pending: PendingWire | "unchanged" | null; last: OutcomeWire | null } {
    if (!this.pending) return { pending: null, last: this.last };
    if (known !== undefined && known === this.pending.id) {
      return { pending: "unchanged", last: this.last };
    }
    const { id, startedAt, attemptsLeft, view } = this.pending;
    return { pending: { id, startedAt, attemptsLeft, view }, last: this.last };
  }

  submitApprove(id: string, sha: string): ApprovalApproveResponse {
    if (!this.pending || this.pending.resolved) return { ok: false, code: "no_pending" };
    if (this.pending.id !== id) return { ok: false, code: "stale" };
    // The submitted sha is used for NOTHING besides this comparison — it is
    // never pushed, logged as a target, or otherwise trusted; the actual
    // push (handler.ts step 10) always uses the broker's own shaBefore.
    if (sha.trim() === this.pending.view.shortSha) {
      this.resolve(true);
      return { ok: true, result: "approved" };
    }
    this.pending.attemptsLeft -= 1;
    if (this.pending.attemptsLeft <= 0) {
      this.resolve(false);
      return { ok: true, result: "declined", code: "attempts_exhausted" };
    }
    return { ok: false, code: "sha_mismatch", attemptsLeft: this.pending.attemptsLeft };
  }

  submitDecline(id: string): ApprovalDeclineResponse {
    if (!this.pending || this.pending.resolved) return { ok: false, code: "no_pending" };
    if (this.pending.id !== id) return { ok: false, code: "stale" };
    this.resolve(false);
    return { ok: true, result: "declined" };
  }

  /**
   * Attaches the push/PR result to the LAST recorded outcome. handler.ts
   * calls this on every post-approval terminal path (F6 re-validation
   * failures, sha_changed, push_failed, pr_failed, success) so serve's
   * "pushing…" state (spec 3.4) always resolves to a concrete result. A
   * no-op if `last` isn't an approved decision: defensive only — handler.ts
   * never calls this except after decide() resolved {approved:true}, and
   * server.ts's `busy` flag means no other decide() can have overwritten
   * `last` in between (publish requests are fully serialized).
   */
  reportOutcome(result: PublishOutcome): void {
    if (this.last && this.last.decision === "approved") this.last.publish = result;
  }

  private resolve(approved: boolean): void {
    if (!this.pending || this.pending.resolved) return;
    this.pending.resolved = true;
    this.pending.resolveSocket(approved);
  }

  private log(decision: ApprovalDecision, channel: ApprovalChannel, id: string): void {
    console.log(`[broker] approval: ${decision} via ${channel} (id=${id})`);
  }

  async decide(
    view: ViewWire,
    signal?: AbortSignal,
    ttyApprover: TtyApprover = approveAtBroker,
  ): Promise<DecideResult> {
    const id = crypto.randomBytes(16).toString("hex");

    let resolveSocket!: (approved: boolean) => void;
    const socketDecision = new Promise<boolean>((res) => {
      resolveSocket = res;
    });

    const entry: PendingState = {
      id,
      startedAt: Date.now(),
      attemptsLeft: ATTEMPTS_INIT,
      view,
      resolveSocket,
      resolved: false,
    };
    this.pending = entry;

    // Child controller for the TTY prompt only. Chained BY HAND from the
    // external `signal` (no AbortSignal.any on Node 18): an external abort
    // must stop the TTY prompt too, and a socket decision winning the race
    // aborts ONLY this controller (never the caller's own `signal`).
    const ttyAc = new AbortController();
    if (signal) {
      if (signal.aborted) ttyAc.abort();
      else signal.addEventListener("abort", () => ttyAc.abort(), { once: true });
    }

    type Settled = { channel: ApprovalChannel; approved: boolean };

    const ttySettled: Promise<Settled> = ttyApprover(view, ttyAc.signal).then((approved) => ({
      channel: "tty" as const,
      approved,
    }));
    // When the socket wins, we deliberately abort ttyAc below, which makes
    // approveAtBroker's pending rl.question() reject. Promise.race already
    // attaches its own handler to ttySettled (so that rejection alone would
    // not print an "unhandled rejection" warning), but attach an explicit
    // no-op catch too so the intent — "the loser's eventual rejection is
    // expected and ignored" — is visible in the code, not just implied by
    // Promise.race's internals.
    ttySettled.catch(() => {});

    const socketSettled: Promise<Settled> = socketDecision.then((approved) => ({
      channel: "socket" as const,
      approved,
    }));

    // A `signal` abort (approval budget / dropped client) must ALWAYS
    // reject decide(), even if a socket submission resolves at the same
    // instant — fail closed, never let an in-flight browser click sneak an
    // approval through past an expired budget or a client that gave up.
    const externalAbort: Promise<never> = new Promise((_, reject) => {
      if (!signal) return; // no external signal => this promise never settles
      const onAbort = () => reject(new Error("approval aborted externally"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });

    let winner: Settled;
    try {
      winner = await Promise.race([externalAbort, ttySettled, socketSettled]);
    } catch (e) {
      // External abort (or, in principle, a genuine TTY error unrelated to
      // any abort — the pre-Thread-B handler already collapsed both into
      // "canceled", so we keep that exact posture here). Clear pending so a
      // late socket submission for this id sees no_pending, stop the TTY
      // prompt, and record the outcome before rejecting.
      this.pending = null;
      ttyAc.abort();
      // Outcome channel: neither "tty" nor "socket" truly decided a
      // cancellation — it is recorded as "tty" here only because the wire
      // protocol's Outcome.channel has no third value and the TTY side is
      // the one actually being torn down. See the handoff notes for why
      // this is flagged as a judgment call rather than a spec-pinned value.
      this.last = { id, decision: "canceled", channel: "tty", decidedAt: Date.now(), publish: null };
      this.log("canceled", "tty", id);
      throw e;
    }

    this.pending = null;
    if (winner.channel === "socket") {
      ttyAc.abort();
      console.log(
        `[broker] decision received via browser approval: ${winner.approved ? "approved" : "declined"}`,
      );
    }
    const decision: ApprovalDecision = winner.approved ? "approved" : "declined";
    this.last = { id, decision, channel: winner.channel, decidedAt: Date.now(), publish: null };
    this.log(decision, winner.channel, id);
    return { approved: winner.approved, channel: winner.channel };
  }
}
