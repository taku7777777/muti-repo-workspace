/**
 * broker-client.test.ts — BrokerClient against a REAL unix-socket stub
 * broker (fake-broker.ts): request forwarding, "unchanged" expansion from
 * the in-memory pending cache, the outcome history ring, and
 * broker_unreachable on transport failure.
 */
import assert from "node:assert/strict";
import * as net from "node:net";
import * as path from "node:path";
import { test } from "node:test";
import { BrokerClient } from "../src/broker-client.js";
import { fakePending, startFakeBroker, type FakeBroker } from "./fake-broker.js";

test("status: happy path returns the full pending and caches it", async () => {
  const pending = fakePending();
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string };
    if (r.op === "status") return { ok: true, protocol: 1, pending, last: null };
    throw new Error("unexpected op");
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    const result = await client.status();
    assert.equal(result.connected, true);
    if (result.connected) {
      assert.deepEqual(result.pending, pending);
      assert.equal(result.last, null);
      assert.deepEqual(result.history, []);
    }
  } finally {
    await broker.close();
  }
});

test("status: 'unchanged' is expanded back to the full pending using the client's own cache", async () => {
  const pending = fakePending();
  let calls = 0;
  const broker = await startFakeBroker((req) => {
    calls++;
    const r = req as { op: string; known?: string };
    if (r.op === "status") {
      if (r.known === pending.id) return { ok: true, protocol: 1, pending: "unchanged", last: null };
      return { ok: true, protocol: 1, pending, last: null };
    }
    throw new Error("unexpected op");
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    const first = await client.status(); // no known -> full pending, cached
    assert.equal(first.connected, true);

    const second = await client.status(pending.id as string); // known matches -> broker says "unchanged"
    assert.equal(second.connected, true);
    if (second.connected) {
      // The CALLER (routes.ts territory) never sees the literal string —
      // BrokerClient always hands back a real object or null.
      assert.deepEqual(second.pending, pending);
    }
    assert.equal(calls, 2);
  } finally {
    await broker.close();
  }
});

test("status: cache miss on 'unchanged' forces one fresh full fetch instead of lying", async () => {
  const pending = fakePending();
  let statusCalls = 0;
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string; known?: string };
    if (r.op === "status") {
      statusCalls++;
      // The broker claims "unchanged" for an id the client has never seen —
      // simulating serve having restarted mid-pending.
      if (r.known === "some-id-the-client-never-cached") {
        return { ok: true, protocol: 1, pending: "unchanged", last: null };
      }
      return { ok: true, protocol: 1, pending, last: null };
    }
    throw new Error("unexpected op");
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    const result = await client.status("some-id-the-client-never-cached");
    assert.equal(result.connected, true);
    if (result.connected) assert.deepEqual(result.pending, pending);
    assert.equal(statusCalls, 2); // one "unchanged", one forced full refetch
  } finally {
    await broker.close();
  }
});

test("status: broker unreachable (nothing listening) returns connected:false, never throws", async () => {
  const client = new BrokerClient(path.join("/tmp", "mrw-serve-test-nonexistent", "nope.sock"));
  const result = await client.status();
  assert.equal(result.connected, false);
});

test("status: malformed broker response (fails schema) degrades to connected:false", async () => {
  const broker = await startFakeBroker(() => ({ totally: "not the right shape" }));
  try {
    const client = new BrokerClient(broker.socketPath);
    const result = await client.status();
    assert.equal(result.connected, false);
  } finally {
    await broker.close();
  }
});

test("approve: forwards {id, sha} verbatim and relays the broker's reply", async () => {
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string; id: string; sha: string };
    assert.equal(r.op, "approve");
    assert.equal(r.id, "pending-1");
    assert.equal(r.sha, "abc123");
    return { ok: true, result: "approved" };
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    const res = await client.approve("pending-1", "abc123");
    assert.deepEqual(res, { ok: true, result: "approved" });
  } finally {
    await broker.close();
  }
});

test("approve: transport failure returns {ok:false, code:'broker_unreachable'}", async () => {
  const client = new BrokerClient(path.join("/tmp", "mrw-serve-test-nonexistent", "nope.sock"));
  const res = await client.approve("x", "y");
  assert.deepEqual(res, { ok: false, code: "broker_unreachable" });
});

