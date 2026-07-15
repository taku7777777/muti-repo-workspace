/**
 * test/ledger.test.ts — spine/ledger.ts transitions, exercised with NO SDK
 * import at all (SpineLedger is pure state + fs). Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SpineLedger } from "../src/spine/ledger.js";
import type { Plan, Review } from "../src/types.js";

const PLAN: Plan = { summary: "do the thing", steps: ["step 1"], risks: [], ready_to_implement: true };
const APPROVE: Review = { verdict: "approve", findings: [], summary: "looks good" };
const REQUEST_CHANGES: Review = {
  verdict: "request_changes",
  findings: [{ severity: "blocker", detail: "nope" }],
  summary: "not yet",
};

function freshLedger(budgets?: { maxActions?: number; maxWorkerRuns?: number }) {
  return new SpineLedger(
    "T-1",
    { app: { repoDir: "/tmp/app", baseSha: "base000" } },
    budgets,
    fs.mkdtempSync(path.join(os.tmpdir(), "spine-ledger-test-")),
  );
}

test("canPublish is blocked before any test/review is recorded", () => {
  const ledger = freshLedger();
  const gate = ledger.canPublish("app");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no plan recorded/);
});

test("canPublish is blocked when tests are green but no review is recorded", () => {
  const ledger = freshLedger();
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, "base000");
  const gate = ledger.canPublish("app");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no approving review/);
});

test("canPublish is blocked when review approved but tests never ran", () => {
  const ledger = freshLedger();
  ledger.recordPlan("app", PLAN);
  ledger.recordReview("app", APPROVE, "base000");
  const gate = ledger.canPublish("app");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no green test run/);
});

test("canPublish is blocked when review is stale after HEAD moved (worker run invalidation)", () => {
  const ledger = freshLedger();
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, "base000");
  ledger.recordReview("app", APPROVE, "base000");
  // Sanity: both attest base000 — would be publishable before the move.
  assert.equal(ledger.canPublish("app").ok, true);

  // A worker run moves HEAD — both verdicts attest a sha that no longer
  // exists at HEAD and must be invalidated.
  ledger.recordWorkerRun("app", { committed: true, headSha: "head111" });
  const entry = ledger.getRepo("app")!;
  assert.equal(entry.testGreen, null);
  assert.equal(entry.reviewApproved, null);
  assert.equal(entry.headSha, "head111");

  const gate = ledger.canPublish("app");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no green test run/);
});

test("canPublish allows when plan + green tests + approving review all attest current HEAD", () => {
  const ledger = freshLedger();
  ledger.recordPlan("app", PLAN);
  ledger.recordWorkerRun("app", { committed: true, headSha: "head111" });
  ledger.recordTests("app", true, "head111");
  ledger.recordReview("app", APPROVE, "head111");
  assert.deepEqual(ledger.canPublish("app"), { ok: true });
});

test("a request_changes review does NOT record an approval", () => {
  const ledger = freshLedger();
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, "base000");
  ledger.recordReview("app", REQUEST_CHANGES, "base000");
  assert.equal(ledger.getRepo("app")!.reviewApproved, null);
  const gate = ledger.canPublish("app");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /no approving review/);
});

test("a failing test run clears any previously recorded green verdict", () => {
  const ledger = freshLedger();
  ledger.recordTests("app", true, "base000");
  assert.deepEqual(ledger.getRepo("app")!.testGreen, { sha: "base000" });
  ledger.recordTests("app", false, "base000");
  assert.equal(ledger.getRepo("app")!.testGreen, null);
});

test("a no-op worker run (HEAD unchanged) does NOT invalidate recorded verdicts", () => {
  const ledger = freshLedger();
  ledger.recordTests("app", true, "base000");
  ledger.recordReview("app", APPROVE, "base000");
  ledger.recordWorkerRun("app", { committed: false, headSha: "base000" });
  assert.deepEqual(ledger.getRepo("app")!.testGreen, { sha: "base000" });
  assert.notEqual(ledger.getRepo("app")!.reviewApproved, null);
});

test("consumeAction is fail-closed once MRW_SPINE_MAX_ACTIONS is exhausted", () => {
  const ledger = freshLedger({ maxActions: 2 });
  assert.equal(ledger.consumeAction().ok, true);
  assert.equal(ledger.consumeAction().ok, true);
  const third = ledger.consumeAction();
  assert.equal(third.ok, false);
  if (!third.ok) assert.match(third.reason, /MRW_SPINE_MAX_ACTIONS exhausted/);
});

test("consumeWorkerRun is fail-closed once MRW_SPINE_MAX_WORKER_RUNS is exhausted, independent of the action budget", () => {
  const ledger = freshLedger({ maxActions: 1000, maxWorkerRuns: 1 });
  assert.equal(ledger.consumeWorkerRun().ok, true);
  const second = ledger.consumeWorkerRun();
  assert.equal(second.ok, false);
  if (!second.ok) assert.match(second.reason, /MRW_SPINE_MAX_WORKER_RUNS exhausted/);
  // The action budget is untouched by worker-run consumption.
  assert.equal(ledger.consumeAction().ok, true);
});

test("an unknown repo is a safe no-op for record* methods (callers must check hasRepo/getRepo first)", () => {
  const ledger = freshLedger();
  assert.equal(ledger.hasRepo("nope"), false);
  assert.equal(ledger.getRepo("nope"), undefined);
  ledger.recordTests("nope", true, "x"); // must not throw
  ledger.recordWorkerRun("nope", { committed: true, headSha: "x" }); // must not throw
  const gate = ledger.canPublish("nope");
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /unknown repo/);
});

test("persist() writes an atomically-readable snapshot to spine-ledger.json", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-ledger-persist-"));
  const ledger = new SpineLedger("T-9", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  ledger.recordPlan("app", PLAN);
  ledger.persist();
  const file = path.join(dir, "spine-ledger.json");
  assert.equal(fs.existsSync(file), true);
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.ticket, "T-9");
  assert.equal(parsed.repos.app.plan.summary, "do the thing");
  assert.equal(fs.existsSync(`${file}.tmp`), false); // rename leaves no temp file behind
});

test("persist() accepts an explicit dir override (used by callers without a constructor default)", () => {
  const ledger = new SpineLedger("T-10", { app: { repoDir: "/tmp/app", baseSha: "base000" } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spine-ledger-explicit-"));
  ledger.persist(dir);
  assert.equal(fs.existsSync(path.join(dir, "spine-ledger.json")), true);
});

test("persist() with no dir and no constructor default throws (never silently drops state)", () => {
  const ledger = new SpineLedger("T-11", { app: { repoDir: "/tmp/app", baseSha: "base000" } });
  assert.throws(() => ledger.persist());
});
