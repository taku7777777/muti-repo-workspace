/**
 * test/spined-lock.test.ts — spined/lock.ts's per-ticket single-instance
 * guard: fresh acquire, live-pid contention (fail closed), dead-pid takeover
 * (stale lock), a corrupt lock file (fail closed — never guess),
 * release()'s idempotence/ownership check, the read-only isLockPotentiallyLive
 * peek (prepare.ts's reseed guard), and BOTH interleavings of the atomic
 * takeover race (independent review, SHOULD-FIX #1 — see lock.ts's header).
 * No SDK import at all — lock.ts is plain fs + process.kill. Run: `npm test`
 * (node:test).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { acquireLock, isLockPotentiallyLive, takeOverStaleLock } from "../src/spined/lock.js";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spined-lock-test-"));
}

function lockFile(dir: string): string {
  return path.join(dir, "spined.lock");
}

/** Spawn and immediately reap a short-lived child process, returning a pid
 *  that is GUARANTEED dead by the time this function returns — used to
 *  fabricate a stale lock without any timing races. */
function deadPid(): number {
  const r = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
  const pid = r.pid;
  if (!pid) throw new Error("failed to spawn a throwaway process to obtain a dead pid");
  return pid;
}

test("acquireLock() creates a fresh lockfile recording our own pid", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  const raw = JSON.parse(fs.readFileSync(lockFile(dir), "utf8"));
  assert.equal(raw.pid, process.pid);
  lock.release();
});

test("a second acquireLock() in the same dir fails closed while our own (live) pid holds it", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /already holds the lock/);
  lock.release();
});

test("release() removes the lockfile, allowing a subsequent acquireLock() to succeed", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  assert.equal(fs.existsSync(lockFile(dir)), true);
  lock.release();
  assert.equal(fs.existsSync(lockFile(dir)), false);
  const lock2 = acquireLock(dir); // must not throw
  lock2.release();
});

test("release() is idempotent — calling it twice does not throw", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  lock.release();
  assert.doesNotThrow(() => lock.release());
});

test("a lockfile whose pid is definitely dead is taken over (stale lock)", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));

  const lock = acquireLock(dir); // must NOT throw — takes over the stale lock
  const raw = JSON.parse(fs.readFileSync(lockFile(dir), "utf8"));
  assert.equal(raw.pid, process.pid); // now ours
  lock.release();
});

test("a corrupt/unreadable lockfile fails closed rather than being taken over", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), "{ not json at all");
  assert.throws(() => acquireLock(dir), /unreadable\/corrupt/);
});

test("a lockfile with a non-numeric pid field fails closed rather than being taken over", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: "not-a-number" }));
  assert.throws(() => acquireLock(dir), /unreadable\/corrupt/);
});

test("release() only removes the lockfile if it still records OUR pid (defense in depth)", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  // Simulate another process having taken over the lock in the meantime
  // (e.g. this process was slow to release after a crash-and-restart race).
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  lock.release();
  // The lockfile (now owned by the "other" pid) must still be there.
  assert.equal(fs.existsSync(lockFile(dir)), true);
});

test("acquireLock() creates the ledger dir if it does not exist yet", () => {
  const parent = tmpDir();
  const dir = path.join(parent, "nested", "ticket-dir");
  assert.equal(fs.existsSync(dir), false);
  const lock = acquireLock(dir);
  assert.equal(fs.existsSync(dir), true);
  lock.release();
});

// --- TOCTOU fix: atomic stale-lock takeover (independent review, SHOULD-FIX #1) --
// Real OS-level concurrency can't be deterministically produced in a single
// Node process, so these tests exercise takeOverStaleLock() directly against
// BOTH outcomes its one atomic primitive (fs.renameSync) can produce — the
// exact two interleavings the review named: "A wins the rename" and "B's
// rename loses because A already claimed it". acquireLock()'s own stale
// branch is a two-line call straight into this function (see lock.ts), so
// testing the primitive's both outcomes directly is testing the real fix.

test("takeOverStaleLock() wins on a genuinely stale lock: the original path is gone, no leftover trace remains", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));

  assert.doesNotThrow(() => takeOverStaleLock(file));
  assert.equal(fs.existsSync(file), false); // safe for the caller to tryCreate() next
  const leftovers = fs.readdirSync(dir).filter((f) => f.startsWith("spined.lock.stale-"));
  assert.deepEqual(leftovers, [], "the renamed-away stale file must be cleaned up, not left behind");
});

test("takeOverStaleLock() fails closed with 'lost the race' when the target no longer exists", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir); // never created — simulates "someone else already renamed it away"
  assert.throws(() => takeOverStaleLock(file), /lost the race/);
});

test("both interleavings together: of two racers taking over the SAME stale lock, exactly one wins and the loser creates nothing", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = lockFile(dir);
  fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));

  // Racer A wins.
  assert.doesNotThrow(() => takeOverStaleLock(file));
  assert.equal(fs.existsSync(file), false);

  // Racer B's attempt against the SAME path — exactly what B observes if A's
  // rename had won a moment earlier in a true concurrent race. B must fail
  // closed HERE, never falling through to create a competing lock file of
  // its own (that fallback is precisely the bug this fix removes).
  assert.throws(() => takeOverStaleLock(file), /lost the race/);
  assert.equal(fs.existsSync(file), false, "the loser must not have created anything at the lock path");
});

test("acquireLock() end-to-end still succeeds via the atomic takeover path for a genuinely stale lock", () => {
  // Re-confirms the existing stale-takeover behavior still holds through the
  // new atomic code path (not just the extracted primitive above).
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  const lock = acquireLock(dir);
  const raw = JSON.parse(fs.readFileSync(lockFile(dir), "utf8"));
  assert.equal(raw.pid, process.pid);
  lock.release();
});

test("a live-pid 'already holds the lock' error mentions the recycled-pid possibility (NIT #7)", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  assert.throws(() => acquireLock(dir), /recycled/i);
  lock.release();
});

// --- isLockPotentiallyLive() — the read-only peek prepare.ts's reseed guard uses --

test("isLockPotentiallyLive() is false when no lock file exists", () => {
  const dir = tmpDir();
  assert.equal(isLockPotentiallyLive(dir), false);
});

test("isLockPotentiallyLive() is true while our own (live) pid holds the lock", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  assert.equal(isLockPotentiallyLive(dir), true);
  lock.release();
});

test("isLockPotentiallyLive() is false for a lock recording a definitely-dead pid (safe to reseed)", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), JSON.stringify({ pid: deadPid(), startedAt: new Date().toISOString() }));
  assert.equal(isLockPotentiallyLive(dir), false);
});

test("isLockPotentiallyLive() is true (conservative) for a corrupt/unreadable lock file", () => {
  const dir = tmpDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockFile(dir), "{ not json at all");
  assert.equal(isLockPotentiallyLive(dir), true);
});

test("isLockPotentiallyLive() never mutates the lock file (read-only peek)", () => {
  const dir = tmpDir();
  const lock = acquireLock(dir);
  const before = fs.readFileSync(lockFile(dir), "utf8");
  isLockPotentiallyLive(dir);
  const after = fs.readFileSync(lockFile(dir), "utf8");
  assert.equal(after, before);
  lock.release();
});
