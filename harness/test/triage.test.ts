/**
 * test/triage.test.ts — TriageSchema accept/reject + triage.ts's pure
 * filterToAvailableRepos() helper, exercised with NO live API call (schema
 * validation + a plain array helper — see triage.ts's header on why the
 * subset filter is factored out for testability). Run: `npm test`
 * (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { TriageSchema, WORK_TYPES } from "../src/types.js";
import { filterToAvailableRepos } from "../src/triage.js";

const VALID = {
  work_type: "bugfix",
  title: "Fix the flaky login test",
  repos: ["phase2-demo"],
  summary: "The login test intermittently fails under load; add a retry with backoff.",
};

// --- TriageSchema --------------------------------------------------------

test("TriageSchema accepts a valid object", () => {
  const parsed = TriageSchema.safeParse(VALID);
  assert.equal(parsed.success, true);
});

test("TriageSchema rejects a bad work_type", () => {
  const parsed = TriageSchema.safeParse({ ...VALID, work_type: "not-a-real-type" });
  assert.equal(parsed.success, false);
});

test("TriageSchema rejects a missing title", () => {
  const { title: _title, ...rest } = VALID;
  const parsed = TriageSchema.safeParse(rest);
  assert.equal(parsed.success, false);
});

test("TriageSchema rejects an empty title", () => {
  const parsed = TriageSchema.safeParse({ ...VALID, title: "" });
  assert.equal(parsed.success, false);
});

test("TriageSchema rejects a title over 120 chars", () => {
  const parsed = TriageSchema.safeParse({ ...VALID, title: "x".repeat(121) });
  assert.equal(parsed.success, false);
});

test("TriageSchema rejects a non-array repos field", () => {
  const parsed = TriageSchema.safeParse({ ...VALID, repos: "phase2-demo" });
  assert.equal(parsed.success, false);
});

test("TriageSchema accepts every WORK_TYPES member", () => {
  for (const wt of WORK_TYPES) {
    const parsed = TriageSchema.safeParse({ ...VALID, work_type: wt });
    assert.equal(parsed.success, true, `expected work_type '${wt}' to be accepted`);
  }
});

test("TriageSchema accepts an empty repos array and empty summary", () => {
  const parsed = TriageSchema.safeParse({ ...VALID, repos: [], summary: "" });
  assert.equal(parsed.success, true);
});

// --- filterToAvailableRepos (the enforced-in-code subset constraint) -----

test("filterToAvailableRepos keeps only repos present in the available set", () => {
  const result = filterToAvailableRepos(
    ["phase2-demo", "hallucinated-repo"],
    ["phase2-demo", "phase3-docs"],
  );
  assert.deepEqual(result, ["phase2-demo"]);
});

test("filterToAvailableRepos drops duplicates while preserving first-seen order", () => {
  const result = filterToAvailableRepos(["b", "a", "b"], ["a", "b"]);
  assert.deepEqual(result, ["b", "a"]);
});

test("filterToAvailableRepos returns empty when nothing matches", () => {
  assert.deepEqual(filterToAvailableRepos(["x", "y"], ["a", "b"]), []);
});

test("filterToAvailableRepos returns empty for an empty available set", () => {
  assert.deepEqual(filterToAvailableRepos(["a"], []), []);
});

test("filterToAvailableRepos returns empty for empty claimed repos", () => {
  assert.deepEqual(filterToAvailableRepos([], ["a", "b"]), []);
});
