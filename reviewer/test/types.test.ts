/**
 * test/types.test.ts — types.ts's ReviewerRequestSchema accept/reject,
 * exercised with NO SDK import at all (plain zod — mirrors harness/test's
 * `node:test` + safeParse pattern, e.g. workerd-protocol.test.ts). Run:
 * `npm test` (node:test, wired via the same `node --import tsx --test`
 * invocation harness/ uses — no new devDependency needed, tsx was already
 * present for `npm start`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ReviewerRequestSchema } from "../src/types.js";

const BASE = { title: "some PR title", untrustedBody: "some PR body" };

// --- ticket: optional, accepted when present and valid ----------------------

test("accepts a request without a ticket (pre-telemetry shape, unchanged)", () => {
  const parsed = ReviewerRequestSchema.safeParse({ ...BASE, diffInline: "diff --git a b" });
  assert.equal(parsed.success, true);
});

test("accepts a request with a valid bare-name ticket", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    ticket: "ABC-1",
  });
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data.ticket, "ABC-1");
});

test("accepts a ticket with diffPath instead of diffInline", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffPath: "/var/mrw/review-diffs/x.diff",
    ticket: "T-42",
  });
  assert.equal(parsed.success, true);
});

// --- ticket: rejected shapes --------------------------------------------------

test("rejects a ticket containing a comma", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    ticket: "A,B",
  });
  assert.equal(parsed.success, false);
});

test("rejects a ticket containing a slash (path-shaped)", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    ticket: "a/../b",
  });
  assert.equal(parsed.success, false);
});

test("rejects a ticket over 100 characters", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    ticket: "x".repeat(101),
  });
  assert.equal(parsed.success, false);
});

test("still rejects unknown extra fields (.strict() unaffected by the new field)", () => {
  const parsed = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    ticket: "ABC-1",
    somethingElse: "nope",
  });
  assert.equal(parsed.success, false);
});

test("still enforces exactly one of diffPath/diffInline with a ticket present", () => {
  const both = ReviewerRequestSchema.safeParse({
    ...BASE,
    diffInline: "diff --git a b",
    diffPath: "/var/mrw/review-diffs/x.diff",
    ticket: "ABC-1",
  });
  assert.equal(both.success, false);

  const neither = ReviewerRequestSchema.safeParse({ ...BASE, ticket: "ABC-1" });
  assert.equal(neither.success, false);
});
