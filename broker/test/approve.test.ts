/**
 * test/approve.test.ts — approve.ts's renderHeader(): the broker-computed
 * test-independence caveat line (caveat.ts, Thread C) actually appears in
 * the rendered header when ApprovalView.testCaveat is true, is absent when
 * false, and sits next to the tri-state advisory-reviewer line (independent
 * review, SHOULD-FIX #3a).
 *
 * Never drives the real readline-backed approveAtBroker() (needs live
 * stdin) — same posture as gate.test.ts/approval-server.test.ts, which
 * exercise the sha-typed gate via a FAKE TtyApprover instead of the real
 * one. renderHeader() is exported specifically so the RENDER path is
 * testable on its own (see its doc comment in approve.ts).
 *
 * "does not gate": renderHeader()'s signature is `(v: ApprovalView) =>
 * string` — a pure formatter with no signal, no promise, never awaited by
 * approveAtBroker() for anything other than the string it prints. The
 * sha-typed confirmation (`answer.trim() === short`) lives entirely
 * elsewhere in approveAtBroker() and never reads `v.testCaveat` at all — so
 * there is no code path by which this field could influence approval,
 * structurally, not just by inspection: these tests show the SAME view
 * differing only in `testCaveat` produces a header differing ONLY in the
 * caveat block, with everything else (including the eventual sha prompt,
 * built separately in approveAtBroker from `v.headSha` alone) unaffected.
 *
 * Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderHeader } from "../src/approve.js";
import type { ApprovalView } from "../src/approve.js";

const BASE_VIEW: ApprovalView = {
  repo: "app",
  ticket: null,
  branch: "codex/T-1",
  headSha: "abc123def456abc123def456abc123def456abc1",
  title: "Some PR",
  body: "some body",
  host: "github.com",
  org: "acme",
  targetRepo: "app",
  url: "https://github.com/acme/app.git",
  commitCount: 1,
  commitList: "abc123d some commit",
  diffStat: "1 file changed",
  diff: "diff --git a/x b/x",
  reviewerVerdict: null,
  testCaveat: false,
};

test("routed approval renders its registered ticket; legacy approval omits the line", () => {
  assert.ok(renderHeader({ ...BASE_VIEW, ticket: "T-1" }).includes("ticket:  T-1"));
  assert.ok(!renderHeader(BASE_VIEW).split("\n").some((line) => line.startsWith("ticket:")));
});

const CAVEAT_LINE = "caveat: diff touches test files/config — the green-tests gate may not be independent";

test("testCaveat: true renders the coded caveat line", () => {
  const rendered = renderHeader({ ...BASE_VIEW, testCaveat: true });
  assert.ok(rendered.includes(CAVEAT_LINE), "expected the caveat line to be present");
});

test("testCaveat: false renders NO caveat line at all", () => {
  const rendered = renderHeader({ ...BASE_VIEW, testCaveat: false });
  assert.ok(!rendered.includes("caveat:"), "expected no caveat line when testCaveat is false");
});

test("the caveat line sits next to the tri-state reviewer line, both above the closing rule", () => {
  const rendered = renderHeader({
    ...BASE_VIEW,
    testCaveat: true,
    reviewerVerdict: { verdict: "approve", notes: "looks fine" },
  });
  const lines = rendered.split("\n");
  const reviewerIdx = lines.findIndex((l) => l.startsWith("advisory reviewer:"));
  const caveatIdx = lines.findIndex((l) => l.startsWith("caveat:"));
  // The closing rule is a PURE "=" line (the opening banner has text mixed
  // in, so a plain /^=+$/ match only ever hits the closing one) — found from
  // the end since it is always the LAST such line.
  let closingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^=+$/.test(lines[i])) {
      closingIdx = i;
      break;
    }
  }
  assert.ok(reviewerIdx >= 0, "expected the advisory reviewer line to render");
  assert.ok(caveatIdx >= 0, "expected the caveat line to render");
  // Adjacent (allowing one blank separator line either side) and both
  // strictly before the closing rule.
  assert.ok(Math.abs(caveatIdx - reviewerIdx) <= 2, `expected the caveat line adjacent to the reviewer line, got reviewer@${reviewerIdx} caveat@${caveatIdx}`);
  assert.ok(caveatIdx < closingIdx && reviewerIdx < closingIdx);
});

test("testCaveat is the ONLY difference between two renders otherwise identical — every other line is byte-identical", () => {
  const withCaveat = renderHeader({ ...BASE_VIEW, testCaveat: true }).split("\n");
  const withoutCaveat = renderHeader({ ...BASE_VIEW, testCaveat: false }).split("\n");
  const extraLines = withCaveat.filter((l) => !withoutCaveat.includes(l));
  // The caveat line plus its trailing blank separator are the only additions.
  assert.deepEqual(
    extraLines.filter((l) => l.trim().length > 0),
    [CAVEAT_LINE],
  );
});

test("testCaveat renders independently of reviewerVerdict's tri-state (off/unavailable/verdict all still show the caveat)", () => {
  for (const reviewerVerdict of [null, "unavailable" as const, { verdict: "concerns" as const, notes: "n" }]) {
    const rendered = renderHeader({ ...BASE_VIEW, testCaveat: true, reviewerVerdict });
    assert.ok(rendered.includes(CAVEAT_LINE), `expected the caveat line with reviewerVerdict=${JSON.stringify(reviewerVerdict)}`);
  }
});

// --- structural "does not gate" proof ------------------------------------------

test("renderHeader() is a pure string formatter — same input always produces the same output, no side effects", () => {
  const view: ApprovalView = { ...BASE_VIEW, testCaveat: true };
  const a = renderHeader(view);
  const b = renderHeader(view);
  assert.equal(a, b);
});

test("renderHeader()'s return type carries no approval verdict — it is exactly a string, never a boolean/Promise", () => {
  const rendered = renderHeader({ ...BASE_VIEW, testCaveat: true });
  assert.equal(typeof rendered, "string");
  // The eventual sha-typed prompt text ("type the commit sha exactly") is
  // built separately in approveAtBroker() from v.headSha alone — it is NOT
  // part of renderHeader()'s output at all, so testCaveat cannot reach it.
  assert.ok(!rendered.includes("type the commit sha exactly"));
});
