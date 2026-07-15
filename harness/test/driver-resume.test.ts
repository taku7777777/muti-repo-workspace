/**
 * test/driver-resume.test.ts — multi/driver.ts's resolveResumedInstruction,
 * exercised with NO SDK import at all (it's a pure function over TicketState).
 * Fixes the open Phase 3 finding: resume used to pin the stored instruction
 * even when nothing had been published yet. Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveResumedInstruction } from "../src/multi/driver.js";
import type { TicketState } from "../src/multi/types.js";

function state(instruction: string, repos: TicketState["repos"] = {}): TicketState {
  return {
    ticket: "ABC-1",
    instruction,
    branch: "feat/ABC-1",
    purpose: "dev",
    repos,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

test("differing instruction + nothing published → adopted", () => {
  const result = resolveResumedInstruction(state("old instruction"), "new instruction");
  assert.equal(result.adopted, true);
  assert.equal(result.instruction, "new instruction");
});

test("differing instruction + one repo already published → kept", () => {
  const s = state("old instruction", { app: { outcome: "published", sha: "deadbeef" } });
  const result = resolveResumedInstruction(s, "new instruction");
  assert.equal(result.adopted, false);
  assert.equal(result.instruction, "old instruction");
});

test("differing instruction + a published repo alongside a pending one → kept", () => {
  const s = state("old instruction", {
    app: { outcome: "published", sha: "deadbeef" },
    knowledge: { outcome: "pending" },
  });
  const result = resolveResumedInstruction(s, "new instruction");
  assert.equal(result.adopted, false);
  assert.equal(result.instruction, "old instruction");
});

test("same instruction → kept (nothing to adopt)", () => {
  const result = resolveResumedInstruction(state("same instruction"), "same instruction");
  assert.equal(result.adopted, false);
  assert.equal(result.instruction, "same instruction");
});

test("empty given instruction → kept", () => {
  const result = resolveResumedInstruction(state("old instruction"), "");
  assert.equal(result.adopted, false);
  assert.equal(result.instruction, "old instruction");
});

test("non-published outcomes (declined/failed/not_ready/pending) do not block adoption", () => {
  const s = state("old instruction", {
    app: { outcome: "declined" },
    knowledge: { outcome: "failed" },
    other: { outcome: "not_ready" },
    another: { outcome: "pending" },
  });
  const result = resolveResumedInstruction(s, "new instruction");
  assert.equal(result.adopted, true);
  assert.equal(result.instruction, "new instruction");
});
