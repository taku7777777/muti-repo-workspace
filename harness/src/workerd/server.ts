/**
 * workerd/server.ts — the worker daemon's unix-socket listener.
 *
 * A near-verbatim clone of broker/src/server.ts (the proven F5 pattern):
 *   - one newline-terminated JSON request per connection; EXACTLY ONE dispatch
 *     per connection (a `dispatched` guard);
 *   - SERIAL by construction: `busy` is held until the entire handler (SDK
 *     step + deterministic commit) completes; a second connection while busy
 *     is answered `busy` immediately;
 *   - split timeouts: the socket read timeout bounds ONLY the pre-request
 *     read; once dispatched, a SEPARATE per-op budget wired to an
 *     AbortController cancels the running SDK step and replies `timeout`;
 *   - a dropped client aborts any in-flight step (never keep editing for a
 *     peer that gave up).
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { encodeWorkerResponse, MAX_REQUEST_BYTES } from "./protocol.js";
import type { WorkerResponse } from "./protocol.js";

type Handler = (raw: unknown, signal: AbortSignal) => Promise<WorkerResponse>;

const READ_TIMEOUT_MS = 30 * 1000; // bounds ONLY waiting for the request bytes

export function startWorkerServer(
  socketPath: string,
  handler: Handler,
  stepBudgetMs: number,
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
          encodeWorkerResponse({ ok: false, code: "busy", error: "workerd is handling another step" }),
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

    const reply = (res: WorkerResponse): void => {
      if (replied) return;
      replied = true;
      try {
        sock.write(encodeWorkerResponse(res));
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
    sock.setTimeout(READ_TIMEOUT_MS, () => {
      if (dispatched) return;
      reply({ ok: false, code: "invalid_request", error: "timed out waiting for request" });
      release();
      sock.destroy();
    });

    const dispatch = async (line: string): Promise<void> => {
      dispatched = true;
      sock.setTimeout(0); // clear the pre-request read timeout

      // Per-op budget: on expiry, abort the running SDK step and reply timeout.
      // The post-step path (commit) is synchronous, so an abort can only land
      // while the SDK session is running — never between commit and reply.
      if (stepBudgetMs > 0) {
        budgetTimer = setTimeout(() => {
          ac.abort();
          reply({ ok: false, code: "timeout", error: "step budget exceeded — aborted" });
        }, stepBudgetMs);
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
        // A thrown handler is still fail-CLOSED: report, do not pretend success.
        reply({ ok: false, code: "internal", error: `workerd error: ${(e as Error).message}` });
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
      // Client dropped: abort any in-flight step so we never keep editing for a
      // peer that has given up. After normal completion this abort is a no-op.
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
    // World-writable so the orchestrator container's user can connect() across
    // the shared named volume. The socket authorizes nothing on its own —
    // every request is re-validated daemon-side.
    try {
      fs.chmodSync(socketPath, 0o666);
    } catch {
      /* best effort */
    }
  });

  return server;
}
