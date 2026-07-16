/**
 * test/approval-server.test.ts — approval-server.ts's framing/guards over a
 * REAL tmpdir unix socket (no mocked net module): one request per
 * connection, oversize rejection, malformed JSON, unknown op, and that a
 * successful op actually mutates the SAME ApprovalHub the caller holds (so
 * decide() sees it). Mirrors server.ts's own guard shapes; see gate.test.ts
 * for the exhaustive ApprovalHub state-machine coverage — this file is
 * about the wire/socket layer specifically. Run: `npm test`.
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { startApprovalServer } from "../src/approval-server.js";
import { ApprovalHub } from "../src/gate.js";
import type { TtyApprover } from "../src/gate.js";
import type { PendingWire, ViewWire } from "../src/approval-types.js";

const HEAD_SHA = "abc123def456abc123def456abc123def456abc1";
const BASE_VIEW: ViewWire = {
  repo: "app",
  branch: "codex/T-1",
  headSha: HEAD_SHA,
  title: "Some PR",
  body: "some body",
  host: "github.com",
  org: "acme",
  targetRepo: "app",
  url: "https://github.com/acme/app.git",
  commitCount: 1,
  commitList: "abc123d some commit",
  diffStat: "1 file changed",
  diff: "diff --git a/x b/x",
  reviewerVerdict: null,
  testCaveat: false,
  shortSha: HEAD_SHA.slice(0, 12),
  ticket: "T-1",
};

// Never settles on its own — every test here drives decisions through the
// socket, not the TTY side.
const hangingTty: TtyApprover = (_view, signal) =>
  new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("tty aborted")), { once: true });
  });

function tmpSocketPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-approval-"));
  return path.join(dir, "a.sock");
}

/** Send a raw (already newline-framed-or-not) payload, resolve with the
 *  first newline-terminated response line, or reject on error/timeout. A
 *  bare test client — no framing conveniences the server itself doesn't
 *  already provide. */
function send(socketPath: string, raw: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    let buf = "";
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error("test client timed out waiting for a response"));
    }, 2000);
    sock.setEncoding("utf8");
    // Half-close our write side right after sending: this is what makes the
    // "no trailing newline" case reach the server's `sock.on("end", …)`
    // fallback dispatch at all (without a FIN, the server has no way to know
    // the client is done writing and would just wait for more bytes). For
    // requests that already end in "\n" this is a harmless no-op — the
    // server dispatches on the newline before it ever observes our end().
    sock.on("connect", () => {
      sock.write(raw);
      sock.end();
    });
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        sock.end();
        resolve(buf.slice(0, nl));
      }
    });
    sock.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function sendJson(socketPath: string, obj: unknown): Promise<Record<string, unknown>> {
  const line = await send(socketPath, JSON.stringify(obj) + "\n");
  return JSON.parse(line);
}

test("status with no pending publish returns the fail-closed empty shape", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const res = await sendJson(socketPath, { op: "status" });
    assert.deepEqual(res, { ok: true, protocol: 1, pending: null, last: null });
  } finally {
    server.close();
  }
});

test("status known=<current id> returns 'unchanged'; a different known returns the full view", async () => {
  const hub = new ApprovalHub();
  const decidePromise = hub.decide(BASE_VIEW, undefined, hangingTty);
  const id = (hub.status().pending as PendingWire).id;

  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const unchanged = await sendJson(socketPath, { op: "status", known: id });
    assert.deepEqual(unchanged, { ok: true, protocol: 1, pending: "unchanged", last: null });

    const full = await sendJson(socketPath, { op: "status", known: "not-the-id" });
    assert.equal(full.ok, true);
    assert.equal((full.pending as PendingWire).id, id);
    assert.equal((full.pending as PendingWire).view.shortSha, BASE_VIEW.shortSha);
  } finally {
    hub.submitDecline(id);
    await decidePromise;
    server.close();
  }
});

