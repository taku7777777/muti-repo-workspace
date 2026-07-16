/**
 * test/gate.test.ts — ApprovalHub (gate.ts): the pending-registration/
 * decide()-race/submitApprove/submitDecline/status/reportOutcome state
 * machine, exercised with a FAKE ttyApprover (never real stdin — mirrors
 * reviewer/test/types.test.ts's "NO SDK import at all" posture: this file
 * never imports approve.ts's real readline-backed approveAtBroker). Run:
 * `npm test` (node:test, same `node --import tsx --test` invocation as
 * reviewer/).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ApprovalHub } from "../src/gate.js";
import type { TtyApprover } from "../src/gate.js";
import type { PendingWire, ViewWire } from "../src/approval-types.js";

// A ViewWire fixture. shortSha is deliberately the first 12 chars of headSha
// (as handler.ts computes it) so tests can exercise the real sha-typed
// comparison without re-deriving it inline everywhere.
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

/** A controllable stand-in for approveAtBroker. Never touches stdin: the
 *  returned promise only settles when the test calls `.approve()`, or when
 *  `signal` aborts (mirroring approveAtBroker's own abort-rejects contract
 *  exactly, so gate.ts's abort-chaining logic is exercised faithfully). */
class FakeTty {
  calls = 0;
  private resolveFn: ((approved: boolean) => void) | null = null;

  approver: TtyApprover = (_view, signal) =>
    new Promise<boolean>((resolve, reject) => {
      this.calls++;
      if (signal.aborted) {
        reject(new Error("tty aborted before prompt"));
        return;
      }
      this.resolveFn = resolve;
      signal.addEventListener("abort", () => reject(new Error("tty aborted mid-prompt")), { once: true });
    });

  approve(approved: boolean): void {
    this.resolveFn?.(approved);
  }
}

function pendingId(hub: ApprovalHub): string {
  const s = hub.status();
  assert.ok(s.pending && s.pending !== "unchanged", "expected a live pending registration");
  return (s.pending as PendingWire).id;
}

// --- submitApprove — correct sha ------------------------------------------

test("submitApprove with the correct sha resolves decide() approved via socket", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty(); // must never settle on its own — only the socket op should win
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);

  const id = pendingId(hub);
  // Leading/trailing whitespace must be trimmed — the page can't guarantee a
  // clean paste, and only the trimmed value is what a human actually typed.
  const res = hub.submitApprove(id, `  ${BASE_VIEW.shortSha}  `);
  assert.deepEqual(res, { ok: true, result: "approved" });

  const result = await decidePromise;
  assert.deepEqual(result, { approved: true, channel: "socket" });
  assert.equal(fakeTty.calls, 1);
});

// --- submitApprove — sha mismatch x3 => auto-decline -----------------------

test("three wrong-sha attempts auto-decline via socket (attempts init = 3)", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  const id = pendingId(hub);

  assert.deepEqual(hub.submitApprove(id, "wrong-1"), { ok: false, code: "sha_mismatch", attemptsLeft: 2 });
  assert.deepEqual(hub.submitApprove(id, "wrong-2"), { ok: false, code: "sha_mismatch", attemptsLeft: 1 });
  assert.deepEqual(hub.submitApprove(id, "wrong-3"), {
    ok: true,
    result: "declined",
    code: "attempts_exhausted",
  });

  const result = await decidePromise;
  assert.deepEqual(result, { approved: false, channel: "socket" });
});

// --- stale id ----------------------------------------------------------------

test("submitApprove/submitDecline with a mismatched id return stale", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  pendingId(hub); // registers the real pending; we deliberately submit a different one below

  assert.deepEqual(hub.submitApprove("0".repeat(32), BASE_VIEW.shortSha), { ok: false, code: "stale" });
  assert.deepEqual(hub.submitDecline("0".repeat(32)), { ok: false, code: "stale" });

  fakeTty.approve(true); // let the still-live pending resolve so the test cleans up
  await decidePromise;
});

// --- no_pending --------------------------------------------------------------

