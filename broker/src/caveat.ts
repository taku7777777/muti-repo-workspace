/**
 * caveat.ts — the broker-computed test-independence caveat (Thread C,
 * docs/mrw-chat.md "Gate policy" + "Deliberate engine adaptations" #4).
 *
 * Under the spined path (Phase C2) the in-container y/N ack that used to
 * warn a human "this diff touches tests, the green gate may not be
 * independent" (harness/src/spine/executor.ts's request_publish, in-chat
 * policy only) is skipped for `approvalPolicy: "broker-only"` — there is no
 * terminal to ask on. So the memo moves the SAME caveat here, computed by
 * the broker on its OWN ground-truth diff (render.diff from
 * git.ts's renderGroundTruth() — never the coder's words), and rendered next
 * to the tri-state advisory-reviewer line at the SHA approval gate
 * (approve.ts). Broker-computed = unspoofable by a malicious coder, gate-
 * only (never changes the sha-typed approval semantics), and invisible to
 * the public PR body — the alternative (a caveat inside the intent body)
 * would be exactly the opposite of all three.
 *
 * This function replicates the SEMANTICS of harness/src/steps.ts's
 * diffTouchesTests() EXACTLY — the broker cannot import harness/ (separate
 * package, separate image; same reasoning as harness/src/telemetry.ts's
 * per-package duplication note). Do NOT "improve" the heuristic here: a
 * divergence would make the broker's caveat silently disagree with the
 * harness's own in-chat warning for the identical diff. Known gap (recorded
 * alongside the harness's original): a root-level bare `test.js` is not
 * matched by the test-path regex.
 */
export function diffTouchesTests(diff: string): boolean {
  const headerPaths = diff
    .split("\n")
    .filter((l) => l.startsWith("diff --git "))
    .join("\n")
    .toLowerCase();
  const testPathRe =
    /(^|\/)__tests__\/|\.test\.|\.spec\.|_test\.|(^|\/)tests?\/|\.e2e\.|(^|\/)e2e\/|vitest\.config|jest\.config|\.mocharc|playwright\.config|conftest\.py/;
  if (testPathRe.test(headerPaths)) return true;
  // package.json whose "test" script line is added/removed in the diff.
  if (/package\.json/.test(headerPaths) && /^[+-].*"test"\s*:/m.test(diff)) return true;
  return false;
}
