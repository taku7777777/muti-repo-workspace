/**
 * server.ts — the reviewer's unix-socket listener.
 *
 * A clone of broker/src/server.ts's proven F5 pattern (harness/src/workerd/
 * server.ts is the earlier clone, for the worker daemon — this is the same
 * shape a third time, generic over ReviewerResponse instead of
 * PublishResponse/WorkerResponse):
 *   - one newline-terminated JSON request per connection; EXACTLY ONE
 *     request line is dispatched per connection (a `dispatched` guard);
 *   - SERIAL by construction: `busy` is held until the ENTIRE handler (diff
 *     resolution + the SDK session) completes; a second connection while
 *     busy is answered `busy` IMMEDIATELY and closed;
 *   - split timeouts: the socket read timeout bounds ONLY the pre-request
 *     read; once dispatched it is cleared, and a SEPARATE per-request budget
 *     (REVIEWER_SESSION_TIMEOUT_MS) is wired to an AbortController that
 *     cancels the running SDK session and replies `timeout`;
 *   - a dropped client aborts any in-flight session (never keep spending
 *     tokens reviewing for a peer that gave up).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeReviewerResponse, MAX_REQUEST_BYTES } from "./types.js";
import type { ReviewerResponse } from "./types.js";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<ReviewerResponse>;

const READ_TIMEOUT_MS = 30 * 1000; // bounds ONLY waiting for the request bytes

export function startReviewerServer(
  socketPath: string,
  handler: Handler,
  sessionBudgetMs: number,
): net.Server {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    /* ignore */
  }

  let busy = false;

  const server = net.createServer((sock) => {
    if (busy) {
      try {
        sock.write(
          encodeReviewerResponse({ ok: false, code: "busy", error: "reviewer is handling another request" }),
        );
      } catch {
        /* peer gone */
      }
      sock.end();
      return;
    }
    busy = true;

    let buf = "";
    let dispatched = false; // exactly one request line per connection
    let replied = false;
    const ac = new AbortController();
    let budgetTimer: NodeJS.Timeout | undefined;

    const reply = (res: ReviewerResponse): void => {
      if (replied) return;
      replied = true;
      try {
        sock.write(encodeReviewerResponse(res));
      } catch {
        /* peer gone */
      }
      sock.end();
    };

    const release = (): void => {
      if (budgetTimer) clearTimeout(budgetTimer);
      busy = false;
    };

    sock.setEncoding("utf8");
    // Pre-request read timeout ONLY. Fires only if no full request line arrived.
    sock.setTimeout(READ_TIMEOUT_MS, () => {
      if (dispatched) return;
      reply({ ok: false, code: "invalid_request", error: "timed out waiting for request" });
      release();
      sock.destroy();
    });

    const dispatch = async (line: string): Promise<void> => {
      dispatched = true;
      sock.setTimeout(0); // clear the pre-request read timeout

      // Separate, longer budget for the SDK session: on expiry, abort it AND
      // reply `timeout`. The handler's own eventual return/throw is moot
      // once this fires — `reply()` is idempotent (first reply wins), so the
      // broker never gets a late, contradictory response.
      if (sessionBudgetMs > 0) {
        budgetTimer = setTimeout(() => {
          ac.abort();
          reply({ ok: false, code: "timeout", error: "review session budget exceeded — aborted" });
        }, sessionBudgetMs);
      }

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        reply({ ok: false, code: "invalid_request", error: `malformed JSON: ${(e as Error).message}` });
        release();
        return;
      }
      try {
        const res = await handler(raw, ac.signal);
        reply(res);
      } catch (e) {
        // A thrown handler still answers with a typed, fail-visible code —
        // the broker's consult treats this exactly like any other failure
        // (null verdict), never a thrown exception on its side.
        reply({ ok: false, code: "internal", error: `reviewer error: ${(e as Error).message}` });
      } finally {
        release();
      }
    };

    sock.on("data", (chunk: string) => {
      if (dispatched) return; // stop reading after the first line
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        reply({ ok: false, code: "invalid_request", error: "request too large" });
        release();
        sock.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) void dispatch(buf.slice(0, nl));
    });

    sock.on("end", () => {
      if (!dispatched && buf.length > 0) void dispatch(buf);
    });

    const onGone = () => {
      // Client dropped (error or close): abort any in-flight session so we
      // never keep spending tokens for a peer that has given up.
      ac.abort();
      if (!dispatched) {
        replied = true;
        release();
      }
    };
    sock.on("error", onGone);
    sock.on("close", onGone);
  });

  server.listen(socketPath, () => {
    // World-writable so the broker container's user can connect() across the
    // shared named volume. The socket authorizes nothing on its own — every
    // request is re-validated reviewer-side, and the verdict it returns is
    // advisory only regardless of who connects.
    try {
      fs.chmodSync(socketPath, 0o666);
    } catch {
      /* best effort */
    }
  });

  return server;
}