test("submitApprove/submitDecline with no pending publish return no_pending", () => {
  const hub = new ApprovalHub();
  assert.deepEqual(hub.submitApprove("anything", "anything"), { ok: false, code: "no_pending" });
  assert.deepEqual(hub.submitDecline("anything"), { ok: false, code: "no_pending" });
});

// --- decline op ----------------------------------------------------------------

test("submitDecline resolves decide() declined via socket", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  const id = pendingId(hub);

  assert.deepEqual(hub.submitDecline(id), { ok: true, result: "declined" });
  const result = await decidePromise;
  assert.deepEqual(result, { approved: false, channel: "socket" });
});

// --- external abort => throws + outcome canceled ----------------------------

test("an external abort rejects decide() and records a canceled outcome", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty(); // would hang forever without the abort
  const ac = new AbortController();
  const decidePromise = hub.decide(BASE_VIEW, ac.signal, fakeTty.approver);

  ac.abort();
  await assert.rejects(decidePromise);

  const status = hub.status();
  assert.equal(status.pending, null);
  assert.equal(status.last?.decision, "canceled");
});

test("an external abort wins even when a socket approval races it (fail closed)", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const ac = new AbortController();
  const decidePromise = hub.decide(BASE_VIEW, ac.signal, fakeTty.approver);
  const id = pendingId(hub);

  // Fire both "at once": the budget expiring and a browser click landing.
  // Fail-closed means the abort must win — a dropped/expired request must
  // never be read as approved just because a decision arrived in the same
  // tick.
  ac.abort();
  hub.submitApprove(id, BASE_VIEW.shortSha);

  await assert.rejects(decidePromise);
  assert.equal(hub.status().last?.decision, "canceled");
});

// --- TTY wins race => socket ops then get no_pending ------------------------

test("a TTY decision clears pending so subsequent socket ops see no_pending", async () => {
  const hub = new ApprovalHub();
  const instantApprove: TtyApprover = async () => true;
  const result = await hub.decide(BASE_VIEW, undefined, instantApprove);
  assert.deepEqual(result, { approved: true, channel: "tty" });

  assert.deepEqual(hub.submitApprove("irrelevant", BASE_VIEW.shortSha), { ok: false, code: "no_pending" });
  assert.deepEqual(hub.submitDecline("irrelevant"), { ok: false, code: "no_pending" });
});

// --- feature-off: no approval-server wired up => plain TTY -------------------

test("with no approval-server constructed, decide() behaves as plain TTY", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  // Simulates BROKER_APPROVAL_SOCKET unset: nothing ever calls
  // submitApprove/submitDecline, so only the TTY side can resolve this.
  fakeTty.approve(false);
  const result = await decidePromise;
  assert.deepEqual(result, { approved: false, channel: "tty" });
});

// --- reportOutcome -------------------------------------------------------------

test("reportOutcome attaches the publish result to the last approved outcome", async () => {
  const hub = new ApprovalHub();
  const instantApprove: TtyApprover = async () => true;
  await hub.decide(BASE_VIEW, undefined, instantApprove);

  assert.equal(hub.status().last?.publish, null);
  hub.reportOutcome({ ok: true, prUrl: "https://github.com/acme/app/pull/1" });
  assert.deepEqual(hub.status().last?.publish, { ok: true, prUrl: "https://github.com/acme/app/pull/1" });
});

test("reportOutcome is a no-op when the last outcome was not approved", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  const id = pendingId(hub);
  hub.submitDecline(id);
  await decidePromise;

  hub.reportOutcome({ ok: true, prUrl: "https://github.com/acme/app/pull/2" });
  assert.equal(hub.status().last?.publish, null);
});

// --- status(known) unchanged shortcut ------------------------------------------

test("status(known) returns 'unchanged' when known matches the live pending id, and the full view otherwise", async () => {
  const hub = new ApprovalHub();
  const fakeTty = new FakeTty();
  const decidePromise = hub.decide(BASE_VIEW, undefined, fakeTty.approver);
  const id = pendingId(hub);

  assert.equal(hub.status(id).pending, "unchanged");
  const fresh = hub.status("not-the-id");
  assert.ok(fresh.pending && fresh.pending !== "unchanged");
  assert.equal((fresh.pending as PendingWire).id, id);

  fakeTty.approve(true);
  await decidePromise;
});
