/**
 * broker-client.ts — serve's ONE outbound connection: the approval socket to
 * the broker (implementation contract §1). Framing mirrors broker's own
 * outbound client, broker/src/reviewer.ts's sendToReviewer() (reimplemented
 * here, not imported — see wire.ts's header comment): one newline-terminated
 * JSON request per FRESH connection, one newline-terminated JSON response,
 * then close.
 *
 * Two pieces of state live here that are NOT part of the wire protocol:
 *
 *  - `pendingCache`: a small (≤PENDING_CACHE_LIMIT) in-memory map of
 *    id -> the last full PendingWire serve saw for that id. The broker's
 *    `status` op replies "unchanged" (a bare string) instead of resending a
 *    potentially-large `view` once `known` already matches its current
 *    pending id (§1) — that compression happens between serve and the
 *    BROKER. This client expands "unchanged" back into the full object
 *    right here using that cache, so every OTHER caller in this package
 *    (routes.ts) only ever sees a real PendingWire or null — never the
 *    string. It is then routes.ts's OWN job to decide, against the
 *    BROWSER's `known` query param, whether relaying "unchanged" to the
 *    browser is safe (see routes.ts).
 *  - `history`: serve's own memory-only ring (≤HISTORY_LIMIT) of outcomes it
 *    has observed, enriched from the SAME cache (a bare Outcome carries no
 *    title/org/repo/branch/sha — only the pending id that resolved it).
 *    Never persisted (§5 "No persistence of approval history beyond serve
 *    process memory").
 */
import * as net from "node:net";
import {
  ApproveResponseSchema,
  DeclineResponseSchema,
  StatusResponseSchema,
  approveRequest,
  declineRequest,
  statusRequest,
  type ApproveResponse,
  type DeclineResponse,
  type OutcomeSummary,
  type OutcomeWire,
  type PendingWire,
} from "./wire.js";

const CONNECT_TIMEOUT_MS = 5_000;
const RESPONSE_TIMEOUT_MS = 10_000; // matches the broker's own approval-server read budget (§1)
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024; // diffs can be large; still bounded against a runaway peer
const PENDING_CACHE_LIMIT = 20;
const HISTORY_LIMIT = 20;

export type BrokerUnreachable = { ok: false; code: "broker_unreachable" };

export type StatusResult =
  | { connected: true; pending: PendingWire | null; last: OutcomeWire | null; history: OutcomeSummary[] }
  | { connected: false };

/** One request, one response, one connection. Rejects on connect timeout,
 *  response timeout, oversize response, malformed JSON, or any socket
 *  error/early close — every rejection is treated as "broker unreachable"
 *  by every caller in this file, never surfaced as a thrown exception to
 *  routes.ts. */
function sendRequest(socketPath: string, req: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const sock = net.createConnection({ path: socketPath });

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };

    const connectTimer = setTimeout(() => {
      finish(() => reject(new Error("connect timed out")));
    }, CONNECT_TIMEOUT_MS);

    let buf = "";
    sock.setEncoding("utf8");
    sock.on("connect", () => {
      clearTimeout(connectTimer);
      sock.setTimeout(RESPONSE_TIMEOUT_MS, () => finish(() => reject(new Error("response timed out"))));
      sock.write(JSON.stringify(req) + "\n");
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > MAX_RESPONSE_BYTES) {
        finish(() => reject(new Error("broker response exceeded the size cap")));
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const parsed: unknown = JSON.parse(line);
        finish(() => resolve(parsed));
      } catch (e) {
        finish(() => reject(new Error(`malformed broker response: ${(e as Error).message}`)));
      }
    });
    sock.on("error", (err) => {
      clearTimeout(connectTimer);
      finish(() => reject(err));
    });
    sock.on("end", () => {
      clearTimeout(connectTimer);
      if (!settled) finish(() => reject(new Error("broker closed the connection without a response")));
    });
  });
}

