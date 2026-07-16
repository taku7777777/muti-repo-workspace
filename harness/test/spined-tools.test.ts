/**
 * test/spined-tools.test.ts — spined/tools.ts's tool → dispatch mapping,
 * status's budget-exempt bypass of dispatch(), and the keep-alive progress
 * timer. Exercised with a FAKE Executor (never a real one — no SDK, no git,
 * no filesystem beyond a throwaway ledger dir) whose dispatch() just records
 * calls and returns a canned ActionResult, mirroring
 * workerd/handlers.ts-style dispatch-table tests. Run: `npm test`
 * (node:test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SpineLedger } from "../src/spine/ledger.js";
import type { EndedInfo, Executor } from "../src/spine/executor.js";
import type { ActionResult, SpineAction } from "../src/spine/actions.js";
import { buildActionTools, buildStatusTool, DEFAULT_KEEPALIVE_INTERVAL_MS } from "../src/spined/tools.js";
import type { SpinedToolExtra } from "../src/spined/tools.js";

function fakeExecutor(result: ActionResult, ended: EndedInfo | null = null): { executor: Executor; calls: SpineAction[] } {
  const calls: SpineAction[] = [];
  const executor: Executor = {
    dispatch: async (action: SpineAction) => {
      calls.push(action);
      return result;
    },
    isEnded: () => ended !== null,
    endedInfo: () => ended,
  };
  return { executor, calls };
}

function noopExtra(): SpinedToolExtra {
  return { sendNotification: async () => {} };
}

function tmpLedgerDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spined-tools-test-"));
}

// --- action tool -> dispatch mapping --------------------------------------------

test("buildActionTools() exposes exactly the seven effect tools, in a stable set (ask_human/show_human excluded)", () => {
  const { executor } = fakeExecutor({ ok: true } as ActionResult);
  const tools = buildActionTools(executor);
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["abort", "done", "plan_repo", "request_publish", "review_diff", "run_tests", "run_worker"]);
});

test("run_worker builds the exact typed SpineAction from validated args and dispatches it", async () => {
  const { executor, calls } = fakeExecutor({ ok: true, committed: true, headSha: "abc123" });
  const tools = buildActionTools(executor);
  const tool = tools.find((t) => t.name === "run_worker")!;

  const result = await tool.handler({ repo: "app", instruction: "add a flag" }, noopExtra());
  assert.deepEqual(calls, [{ action: "run_worker", repo: "app", instruction: "add a flag" }]);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, committed: true, headSha: "abc123" });
});

test("run_tests/review_diff/plan_repo/request_publish build {action, repo} only", async () => {
  const { executor, calls } = fakeExecutor({ ok: true, pass: true, status: 0, output: "" });
  const tools = buildActionTools(executor);
  for (const name of ["run_tests", "review_diff", "plan_repo", "request_publish"]) {
    calls.length = 0;
    const tool = tools.find((t) => t.name === name)!;
    await tool.handler({ repo: "app" }, noopExtra());
    assert.deepEqual(calls, [{ action: name, repo: "app" }]);
  }
});

test("done/abort build {action, summary|reason} and dispatch them", async () => {
  const { executor, calls } = fakeExecutor({ ok: true });
  const tools = buildActionTools(executor);

  await tools.find((t) => t.name === "done")!.handler({ summary: "shipped" }, noopExtra());
  assert.deepEqual(calls[0], { action: "done", summary: "shipped" });

  await tools.find((t) => t.name === "abort")!.handler({ reason: "budget exhausted" }, noopExtra());
  assert.deepEqual(calls[1], { action: "abort", reason: "budget exhausted" });
});

test("a dispatch failure result is JSON.stringify'd through untouched (no re-interpretation)", async () => {
  const failure: ActionResult = { ok: false, code: "session_ended", error: "session already ended (done): x" };
  const { executor } = fakeExecutor(failure);
  const tools = buildActionTools(executor);
  const result = await tools.find((t) => t.name === "run_tests")!.handler({ repo: "app" }, noopExtra());
  assert.deepEqual(JSON.parse(result.content[0].text), failure);
});

// --- status: budget-exempt, never dispatch() ------------------------------------

test("status never calls executor.dispatch() and burns no ledger budget", async () => {
  const dir = tmpLedgerDir();
  const ledger = new SpineLedger("T-1", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  const before = ledger.budgetsSnapshot();
  const { executor, calls } = fakeExecutor({ ok: true });

  const statusTool = buildStatusTool(ledger, executor);
  await statusTool.handler({}, noopExtra());

  assert.equal(calls.length, 0, "status must never call executor.dispatch()");
  assert.deepEqual(ledger.budgetsSnapshot(), before, "status must not consume any budget");
});

test("status reports per-repo baseSha/headSha/tests/review/published, budgets, and ended state", async () => {
  const dir = tmpLedgerDir();
  const ledger = new SpineLedger(
    "T-2",
    { app: { repoDir: "/tmp/app", baseSha: "base000" }, lib: { repoDir: "/tmp/lib", baseSha: "l000" } },
    { maxActions: 10, maxWorkerRuns: 2 },
    dir,
  );
  ledger.recordWorkerRun("app", { committed: true, headSha: "head111" });
  ledger.recordPlan("app", { summary: "s", steps: ["a"], risks: [], ready_to_implement: true });
  ledger.recordTests("app", true, "head111");
  ledger.recordReview("app", { verdict: "approve", findings: [], summary: "ok" }, "head111");
  ledger.recordPublished("app", "head111", "https://example/pr/1");
  ledger.consumeAction();
  ledger.consumeWorkerRun();

  const endedInfo: EndedInfo = { kind: "done", message: "all good" };
  const { executor } = fakeExecutor({ ok: true }, endedInfo);
  const statusTool = buildStatusTool(ledger, executor);
  const result = await statusTool.handler({}, noopExtra());
  const parsed = JSON.parse(result.content[0].text);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.ticket, "T-2");
  assert.deepEqual(parsed.repos.app, {
    baseSha: "base000",
    headSha: "head111",
    tests: { sha: "head111", atHead: true },
    review: { verdict: "approve", sha: "head111", atHead: true },
    published: { sha: "head111", prUrl: "https://example/pr/1" },
  });
  assert.deepEqual(parsed.repos.lib, {
    baseSha: "l000",
    headSha: "l000",
    tests: null,
    review: null,
    published: null,
  });
  assert.deepEqual(parsed.budgets, { actionsUsed: 1, maxActions: 10, workerRunsUsed: 1, maxWorkerRuns: 2 });
  assert.deepEqual(parsed.ended, endedInfo);
});

test("status reflects a null ended state before done()/abort()", async () => {
  const dir = tmpLedgerDir();
  const ledger = new SpineLedger("T-3", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  const { executor } = fakeExecutor({ ok: true }, null);
  const statusTool = buildStatusTool(ledger, executor);
  const result = await statusTool.handler({}, noopExtra());
  const parsed = JSON.parse(result.content[0].text);
  assert.equal(parsed.ended, null);
});

// --- keep-alive progress ---------------------------------------------------------

test("default keep-alive interval is 10s", () => {
  assert.equal(DEFAULT_KEEPALIVE_INTERVAL_MS, 10_000);
});

test("no progressToken => sendNotification is never called, even for a slow dispatch", async () => {
  let notified = 0;
  const executor: Executor = {
    dispatch: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 30)),
    isEnded: () => false,
    endedInfo: () => null,
  };
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 5 });
  const extra: SpinedToolExtra = { sendNotification: async () => { notified++; } }; // no progressToken
  await tools.find((t) => t.name === "run_tests")!.handler({ repo: "app" }, extra);
  assert.equal(notified, 0);
});

test("a progressToken makes a slow dispatch emit periodic notifications/progress, then stop", async () => {
  const notifications: Array<{ method: string; params: Record<string, unknown> }> = [];
  const executor: Executor = {
    dispatch: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true }), 35)),
    isEnded: () => false,
    endedInfo: () => null,
  };
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 10 });
  const extra: SpinedToolExtra = {
    progressToken: "tok-1",
    sendNotification: async (n) => {
      notifications.push(n);
    },
  };
  await tools.find((t) => t.name === "run_worker")!.handler({ repo: "app", instruction: "x" }, extra);

  assert.ok(notifications.length >= 2, `expected at least 2 keep-alive ticks, got ${notifications.length}`);
  for (const n of notifications) {
    assert.equal(n.method, "notifications/progress");
    assert.equal(n.params.progressToken, "tok-1");
    assert.match(n.params.message as string, /run_worker running — [\d.]+s elapsed/);
  }

  // The timer must be cleared once the dispatch resolves — no further ticks
  // arrive after a short grace period.
  const countAtFinish = notifications.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(notifications.length, countAtFinish, "keep-alive timer kept firing after dispatch resolved");
});

test("a rejecting sendNotification never fails (or delays) the dispatch it is narrating", async () => {
  const executor: Executor = {
    dispatch: async () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, committed: false, headSha: "x" }), 25)),
    isEnded: () => false,
    endedInfo: () => null,
  };
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 5 });
  const extra: SpinedToolExtra = {
    progressToken: "tok-2",
    sendNotification: async () => {
      throw new Error("client went away");
    },
  };
  const result = await tools.find((t) => t.name === "run_worker")!.handler({ repo: "app", instruction: "x" }, extra);
  assert.deepEqual(JSON.parse(result.content[0].text), { ok: true, committed: false, headSha: "x" });
});

test("the keep-alive timer is cleaned up even when the dispatch REJECTS, not just when it resolves (independent review NIT #9)", async () => {
  const notifications: unknown[] = [];
  const executor: Executor = {
    dispatch: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("dispatch blew up")), 30)),
    isEnded: () => false,
    endedInfo: () => null,
  };
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 5 });
  const extra: SpinedToolExtra = {
    progressToken: "tok-3",
    sendNotification: async (n) => {
      notifications.push(n);
    },
  };

  // withKeepAliveProgress()'s `finally { clearInterval(timer) }` (tools.ts)
  // must fire on the REJECTION path too — try/finally is unconditional, but
  // this proves it end to end rather than by inspection.
  await assert.rejects(
    () => tools.find((t) => t.name === "run_worker")!.handler({ repo: "app", instruction: "x" }, extra),
    /dispatch blew up/,
  );

  assert.ok(notifications.length >= 1, "expected at least one keep-alive tick before the rejection");
  const countAtRejection = notifications.length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    notifications.length,
    countAtRejection,
    "keep-alive timer kept firing after the dispatch REJECTED — not cleaned up",
  );
});
