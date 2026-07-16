/**
 * test/ledger-load.test.ts — SpineLedger.load() (Engine adaptation C,
 * docs/mrw-chat.md "Deliberate engine adaptations" #3): persist()→load()
 * round trips, baseSha stability across a resume, and fail-closed behavior
 * on a missing/corrupt/wrong-version/wrong-ticket file. Exercised with NO
 * SDK import at all (same posture as ledger.test.ts — SpineLedger is pure
 * state + fs). Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SPINE_LEDGER_VERSION, SpineLedger } from "../src/spine/ledger.js";
import type { Plan, Review } from "../src/types.js";

const PLAN: Plan = { summary: "do the thing", steps: ["step 1"], risks: [], ready_to_implement: true };
const APPROVE: Review = { verdict: "approve", findings: [], summary: "looks good" };
const REQUEST_CHANGES: Review = {
  verdict: "request_changes",
  findings: [{ severity: "major", detail: "needs work", file: "src/app.ts" }],
  summary: "not yet",
};

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spine-ledger-load-test-"));
}

test("load() restores baseSha, headSha, budgets, and the instruction verbatim after a plain persist", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-1", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.setInstruction("implement the thing");
  seeded.consumeAction();
  seeded.consumeAction();
  seeded.consumeWorkerRun();
  seeded.persist();

  const loaded = SpineLedger.load("T-1", dir);
  assert.equal(loaded.ticket, "T-1");
  assert.equal(loaded.getInstruction(), "implement the thing");
  assert.deepEqual(loaded.getRepo("app"), {
    repoDir: "/tmp/app",
    baseSha: "base000",
    headSha: "base000",
    plan: null,
    testGreen: null,
    reviewApproved: null,
    published: null,
  });
  assert.deepEqual(loaded.budgetsSnapshot(), seeded.budgetsSnapshot());
});

test("load() restores baseSha WITHOUT re-deriving it — it stays the original base even after HEAD moved", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-2", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.recordWorkerRun("app", { committed: true, headSha: "head111" });
  seeded.recordPlan("app", PLAN);
  seeded.recordTests("app", true, "head111");
  seeded.recordReview("app", APPROVE, "head111");
  seeded.persist();

  const loaded = SpineLedger.load("T-2", dir);
  const entry = loaded.getRepo("app")!;
  assert.equal(entry.baseSha, "base000"); // NEVER re-derived from "current HEAD"
  assert.equal(entry.headSha, "head111");
  assert.deepEqual(entry.plan, PLAN);
  assert.deepEqual(entry.testGreen, { sha: "head111" });
  assert.deepEqual(entry.reviewApproved, { sha: "head111", review: APPROVE });
  // canPublish() still evaluates correctly against the restored state.
  assert.deepEqual(loaded.canPublish("app"), { ok: true });
});

test("load() restores consumed budgets, so a resumed session continues from where it left off (never refilled)", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger(
    "T-3",
    { app: { repoDir: "/tmp/app", baseSha: "base000" } },
    { maxActions: 3, maxWorkerRuns: 1 },
    dir,
  );
  assert.equal(seeded.consumeAction().ok, true);
  assert.equal(seeded.consumeAction().ok, true);
  assert.equal(seeded.consumeWorkerRun().ok, true);
  seeded.persist();

  const loaded = SpineLedger.load("T-3", dir);
  assert.deepEqual(loaded.budgetsSnapshot(), {
    actionsUsed: 2,
    maxActions: 3,
    workerRunsUsed: 1,
    maxWorkerRuns: 1,
  });
  // One action left, zero worker runs left — NOT refilled to 3/1.
  assert.equal(loaded.consumeAction().ok, true);
  assert.equal(loaded.consumeAction().ok, false);
  assert.equal(loaded.consumeWorkerRun().ok, false);
});

test("load() round-trips a published repo entry", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-4", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.recordWorkerRun("app", { committed: true, headSha: "head111" });
  seeded.recordPlan("app", PLAN);
  seeded.recordTests("app", true, "head111");
  seeded.recordReview("app", APPROVE, "head111");
  seeded.recordPublished("app", "head111", "https://github.com/acme/app/pull/1");
  seeded.persist();

  const loaded = SpineLedger.load("T-4", dir);
  assert.deepEqual(loaded.getRepo("app")!.published, {
    sha: "head111",
    prUrl: "https://github.com/acme/app/pull/1",
  });
});

test("load() round-trips multiple repos independently", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger(
    "T-5",
    { app: { repoDir: "/tmp/app", baseSha: "a000" }, lib: { repoDir: "/tmp/lib", baseSha: "l000" } },
    undefined,
    dir,
  );
  seeded.recordPlan("app", PLAN);
  seeded.persist();

  const loaded = SpineLedger.load("T-5", dir);
  assert.deepEqual(loaded.repoNames().sort(), ["app", "lib"]);
  assert.deepEqual(loaded.getRepo("app")!.plan, PLAN);
  assert.equal(loaded.getRepo("lib")!.plan, null);
  assert.equal(loaded.getRepo("lib")!.baseSha, "l000");
});

// --- a REALISTIC, FULLY-POPULATED current-version ledger (independent
// review, SHOULD-FIX #3d): multiple repos each carrying every kind of
// recorded state (a published repo, a mid-flight repo with a
// request_changes review still pending, budgets partway consumed, a
// non-trivial instruction) — asserted FIELD FOR FIELD via a full snapshot()
// deepEqual, not spot checks, so nothing in the persisted shape can silently
// fail to round-trip. ------------------------------------------------------

test("load() restores a realistic, fully-populated ledger field-for-field (snapshot() deepEqual, multi-repo)", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger(
    "T-FULL",
    {
      app: { repoDir: "/workspace/tasks/T-FULL/repositories/app", baseSha: "app-base-0000000" },
      knowledge: { repoDir: "/workspace/tasks/T-FULL/repositories/knowledge", baseSha: "kb-base-0000000" },
      infra: { repoDir: "/workspace/tasks/T-FULL/repositories/infra", baseSha: "infra-base-0000000" },
    },
    { maxActions: 50, maxWorkerRuns: 8 },
    dir,
  );
  seeded.setInstruction(
    "Implement the new billing export endpoint across app/knowledge/infra, " +
      "with docs and a rollout plan.",
  );

  // app: fully published — the "done" end state.
  seeded.recordWorkerRun("app", { committed: true, headSha: "app-head-1111111" });
  seeded.recordPlan("app", PLAN);
  seeded.recordTests("app", true, "app-head-1111111");
  seeded.recordReview("app", APPROVE, "app-head-1111111");
  seeded.recordPublished("app", "app-head-1111111", "https://github.com/acme/app/pull/42");

  // knowledge: mid-flight — a request_changes review, no publish yet, tests
  // green at an EARLIER head than the review (still valid on its own terms —
  // this test only cares that whatever was recorded round-trips verbatim,
  // not that it forms a canPublish()-passing state).
  seeded.recordWorkerRun("knowledge", { committed: true, headSha: "kb-head-2222222" });
  seeded.recordPlan("knowledge", {
    summary: "document the export endpoint",
    steps: ["draft the doc", "link from the index"],
    risks: ["may need a follow-up for the API reference"],
    ready_to_implement: true,
  });
  seeded.recordTests("knowledge", true, "kb-head-2222222");
  seeded.recordReview("knowledge", REQUEST_CHANGES, "kb-head-2222222");

  // infra: barely touched — only a plan, nothing else recorded.
  seeded.recordPlan("infra", {
    summary: "add a feature flag",
    steps: ["add flag", "wire it up"],
    risks: [],
    ready_to_implement: false,
  });

  // Consume a realistic mix of budget (some actions, one worker run).
  for (let i = 0; i < 7; i++) seeded.consumeAction();
  seeded.consumeWorkerRun();
  seeded.consumeWorkerRun();

  seeded.persist();
  const loaded = SpineLedger.load("T-FULL", dir);

  // Field-for-field: compare full snapshots, excluding only `updatedAt`
  // (persist()/snapshot() stamp the CURRENT time, which legitimately
  // differs between the seeded write and the loaded read).
  const seededSnap = { ...seeded.snapshot(), updatedAt: "IGNORED" };
  const loadedSnap = { ...loaded.snapshot(), updatedAt: "IGNORED" };
  assert.deepEqual(loadedSnap, seededSnap);

  // And spelled out explicitly too, so a future snapshot()-shape change that
  // accidentally preserved deepEqual-but-wrong values would still be caught.
  assert.equal(loadedSnap.version, SPINE_LEDGER_VERSION);
  assert.equal(loadedSnap.ticket, "T-FULL");
  assert.equal(loadedSnap.instruction, seededSnap.instruction);
  assert.equal(loadedSnap.actionsUsed, 7);
  assert.equal(loadedSnap.maxActions, 50);
  assert.equal(loadedSnap.workerRunsUsed, 2);
  assert.equal(loadedSnap.maxWorkerRuns, 8);

  const app = loaded.getRepo("app")!;
  assert.equal(app.baseSha, "app-base-0000000");
  assert.equal(app.headSha, "app-head-1111111");
  assert.deepEqual(app.plan, PLAN);
  assert.deepEqual(app.testGreen, { sha: "app-head-1111111" });
  assert.deepEqual(app.reviewApproved, { sha: "app-head-1111111", review: APPROVE });
  assert.deepEqual(app.published, { sha: "app-head-1111111", prUrl: "https://github.com/acme/app/pull/42" });

  const knowledge = loaded.getRepo("knowledge")!;
  assert.equal(knowledge.baseSha, "kb-base-0000000");
  assert.equal(knowledge.headSha, "kb-head-2222222");
  assert.deepEqual(knowledge.testGreen, { sha: "kb-head-2222222" });
  // A request_changes review is never recorded as an approval (ledger.ts's
  // recordReview()) — round-trips as null, not the REQUEST_CHANGES object.
  assert.equal(knowledge.reviewApproved, null);
  assert.equal(knowledge.published, null);

  const infra = loaded.getRepo("infra")!;
  assert.equal(infra.baseSha, "infra-base-0000000");
  assert.equal(infra.headSha, "infra-base-0000000"); // never moved — no recordWorkerRun call
  assert.equal(infra.plan!.ready_to_implement, false);
  assert.equal(infra.testGreen, null);
  assert.equal(infra.reviewApproved, null);
  assert.equal(infra.published, null);

  assert.deepEqual(loaded.budgetsSnapshot(), { actionsUsed: 7, maxActions: 50, workerRunsUsed: 2, maxWorkerRuns: 8 });
  assert.equal(
    loaded.getInstruction(),
    "Implement the new billing export endpoint across app/knowledge/infra, with docs and a rollout plan.",
  );
});

// --- fail-closed paths ---------------------------------------------------------

test("load() throws fail-closed when no ledger file exists", () => {
  const dir = tmpDir();
  assert.throws(() => SpineLedger.load("T-6", dir), /no persisted ledger/);
});

test("load() throws fail-closed on invalid JSON", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "spine-ledger.json"), "{not json");
  assert.throws(() => SpineLedger.load("T-7", dir), /not valid JSON/);
});

test("load() throws fail-closed on a shape mismatch", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "spine-ledger.json"), JSON.stringify({ ticket: "T-8" }));
  assert.throws(() => SpineLedger.load("T-8", dir), /does not match the expected ledger shape/);
});

test("load() throws fail-closed on a version mismatch", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-9", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.persist();
  const file = path.join(dir, "spine-ledger.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, SPINE_LEDGER_VERSION);
  raw.version = SPINE_LEDGER_VERSION + 1;
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => SpineLedger.load("T-9", dir), /does not match the expected ledger shape\/version/);
});

test("load() throws fail-closed when the persisted ticket does not match the requested one", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-10", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.persist();
  assert.throws(() => SpineLedger.load("T-OTHER", dir), /is for ticket 'T-10', not 'T-OTHER'/);
});

test("load() throws fail-closed on a persisted plan that no longer validates against PlanSchema", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-11", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  seeded.recordPlan("app", PLAN);
  seeded.persist();
  const file = path.join(dir, "spine-ledger.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.repos.app.plan.steps = []; // PlanSchema requires steps.min(1)
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => SpineLedger.load("T-11", dir));
});

// --- getInstruction() default -------------------------------------------------

test("getInstruction() is null until setInstruction() is called, and persists as null", () => {
  const dir = tmpDir();
  const seeded = new SpineLedger("T-12", { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, dir);
  assert.equal(seeded.getInstruction(), null);
  seeded.persist();
  const loaded = SpineLedger.load("T-12", dir);
  assert.equal(loaded.getInstruction(), null);
});