export class BrokerClient {
  private readonly socketPath: string;
  private readonly pendingCache = new Map<string, PendingWire>();
  private readonly history: OutcomeSummary[] = [];

  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  private cachePending(p: PendingWire): void {
    if (!this.pendingCache.has(p.id) && this.pendingCache.size >= PENDING_CACHE_LIMIT) {
      const oldest = this.pendingCache.keys().next().value;
      if (oldest !== undefined) this.pendingCache.delete(oldest);
    }
    this.pendingCache.set(p.id, p);
  }

  /** repo/org/title/branch/shortSha are pulled from OutcomeSummary's own
   *  "repo" call-out — see wire.ts's OutcomeSummary doc comment for why
   *  `repo` here is ViewWire.targetRepo, not ViewWire.repo. */
  private recordOutcome(outcome: OutcomeWire): void {
    const view = this.pendingCache.get(outcome.id)?.view;
    const summary: OutcomeSummary = {
      id: outcome.id,
      decision: outcome.decision,
      channel: outcome.channel,
      decidedAt: outcome.decidedAt,
      title: view?.title ?? "",
      org: view?.org ?? "",
      repo: view?.targetRepo ?? "",
      branch: view?.branch ?? "",
      shortSha: view?.shortSha ?? "",
      prUrl: outcome.publish && outcome.publish.ok ? outcome.publish.prUrl : null,
      ticket: view?.ticket ?? null,
    };
    if (this.history.length > 0 && this.history[0].id === outcome.id) {
      // Same outcome, refreshed (e.g. the async push/PR result just landed —
      // publish flips from null to a real result on a later poll).
      this.history[0] = summary;
      return;
    }
    this.history.unshift(summary);
    if (this.history.length > HISTORY_LIMIT) this.history.length = HISTORY_LIMIT;
  }

  /**
   * `{"op":"status","known"}` (§1). ALWAYS returns a fully-expanded
   * `pending` (a real object or null) — the "unchanged" wire compression is
   * transparently undone here using `pendingCache`; see this file's header
   * comment for why that is this layer's job and not routes.ts's.
   */
  async status(known?: string): Promise<StatusResult> {
    let raw: unknown;
    try {
      raw = await sendRequest(this.socketPath, statusRequest(known));
    } catch {
      return { connected: false };
    }
    const parsed = StatusResponseSchema.safeParse(raw);
    if (!parsed.success) return { connected: false };

    const { pending, last } = parsed.data;

    let expandedPending: PendingWire | null;
    if (pending === "unchanged") {
      const cached = known !== undefined ? this.pendingCache.get(known) : undefined;
      if (cached) {
        expandedPending = cached;
      } else {
        // Cache miss (e.g. serve restarted while this pending was already in
        // flight): force one fresh, fully-expanded fetch rather than
        // returning a stale or absent view under the caller's nose.
        return this.status(undefined);
      }
    } else {
      expandedPending = pending;
      if (expandedPending) this.cachePending(expandedPending);
    }

    if (last) this.recordOutcome(last);

    return { connected: true, pending: expandedPending, last, history: [...this.history] };
  }

  /** `{"op":"approve","id","sha"}` (§1) — forwarded VERBATIM; serve makes no
   *  approval decision of its own (the sha-typed gate is the broker's,
   *  in-process, per implementation contract's top-level invariant). */
  async approve(id: string, sha: string): Promise<ApproveResponse | BrokerUnreachable> {
    let raw: unknown;
    try {
      raw = await sendRequest(this.socketPath, approveRequest(id, sha));
    } catch {
      return { ok: false, code: "broker_unreachable" };
    }
    const parsed = ApproveResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "broker_unreachable" };
    return parsed.data;
  }

  /** `{"op":"decline","id"}` (§1) — forwarded verbatim. */
  async decline(id: string): Promise<DeclineResponse | BrokerUnreachable> {
    let raw: unknown;
    try {
      raw = await sendRequest(this.socketPath, declineRequest(id));
    } catch {
      return { ok: false, code: "broker_unreachable" };
    }
    const parsed = DeclineResponseSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, code: "broker_unreachable" };
    return parsed.data;
  }
}
