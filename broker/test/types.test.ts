import assert from "node:assert/strict";
import { test } from "node:test";
import { PublishRequestSchema, TICKET } from "../src/types.js";

test("TICKET accepts safe bare names", () => {
  for (const value of ["T-1", "abc_DEF.9", "x".repeat(100)]) {
    assert.equal(TICKET.safeParse(value).success, true, value);
  }
});

test("TICKET rejects empty, overlong, path, and dot-segment shapes", () => {
  for (const value of ["", "x".repeat(101), ".", "..", "a..b", "a/b", "a\\b", "a b", "-x/../y"]) {
    assert.equal(TICKET.safeParse(value).success, false, value);
  }
});

test("PublishRequestSchema remains strict while accepting an optional ticket", () => {
  const base = { repo: "app", branch: "feat/T-1", title: "t", body: "" };
  assert.equal(PublishRequestSchema.safeParse(base).success, true);
  assert.equal(PublishRequestSchema.safeParse({ ...base, ticket: "T-1" }).success, true);
  assert.equal(PublishRequestSchema.safeParse({ ...base, extra: true }).success, false);
});
