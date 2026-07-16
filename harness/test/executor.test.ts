/**
 * test/executor.test.ts — spine/executor.ts's Phase-C2 engine adaptations
 * (docs/mrw-chat.md "Deliberate engine adaptations" A + B), exercised
 * against a REAL throwaway git fixture (mirrors gitops.test.ts's posture —
 * commitRangeDiff's fail-closed contract is only meaningful against real git
 * output) with the Agent-SDK-calling steps (run_worker/run_tests/plan_repo/
 * review_diff) never invoked: request_publish is the one action that needs
 * NO SDK call at all (ledger state is seeded directly via the ledger's own
 * record* methods, and BROKER_SOCKET is left unset so publish.ts takes its
 * deterministic, network-free Phase-1 stub path), and session_ended is
 * checked before any action-specific code — including SDK calls — ever
 * runs. This is why request_publish + done/abort are enough to cover both
 * adaptations without mocking anything. Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { createExecutor } from "../src/spine/executor.js";
import type { ExecutorDeps } from "../src/spine/executor.js";
import { SpineLedger } from "../src/spine/ledger.js";
import type { Plan, Review } from "../src/types.js";

const IDENTITY = ["-c", "user.name=test-fixture", "-c", "user.email=test-fixture@local"];
const PLAN: Plan = { summary: "do the thing", steps: ["step 1"], risks: [], ready_to_implement: true };
const APPROVE: Review = { verdict: "approve", findings: [], summary: "looks good" };

let repoDir: string;
let shaA: string; // baseSha
let shaB: string; // headSha, after a second commit (simulates a completed worker run)
let originalBrokerSocket: string | undefined;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoDir, ...IDENTITY, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

before(() => {
  // BROKER_SOCKET must stay unset for every test here — publish.ts's
  // Phase-1 stub path is what makes request_publish deterministic and
  // network-free (see this file's header).
  originalBrokerSocket = process.env.BROKER_SOCKET;
  delete process.env.BROKER_SOCKET;

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-test-"));
  git(["-c", "init.defaultBranch=main", "init", "-q"]);
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit A"]);
  shaA = git(["rev-parse", "HEAD"]);

  fs.writeFileSync(path.join(repoDir, "src.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit B (simulated worker run)"]);
  shaB = git(["rev-parse", "HEAD"]);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  if (originalBrokerSocket === undefined) delete process.env.BROKER_SOCKET;
  else process.env.BROKER_SOCKET = originalBrokerSocket;
});

/** A ledger with one repo ("app") already at shaB, publish-ready (plan +
 *  green tests + approving review, all attesting shaB). */
function publishReadyLedger(): SpineLedger {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-1", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  ledger.recordWorkerRun("app", { committed: true, headSha: shaB });
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, shaB);
  ledger.recordReview("app", APPROVE, shaB);
  return ledger;
}

/** A fake askHuman driven by a fixed answer queue; throws if called more
 *  times than answers were supplied (fails the test loudly instead of
 *  hanging) — and a variant that throws UNCONDITIONALLY, for asserting a
 *  code path never asks at all (broker-only policy). */
function queuedAskHuman(answers: string[]): { askHuman: ExecutorDeps["askHuman"]; calls: string[] } {
  const calls: string[] = [];
  const askHuman = async (question: string): Promise<string> => {
    calls.push(question);
    if (answers.length === 0) throw new Error("queuedAskHuman: no more answers queued — unexpected extra call");
    return answers.shift()!;
  };
  return { askHuman, calls };
}

function unreachableAskHuman(): ExecutorDeps["askHuman"] {
  return async (question: string): Promise<string> => {
    throw new Error(`askHuman must never be called under approvalPolicy 'broker-only' (question: "${question}")`);
  };
}

// --- Engine adaptation A: approvalPolicy ---------------------------------------

test("in-chat (default): a 'y' final answer publishes via the stub path (BROKER_SOCKET unset)", async () => {
  const ledger = publishReadyLedger();
  const { askHuman, calls } = queuedAskHuman(["y"]);
  const executor = createExecutor({ ledger, instruction: "ticket instruction", askHuman, say: () => {} });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, {
    ok: true,
    published: false,
    note: "stub (BROKER_SOCKET unset) — nothing pushed",
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /Tests green and review approved\. Publish\?/);
});

test("in-chat (explicit): behaves identically to the default", async () => {
  const ledger = publishReadyLedger();
  const { askHuman, calls } = queuedAskHuman(["y"]);
  const executor = createExecutor({
    ledger,
    instruction: "ticket instruction",
    askHuman,
    say: () => {},
    approvalPolicy: "in-chat",
  });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, { ok: true, published: false, note: "stub (BROKER_SOCKET unset) — nothing pushed" });
  assert.equal(calls.length, 1);
});

test("in-chat: a 'n' (or anything non-affirmative) final answer declines without publishing", async () => {
  const ledger = publishReadyLedger();
  const { askHuman, calls } = queuedAskHuman(["n"]);
  const executor = createExecutor({ ledger, instruction: "ticket instruction", askHuman, say: () => {} });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, { ok: false, code: "publish_declined", error: "human declined publish" });
  assert.equal(calls.length, 1);
  assert.equal(ledger.getRepo("app")!.published, null);
});