test("approve over the socket with the correct sha resolves the SAME hub's decide()", async () => {
  const hub = new ApprovalHub();
  const decidePromise = hub.decide(BASE_VIEW, undefined, hangingTty);
  const id = (hub.status().pending as PendingWire).id;

  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const res = await sendJson(socketPath, { op: "approve", id, sha: BASE_VIEW.shortSha });
    assert.deepEqual(res, { ok: true, result: "approved" });
    const result = await decidePromise;
    assert.deepEqual(result, { approved: true, channel: "socket" });
  } finally {
    server.close();
  }
});

test("decline over the socket resolves the SAME hub's decide()", async () => {
  const hub = new ApprovalHub();
  const decidePromise = hub.decide(BASE_VIEW, undefined, hangingTty);
  const id = (hub.status().pending as PendingWire).id;

  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const res = await sendJson(socketPath, { op: "decline", id });
    assert.deepEqual(res, { ok: true, result: "declined" });
    const result = await decidePromise;
    assert.deepEqual(result, { approved: false, channel: "socket" });
  } finally {
    server.close();
  }
});

test("malformed JSON is rejected fail-closed as invalid_request", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const res = await send(socketPath, "{not json\n");
    const parsed = JSON.parse(res);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "invalid_request");
  } finally {
    server.close();
  }
});

test("an unknown op is rejected fail-closed as invalid_request", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const res = await sendJson(socketPath, { op: "nuke", id: "x" });
    assert.equal(res.ok, false);
    assert.equal(res.code, "invalid_request");
  } finally {
    server.close();
  }
});

test("a request over the 4096-byte cap is rejected as too large", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    const oversized = JSON.stringify({ op: "decline", id: "x".repeat(5000) }) + "\n";
    const res = await send(socketPath, oversized);
    const parsed = JSON.parse(res);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.code, "invalid_request");
    assert.match(parsed.error, /too large/);
  } finally {
    server.close();
  }
});

test("a request with no trailing newline is still dispatched once the connection ends", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    // send() already calls sock.end() implicitly via the connection closing
    // after the server replies+ends, but here we want to prove the SERVER
    // reacts to end() when no newline was ever sent — write without "\n".
    const res = await send(socketPath, JSON.stringify({ op: "status" }));
    const parsed = JSON.parse(res);
    assert.deepEqual(parsed, { ok: true, protocol: 1, pending: null, last: null });
  } finally {
    server.close();
  }
});

test("exactly one request line is dispatched per connection", async () => {
  const hub = new ApprovalHub();
  const decidePromise = hub.decide(BASE_VIEW, undefined, hangingTty);
  const id = (hub.status().pending as PendingWire).id;

  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    // Two wrong-sha approve attempts written to the wire in ONE payload. If
    // the server dispatched both, attemptsLeft would drop by 2; the
    // `dispatched` guard means only the first line is ever read.
    const line1 = JSON.stringify({ op: "approve", id, sha: "wrong-1" }) + "\n";
    const line2 = JSON.stringify({ op: "approve", id, sha: "wrong-2" }) + "\n";
    const res = await send(socketPath, line1 + line2);
    const parsed = JSON.parse(res);
    assert.deepEqual(parsed, { ok: false, code: "sha_mismatch", attemptsLeft: 2 });

    const status = hub.status();
    assert.equal((status.pending as PendingWire).attemptsLeft, 2);
  } finally {
    hub.submitDecline(id);
    await decidePromise;
    server.close();
  }
});

test("the socket is chmod 0666 (world-writable, authorizes nothing on its own)", async () => {
  const hub = new ApprovalHub();
  const socketPath = tmpSocketPath();
  const server = startApprovalServer(socketPath, hub);
  try {
    // Give the listen callback (where chmod runs) a tick to fire.
    await new Promise((resolve) => server.once("listening", resolve));
    const mode = fs.statSync(socketPath).mode & 0o777;
    assert.equal(mode, 0o666);
  } finally {
    server.close();
  }
});
