/**
 * test/spined-stdio-guard.test.ts — spined/stdio-guard.ts's
 * redirectStdoutWrites(): the piece of guardStdoutForMcp() that is
 * unit-testable without touching a real file descriptor (guardStdoutForMcp()
 * itself opens fd 1 directly via fs.createWriteStream and is exercised only
 * by actually running the daemon — out of scope for a unit test). Confirms
 * console.log and a direct process.stdout.write() call are both rerouted
 * through the injected sink, and that restore() puts both back exactly as
 * they were. Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { redirectStdoutWrites } from "../src/spined/stdio-guard.js";

test("console.log is rerouted through the sink while active", () => {
  const originalLog = console.log;
  const chunks: string[] = [];
  const handle = redirectStdoutWrites((c) => chunks.push(c));
  try {
    console.log("hello", "world");
    assert.deepEqual(chunks, ["hello world\n"]);
  } finally {
    handle.restore();
  }
  assert.equal(console.log, originalLog);
});

test("a direct process.stdout.write() call is rerouted through the sink while active", () => {
  const originalWrite = process.stdout.write;
  const chunks: string[] = [];
  const handle = redirectStdoutWrites((c) => chunks.push(c));
  try {
    const ok = process.stdout.write("raw bytes\n");
    assert.equal(ok, true); // never reports backpressure — see stdio-guard.ts
    assert.deepEqual(chunks, ["raw bytes\n"]);
  } finally {
    handle.restore();
  }
  assert.equal(process.stdout.write, originalWrite);
});

test("a process.stdout.write() callback still fires exactly once", () => {
  const handle = redirectStdoutWrites(() => {});
  let calls = 0;
  try {
    process.stdout.write("x", () => {
      calls++;
    });
  } finally {
    handle.restore();
  }
  assert.equal(calls, 1);
});

test("restore() stops rerouting — subsequent writes never reach the old sink", () => {
  const chunks: string[] = [];
  const handle = redirectStdoutWrites((c) => chunks.push(c));
  handle.restore();
  // Both calls below go to the REAL stdout now (visible in the test's own
  // TAP output, which is expected and harmless) — the assertion is only
  // that our sink saw nothing further.
  console.log("after restore");
  process.stdout.write("after restore too\n");
  assert.deepEqual(chunks, []);
});

test("restore() is safe to call even if console.log/process.stdout.write were reassigned again after activation", () => {
  const handle = redirectStdoutWrites(() => {});
  const duringOverride = () => {};
  console.log = duringOverride; // simulate something else reassigning it mid-flight
  handle.restore();
  // restore() unconditionally puts back the ORIGINAL functions captured at
  // activation time, so this assigned-over version is discarded — documented
  // behavior, not a bug: spined only ever activates the guard once per process.
  assert.notEqual(console.log, duringOverride);
});
