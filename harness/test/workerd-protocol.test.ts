/**
 * test/workerd-protocol.test.ts — workerd/protocol.ts wire-contract accept/reject,
 * exercised with NO SDK import at all (WorkerRequestSchema + encodeWorkerResponse
 * are plain zod + a string helper — see protocol.ts's header). Run: `npm test`
 * (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeWorkerResponse, WorkerRequestSchema } from "../src/workerd/protocol.js";

// A request per op that satisfies every field's schema.
const VALID: Record<string, unknown> = {
  setup_worktree: {
    op: "setup_worktree",
    ticket: "ABC-1",
    branch: "feat/ABC-1",
    purpose: "dev",
    repo: { name: "app" },
  },
  run_implement: {
    op: "run_implement",
    ticket: "ABC-1",
    repo: "app",
    prompt: "implement the thing",
    commitMessage: "mrw: IMPLEMENT the thing",
  },
  run_fix: {
    op: "run_fix",
    ticket: "ABC-1",
    repo: "app",
    prompt: "fix the thing",
    commitMessage: "mrw: FIX the thing attempt 1",
  },
  run_tests: {
    op: "run_tests",
    ticket: "ABC-1",
    repo: "app",
  },
};

// --- accept: one valid request per op -----------------------------------------

for (const op of Object.keys(VALID)) {
  test(`accepts a valid ${op} request`, () => {
    const parsed = WorkerRequestSchema.safeParse(VALID[op]);
    assert.equal(parsed.success, true);
  });
}

// --- reject: ticket path traversal --------------------------------------------

test("rejects a ticket containing '..'", () => {
  for (const [op, req] of Object.entries(VALID)) {
    const parsed = WorkerRequestSchema.safeParse({ ...(req as object), ticket: "A-1/../x" });
    assert.equal(parsed.success, false, `expected op '${op}' to reject a '..'-containing ticket`);
  }
});

test("rejects a bare '..' ticket", () => {
  const parsed = WorkerRequestSchema.safeParse({ ...VALID.run_tests as object, ticket: ".." });
  assert.equal(parsed.success, false);
});

// --- reject: repo path traversal ----------------------------------------------

test("rejects a repo containing '/'", () => {
  for (const op of ["run_implement", "run_fix", "run_tests"]) {
    const parsed = WorkerRequestSchema.safeParse({ ...(VALID[op] as object), repo: "a/b" });
    assert.equal(parsed.success, false, `expected op '${op}' to reject a slash-containing repo`);
  }
});

// --- reject: oversize prompt ---------------------------------------------------

test("rejects an oversize prompt (>512KiB)", () => {
  for (const op of ["run_implement", "run_fix"]) {
    const parsed = WorkerRequestSchema.safeParse({
      ...(VALID[op] as object),
      prompt: "x".repeat(512 * 1024 + 1),
    });
    assert.equal(parsed.success, false, `expected op '${op}' to reject an oversize prompt`);
  }
});

test("accepts a prompt right at the 512KiB bound", () => {
  const parsed = WorkerRequestSchema.safeParse({
    ...(VALID.run_implement as object),
    prompt: "x".repeat(512 * 1024),
  });
  assert.equal(parsed.success, true);
});

// --- reject: unknown op ---------------------------------------------------------

test("rejects an unknown op", () => {
  const parsed = WorkerRequestSchema.safeParse({
    op: "run_delete_everything",
    ticket: "ABC-1",
    repo: "app",
  });
  assert.equal(parsed.success, false);
});

// --- reject: non-strict extra fields --------------------------------------------

test("rejects extra fields on a discriminated-union member (.strict())", () => {
  for (const [op, req] of Object.entries(VALID)) {
    const parsed = WorkerRequestSchema.safeParse({ ...(req as object), extra: "not allowed" });
    assert.equal(parsed.success, false, `expected op '${op}' to reject an unrecognized field`);
  }
});

// --- encodeWorkerResponse framing -----------------------------------------------

test("encodeWorkerResponse ends with exactly one newline", () => {
  const encoded = encodeWorkerResponse({
    ok: true,
    op: "run_tests",
    pass: true,
    status: 0,
    output: "all green",
  });
  assert.ok(encoded.endsWith("\n"), "expected the encoded response to end with a newline");
  assert.equal(encoded.slice(0, -1).includes("\n"), false, "expected exactly one trailing newline");
});

test("encodeWorkerResponse frames an error response the same way", () => {
  const encoded = encodeWorkerResponse({ ok: false, code: "invalid_request", error: "nope" });
  assert.ok(encoded.endsWith("\n"));
  assert.equal(encoded.slice(0, -1).includes("\n"), false);
});
