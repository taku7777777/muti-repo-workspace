/**
 * test/caveat.test.ts — caveat.ts's diffTouchesTests(), exercised with NO
 * SDK/network import at all (it's a pure string function over a diff — see
 * caveat.ts's header on why it deliberately re-implements
 * harness/src/steps.ts's diffTouchesTests() rather than importing it). Run:
 * `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffTouchesTests } from "../src/caveat.js";

function diffFor(path: string, extra = ""): string {
  return `diff --git a/${path} b/${path}\nindex 111..222 100644\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new\n${extra}`;
}

// --- true: test-shaped paths --------------------------------------------------

test("flags a __tests__/ directory", () => {
  assert.equal(diffTouchesTests(diffFor("src/__tests__/foo.ts")), true);
});

test("flags a .test. filename", () => {
  assert.equal(diffTouchesTests(diffFor("src/foo.test.ts")), true);
});

test("flags a .spec. filename", () => {
  assert.equal(diffTouchesTests(diffFor("src/foo.spec.ts")), true);
});

test("flags a top-level tests/ directory", () => {
  assert.equal(diffTouchesTests(diffFor("tests/foo.ts")), true);
});

test("flags a top-level test/ directory", () => {
  assert.equal(diffTouchesTests(diffFor("test/foo.ts")), true);
});

test("flags jest.config", () => {
  assert.equal(diffTouchesTests(diffFor("jest.config.js")), true);
});

test("flags vitest.config", () => {
  assert.equal(diffTouchesTests(diffFor("vitest.config.ts")), true);
});

test("flags playwright.config", () => {
  assert.equal(diffTouchesTests(diffFor("playwright.config.ts")), true);
});

test("flags conftest.py", () => {
  assert.equal(diffTouchesTests(diffFor("conftest.py")), true);
});

test("flags an added/removed package.json \"test\" script line", () => {
  const diff =
    "diff --git a/package.json b/package.json\n" +
    "index 111..222 100644\n" +
    "--- a/package.json\n" +
    "+++ b/package.json\n" +
    "@@ -2,3 +2,3 @@\n" +
    '-  "test": "old",\n' +
    '+  "test": "new",\n';
  assert.equal(diffTouchesTests(diff), true);
});

// --- false: unrelated paths ---------------------------------------------------

test("does not flag an ordinary source file", () => {
  assert.equal(diffTouchesTests(diffFor("src/foo.ts")), false);
});

test("does not flag a package.json diff that never touches the \"test\" line", () => {
  const diff =
    "diff --git a/package.json b/package.json\n" +
    "index 111..222 100644\n" +
    "--- a/package.json\n" +
    "+++ b/package.json\n" +
    "@@ -2,3 +2,3 @@\n" +
    '-  "version": "1.0.0",\n' +
    '+  "version": "1.0.1",\n';
  assert.equal(diffTouchesTests(diff), false);
});

test("an empty diff is not flagged", () => {
  assert.equal(diffTouchesTests(""), false);
});

// --- documented gap: a root-level bare test.js is NOT matched -----------------
// Recorded deliberately (caveat.ts's header) — this is not a bug to fix here,
// it is the KNOWN gap the harness's own diffTouchesTests() already has; this
// test pins that the broker's replica has the SAME gap, not a different one.
test("known gap: a root-level bare test.js is not matched", () => {
  assert.equal(diffTouchesTests(diffFor("test.js")), false);
});
