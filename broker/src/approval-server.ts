/**
 * approval-server.ts — the unix-socket JSON-line server for the browser
 * approval channel (BROKER_APPROVAL_SOCKET, docs/mrw-cli.md "Thread B").
 * Mirrors server.ts's framing and startup guards exactly (mkdir the parent,
 * remove a stale socket file, chmod 0666 after listen, ONE newline-
 * terminated JSON request dispatched per connection via a `dispatched`
 * guard) — but is deliberately simpler in one respect: there is no `busy`
 * flag here. status()/submitApprove()/submitDecline() on ApprovalHub are
 * synchronous state transitions (no `await` inside), so concurrent
 * connections cannot interleave mid-operation, and serve is expected to
 * poll /api/state continuously while a human is mid-decision on another
 * connection — serializing connections the way server.ts does for the
 * (long-running, single-flight) publish flow would only add needless
 * latency here.
 *
 * The socket AUTHORIZES NOTHING (chmod 0666, like publish.sock): a caged
 * process reaching this socket could ask a question, but every answer comes
 * from the hub's own in-process state, and the CRITICAL invariant (see the
 * compose wiring, Thread B §0) is that this volume is mounted ONLY in
 * broker and serve — never worker/orchestrator/reviewer.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { ApprovalRequestSchema, encodeApprovalResponse } from "./approval-types.js";
import type { ApprovalResponse } from "./approval-types.js";
import type { ApprovalHub } from "./gate.js";

const MAX_REQUEST_BYTES = 4096; // generous for {op,id,sha,known} — never a diff
const READ_TIMEOUT_MS = 10 * 1000; // bounds ONLY waiting for the request bytes

// macOS's sun_path is 104 bytes and the kernel SILENTLY TRUNCATES longer
// paths at bind() (no ENAMETOOLONG) — the socket lands at a 104-byte prefix
// path, later binds collide there as a baffling EADDRINUSE, and the rm/chmod
// below operate on the full-length name that was never created. Hit live
// during Thread B verification with a long host-side path. Fail VISIBLY
// instead: the operator chose this path (BROKER_APPROVAL_SOCKET), so a path
// the kernel cannot actually bind is a configuration error. 103 = limit
// minus the NUL terminator.
const MAX_UNIX_PATH_BYTES = 103;

export function startApprovalServer(socketPath: string, hub: ApprovalHub): net.Server {
  if (Buffer.byteLength(socketPath) > MAX_UNIX_PATH_BYTES) {
    throw new Error(
      `approval socket path is ${Buffer.byteLength(socketPath)} bytes — over the ` +
        `${MAX_UNIX_PATH_BYTES}-byte unix-socket limit (macOS would silently truncate it); ` +
        `choose a shorter BROKER_APPROVAL_SOCKET`,
    );
  }
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  try {
    fs.rmSync(socketPath, { force: true });
  } catch {
    /* ignore: stale socket from a previous run, or never existed */
  }

  const server = net.createServer((sock) => {
    let buf = "";
    let dispatched = false; // exactly one request line per connection
    let replied = false;

    const reply = (res: ApprovalResponse): void => {
      if (replied) return;
      replied = true;
      try {
        sock.write(encodeApprovalResponse(res));
      } catch {
        /* peer gone */
      }
      sock.end();
    };

    sock.setEncoding("utf8");
    // Pre-request read timeout ONLY, exactly as server.ts: fires only if no
    // full request line arrived within the budget.
    sock.setTimeout(READ_TIMEOUT_MS, () => {
      if (dispatched) return;
      reply({ ok: false, code: "invalid_request", error: "timed out waiting for request" });
      sock.destroy();
    });

    const dispatch = (line: string): void => {
      dispatched = true;
      sock.setTimeout(0); // clear the pre-request read timeout

      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch (e) {
        reply({ ok: false, code: "invalid_request", error: `malformed JSON: ${(e as Error).message}` });
        return;
      }

      const parsed = ApprovalRequestSchema.safeParse(raw);
      if (!parsed.success) {
        reply({ ok: false, code: "invalid_request", error: `request did not validate: ${parsed.error.message}` });
        return;
      }

      // Every op is a synchronous, fail-closed hub state transition — see
      // gate.ts. A thrown hub call still gets an explicit reply rather than
      // a hung connection (fail-closed posture, matching server.ts's own
      // "a thrown handler is still fail-CLOSED" comment).
      try {
        const req = parsed.data;
        if (req.op === "status") {
          const s = hub.status(req.known);
          reply({ ok: true, protocol: 1, pending: s.pending, last: s.last });
        } else if (req.op === "approve") {
          reply(hub.submitApprove(req.id, req.sha));
        } else {
          reply(hub.submitDecline(req.id));
        }
      } catch (e) {
        reply({ ok: false, code: "invalid_request", error: `broker error: ${(e as Error).message}` });
      }
    };

    sock.on("data", (chunk: string) => {
      if (dispatched) return; // stop reading after the first line
      buf += chunk;
      if (buf.length > MAX_REQUEST_BYTES) {
        reply({ ok: false, code: "invalid_request", error: "request too large" });
        sock.destroy();
        return;
      }
      const nl = buf.indexOf("\n");
      if (nl >= 0) dispatch(buf.slice(0, nl));
    });

    sock.on("end", () => {
      if (!dispatched && buf.length > 0) dispatch(buf);
    });

    sock.on("error", () => {
      /* peer dropped mid-request; nothing to release (no busy flag here) */
    });
  });

  server.listen(socketPath, () => {
    // World-writable so a container user across the shared volume can
    // connect() — same posture as publish.sock: the socket authorizes
    // nothing on its own, every request is re-validated against hub state.
    try {
      fs.chmodSync(socketPath, 0o666);
    } catch {
      /* best effort */
    }
  });

  return server;
}