test("in-chat: a diff touching test files asks the caveat ack BEFORE the final publish question", async () => {
  // Make headSha's diff touch a test-shaped path so diffTouchesTests(diff)
  // is true — a THIRD commit on the shared fixture repo, its own ledger.
  fs.writeFileSync(path.join(repoDir, "src.test.ts"), "test('x', () => {});\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit C (touches a test file)"]);
  const shaC = git(["rev-parse", "HEAD"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-2", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  ledger.recordWorkerRun("app", { committed: true, headSha: shaC });
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, shaC);
  ledger.recordReview("app", APPROVE, shaC);

  const { askHuman, calls } = queuedAskHuman(["y", "y"]);
  const executor = createExecutor({ ledger, instruction: "ticket instruction", askHuman, say: () => {} });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, { ok: true, published: false, note: "stub (BROKER_SOCKET unset) — nothing pushed" });
  assert.equal(calls.length, 2);
  assert.match(calls[0], /test-independence caveat|touches test files/);
  assert.match(calls[1], /Tests green and review approved\. Publish\?/);
});

test("in-chat: declining the test-independence caveat stops before the final publish question", async () => {
  // Self-contained fixture (independent review NIT #9: this test used to
  // reuse the PREVIOUS test's commit via shared repoDir HEAD state, making
  // it depend on execution order) — make its OWN test-touching commit here.
  fs.writeFileSync(path.join(repoDir, "src.test.decline.ts"), "test('y', () => {});\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit D (touches a test file, this test's own)"]);
  const shaD = git(["rev-parse", "HEAD"]);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-3", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  ledger.recordWorkerRun("app", { committed: true, headSha: shaD });
  ledger.recordPlan("app", PLAN);
  ledger.recordTests("app", true, shaD);
  ledger.recordReview("app", APPROVE, shaD);

  const { askHuman, calls } = queuedAskHuman(["n"]);
  const executor = createExecutor({ ledger, instruction: "ticket instruction", askHuman, say: () => {} });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, { ok: false, code: "publish_declined", error: "declined at the test-independence caveat" });
  assert.equal(calls.length, 1); // never reached the final "Publish?" question
});

test("broker-only: publishes straight through WITHOUT ever calling askHuman", async () => {
  const ledger = publishReadyLedger();
  const executor = createExecutor({
    ledger,
    instruction: "ticket instruction",
    askHuman: unreachableAskHuman(),
    say: () => {
      throw new Error("say() must never be called on the request_publish path");
    },
    approvalPolicy: "broker-only",
  });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.deepEqual(result, { ok: true, published: false, note: "stub (BROKER_SOCKET unset) — nothing pushed" });
});

test("broker-only: the ledger gate still applies BEFORE the (skipped) human-approval block", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-4", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  // No plan/tests/review recorded — canPublish() must refuse regardless of policy.
  const executor = createExecutor({
    ledger,
    instruction: "ticket instruction",
    askHuman: unreachableAskHuman(),
    say: () => {},
    approvalPolicy: "broker-only",
  });

  const result = await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, "invariants_not_met");
    assert.match(result.error, /no plan recorded/);
  }
});

// --- Engine adaptation B: post-ended dispatch refusal --------------------------

test("dispatch() after done() refuses every further action with session_ended, burning no budget", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-5", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  const executor = createExecutor({
    ledger,
    instruction: "ticket instruction",
    askHuman: unreachableAskHuman(),
    say: () => {},
  });

  const doneResult = await executor.dispatch({ action: "done", summary: "all shipped" });
  assert.deepEqual(doneResult, { ok: true });
  assert.equal(executor.isEnded(), true);
  assert.deepEqual(executor.endedInfo(), { kind: "done", message: "all shipped" });
  assert.equal(ledger.budgetsSnapshot().actionsUsed, 1); // only done() consumed budget

  const after1 = await executor.dispatch({ action: "abort", reason: "too late" });
  assert.equal(after1.ok, false);
  if (!after1.ok) {
    assert.equal(after1.code, "session_ended");
    assert.match(after1.error, /done/);
    assert.match(after1.error, /all shipped/);
  }

  const after2 = await executor.dispatch({ action: "run_tests", repo: "app" });
  assert.equal(after2.ok, false);
  if (!after2.ok) assert.equal(after2.code, "session_ended");

  // Neither post-ended dispatch touched the ledger's action budget, and
  // endedInfo() still reports the ORIGINAL done() outcome (abort() never
  // actually ran — its handler never executes past the session_ended check).
  assert.equal(ledger.budgetsSnapshot().actionsUsed, 1);
  assert.deepEqual(executor.endedInfo(), { kind: "done", message: "all shipped" });
});

test("dispatch() after abort() refuses further actions with session_ended", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "executor-ledger-"));
  const ledger = new SpineLedger("T-6", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  const executor = createExecutor({
    ledger,
    instruction: "ticket instruction",
    askHuman: unreachableAskHuman(),
    say: () => {},
  });

  await executor.dispatch({ action: "abort", reason: "giving up" });
  assert.equal(executor.isEnded(), true);

  const after = await executor.dispatch({ action: "done", summary: "too late" });
  assert.equal(after.ok, false);
  if (!after.ok) {
    assert.equal(after.code, "session_ended");
    assert.match(after.error, /abort/);
    assert.match(after.error, /giving up/);
  }
  // The late done() call never actually recorded — endedInfo() still reports abort.
  assert.deepEqual(executor.endedInfo(), { kind: "abort", message: "giving up" });
});