test("decline: forwards {id} verbatim and relays the broker's reply", async () => {
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string; id: string };
    assert.equal(r.op, "decline");
    assert.equal(r.id, "pending-2");
    return { ok: true, result: "declined" };
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    const res = await client.decline("pending-2");
    assert.deepEqual(res, { ok: true, result: "declined" });
  } finally {
    await broker.close();
  }
});

test("history: a new outcome is recorded and enriched from the cached view", async () => {
  const pending = fakePending();
  const outcome = { id: pending.id, decision: "approved", channel: "socket", decidedAt: Date.now(), publish: null };
  let returnOutcome = false;
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string };
    if (r.op === "status") {
      return returnOutcome
        ? { ok: true, protocol: 1, pending: null, last: outcome }
        : { ok: true, protocol: 1, pending, last: null };
    }
    throw new Error("unexpected op");
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    await client.status(); // caches the pending's view
    returnOutcome = true;
    const result = await client.status();
    assert.equal(result.connected, true);
    if (result.connected) {
      assert.equal(result.history.length, 1);
      const summary = result.history[0];
      assert.equal(summary.id, pending.id);
      assert.equal(summary.decision, "approved");
      const view = pending.view as Record<string, unknown>;
      assert.equal(summary.title, view.title);
      assert.equal(summary.org, view.org);
      assert.equal(summary.repo, view.targetRepo); // see wire.ts's OutcomeSummary doc comment
      assert.equal(summary.shortSha, view.shortSha);
      assert.equal(summary.ticket, view.ticket);
    }
  } finally {
    await broker.close();
  }
});

test("history: the SAME outcome id refreshes in place (e.g. publish result lands later) rather than duplicating", async () => {
  const pending = fakePending();
  let publish: unknown = null;
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string };
    if (r.op !== "status") throw new Error("unexpected op");
    return {
      ok: true,
      protocol: 1,
      pending: null,
      last: { id: pending.id, decision: "approved", channel: "socket", decidedAt: 1, publish },
    };
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    await client.status(); // first sighting: publish still null
    let result = await client.status();
    assert.equal(result.connected, true);
    if (result.connected) {
      assert.equal(result.history.length, 1);
      assert.equal(result.history[0].prUrl, null);
    }

    publish = { ok: true, prUrl: "https://github.com/acme/demo-repo/pull/1" };
    result = await client.status();
    assert.equal(result.connected, true);
    if (result.connected) {
      assert.equal(result.history.length, 1); // still one entry, refreshed not duplicated
      assert.equal(result.history[0].prUrl, "https://github.com/acme/demo-repo/pull/1");
    }
  } finally {
    await broker.close();
  }
});

test("history: caps at 20 entries, most recent first", async () => {
  let n = 0;
  const broker = await startFakeBroker((req) => {
    const r = req as { op: string };
    if (r.op !== "status") throw new Error("unexpected op");
    n++;
    return {
      ok: true,
      protocol: 1,
      pending: null,
      last: { id: `outcome-${n}`, decision: "declined", channel: "tty", decidedAt: n, publish: null },
    };
  });
  try {
    const client = new BrokerClient(broker.socketPath);
    let result;
    for (let i = 0; i < 25; i++) result = await client.status();
    assert.ok(result && result.connected);
    if (result && result.connected) {
      assert.equal(result.history.length, 20);
      assert.equal(result.history[0].id, "outcome-25"); // most recent first
      assert.equal(result.history[19].id, "outcome-6");
    }
  } finally {
    await broker.close();
  }
});

test("a single connection sends exactly one request line and the server sees only one", async () => {
  const broker: FakeBroker = await startFakeBroker(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const client = new BrokerClient(broker.socketPath);
    await client.status();
    assert.equal(broker.requests.length, 1);
  } finally {
    await broker.close();
  }
});

test("sanity: net.createConnection to a missing socket path rejects (baseline for broker_unreachable)", async () => {
  await assert.rejects(async () => {
    await new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: "/tmp/mrw-serve-test-nonexistent/definitely-not-there.sock" });
      sock.on("error", reject);
      sock.on("connect", resolve);
    });
  });
});
