/**
 * test/spined-prepare.test.ts — spined/prepare.ts's reseed guards
 * (independent review, SHOULD-FIX #2): refuses to reseed an existing ledger
 * without --force, and unconditionally refuses (never bypassed by --force)
 * while the ticket's lock looks like it could be held by a live daemon.
 * Both guards run BEFORE any workspace config is read or any worktree
 * touched (see prepare.ts's header), so these tests exercise them with a
 * throwaway `opts.root` that has NO config/ directory at all — reaching past
 * either guard would surface as an uncaught "ENOENT config/..." rejection,
 * which the tests below use as positive proof that a guard was bypassed
 * (rather than needing a full config/repos.json + real worktree fixture,
 * which is out of scope for testing a refusal). Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { acquireLock } from "../src/spined/lock.js";
import { prepare } from "../src/spined/prepare.js";

let originalToken: string | undefined;
let originalApiKey: string | undefined;

before(() => {
  originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  // prepare()'s credential guard only checks presence; no SDK call is ever
  // reached by these tests (both guards return before execSetupWorktree).
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
});

after(() => {
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

function freshRoot(): string {
  // Deliberately has NO config/ subdirectory — see this file's header on why
  // that is the point (proves whether a guard was reached vs. bypassed).
  return fs.mkdtempSync(path.join(os.tmpdir(), "spined-prepare-test-"));
}

function ledgerDirFor(root: string, ticket: string): string {
  // Mirrors multi/state.ts's stateDir() default (no MRW_STATE_DIR override
  // is set in this file, so prepare.ts resolves the same path).
  return path.join(root, "tasks", ticket);
}

test("refuses to reseed when a ledger already exists, without --force", async () => {
  const root = freshRoot();
  const ledgerDir = ledgerDirFor(root, "T-1");
  fs.mkdirSync(ledgerDir, { recursive: true });
  const ledgerFile = path.join(ledgerDir, "spine-ledger.json");
  fs.writeFileSync(ledgerFile, JSON.stringify({ sentinel: "do-not-touch" }));

  const code = await prepare(["--ticket", "T-1"], { root });
  assert.equal(code, 2);
  // The ledger must be completely untouched.
  assert.equal(fs.readFileSync(ledgerFile, "utf8"), JSON.stringify({ sentinel: "do-not-touch" }));
});

test("--force bypasses the ledger-exists refusal (proceeds past it to the next stage)", async () => {
  const root = freshRoot();
  const ledgerDir = ledgerDirFor(root, "T-2");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, "spine-ledger.json"), JSON.stringify({ sentinel: "old" }));

  // With --force, prepare.ts proceeds PAST the ledger-exists gate into
  // config loading — which fails for an unrelated reason (no config/ dir in
  // this throwaway root) rather than the ledger-exists message, proving the
  // gate was actually bypassed rather than coincidentally not triggering.
  await assert.rejects(
    () => prepare(["--ticket", "T-2", "--force"], { root }),
    (e: Error) => {
      assert.doesNotMatch(e.message, /already exists/);
      return true;
    },
  );
});

test("without --force, the SAME setup fails with the ledger-exists message instead (control case)", async () => {
  const root = freshRoot();
  const ledgerDir = ledgerDirFor(root, "T-3");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, "spine-ledger.json"), JSON.stringify({ sentinel: "old" }));

  const code = await prepare(["--ticket", "T-3"], { root });
  assert.equal(code, 2); // returns cleanly (never reaches the config load that would reject)
});

test("refuses UNCONDITIONALLY when the lock is held by a live pid, even with --force", async () => {
  const root = freshRoot();
  const ticket = "T-4";
  const ledgerDir = ledgerDirFor(root, ticket);
  const lock = acquireLock(ledgerDir); // our own pid — definitely live
  try {
    const code = await prepare(["--ticket", ticket, "--force"], { root });
    assert.equal(code, 2);
    // Must not have proceeded to write a ledger file.
    assert.equal(fs.existsSync(path.join(ledgerDir, "spine-ledger.json")), false);
  } finally {
    lock.release();
  }
});

test("does not refuse on a STALE (dead-pid) lock — proceeds past the lock guard", async () => {
  const root = freshRoot();
  const ticket = "T-5";
  const ledgerDir = ledgerDirFor(root, ticket);
  fs.mkdirSync(ledgerDir, { recursive: true });
  // A lock recording an impossible/definitely-dead pid.
  fs.writeFileSync(
    path.join(ledgerDir, "spined.lock"),
    JSON.stringify({ pid: 999999, startedAt: new Date().toISOString() }),
  );

  // Proceeds past the lock guard into config loading, which fails for the
  // unrelated "no config/" reason — proving the lock guard did not block it.
  await assert.rejects(() => prepare(["--ticket", ticket], { root }));
  // The stale lock file itself must be untouched — a read-only peek never
  // takes over or removes a lock (that is acquireLock()'s job, never
  // prepare.ts's).
  assert.equal(fs.existsSync(path.join(ledgerDir, "spined.lock")), true);
});

test("usage error when --ticket is missing", async () => {
  const code = await prepare([], { root: freshRoot() });
  assert.equal(code, 2);
});

test("credential guard fails closed with neither credential set", async () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    const code = await prepare(["--ticket", "T-6"], { root: freshRoot() });
    assert.equal(code, 2);
  } finally {
    if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});
