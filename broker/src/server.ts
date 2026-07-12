/**
 * server.ts — the UNIX socket listener (F5).
 *
 * Framing: one newline-terminated JSON request per connection; EXACTLY ONE request
 * line is dispatched per connection (a `dispatched` guard), after which we stop
 * reading — a malicious client cannot trigger the handler twice.
 *
 * SERIAL by construction: `busy` is held until the ENTIRE handler (validation, the
 * human gate, AND the push) completes. A second connection while busy is answered
 * `busy` IMMEDIATELY and closed.
 *
 * Timeouts are split: the SOCKET read timeout bounds ONLY the pre-request read (how
 * long we wait for the request bytes). Once dispatched it is cleared; the human
 * approval gate is instead bounded by a SEPARATE, longer budget wired to an
 * AbortController that CANCELS the pending approval and aborts the handler — so the
 * broker NEVER pushes after having replied failure (the post-approval path is
 * synchronous, so an abort can only land during the interactive wait).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeResponse } from "./types.js";
import type { PublishResponse } from "./types.js";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<PublishResponse>;

const MAX_REQUEST_BYTES = 256 * 1024; // generous for {repo,branch,title,body}
const READ_TIMEOUT_MS = 30 * 1000; // bounds ONLY waiting for the request bytes

export function startServer(
  socketPath: string,
  handler: Handler,
  approvalBudgetMs: number,
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
        sock.write(encodeResponse({ ok: false, code: "busy", error: "broker is handling another request" }));
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
    let gateTimer: NodeJS.Timeout | undefined;

    const reply = (res: PublishResponse): void => {
      if (replied) return;
      replied = true;
      try {
        sock.write(encodeResponse(res));
      } catch {
        /* peer gone */
      }
      sock.end();
    };

    const release = (): void => {
      if (gateTimer) clearTimeout(gateTimer);
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

      // Separate, longer budget for the human gate: on expiry, abort the pending
      // approval AND reply failure. The handler's post-approval path is synchronous,
      // so it cannot push after this failure reply.
      if (approvalBudgetMs > 0) {
        gateTimer = setTimeout(() => {
          ac.abort();
          reply({ ok: false, code: "canceled", error: "approval budget exceeded" });
        }, approvalBudgetMs);
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
        // A thrown handler is still fail-CLOSED: report, do not publish.
        reply({ ok: false, code: "push_failed", error: `broker error: ${(e as Error).message}` });
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
      // Client dropped (error or close): abort any pending approval so we NEVER push
      // for a peer that has given up. After normal completion this abort is a no-op.
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
    // World-writable so a container user across the shared volume can connect().
    // The socket authorizes nothing on its own — every request is re-validated and
    // human-gated.
    try {
      fs.chmodSync(socketPath, 0o666);
    } catch {
      /* best effort */
    }
  });

  return server;
}
