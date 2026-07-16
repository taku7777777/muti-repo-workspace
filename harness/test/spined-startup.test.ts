/**
 * test/spined-startup.test.ts — spined/index.ts's startSpined(): the
 * fail-closed "no ledger yet, run spine-prepare first" startup error, the
 * per-ticket lock actually blocking a second startSpined() for the same
 * ticket, and a successful start assembling the full tool table (seven
 * action tools + status) from a ledger a prior spine-prepare run seeded.
 * Uses MRW_STATE_DIR to point stateDir() at a throwaway tmp directory —
 * never touches the real tasks/ tree. Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { SpineLedger } from "../src/spine/ledger.js";
import { startSpined } from "../src/spined/index.js";

let originalStateDir: string | undefined;
let originalToken: string | undefined;
let originalApiKey: string | undefined;

before(() => {
  originalStateDir = process.env.MRW_STATE_DIR;
  originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  // startSpined()'s credential guard only checks presence, never validity —
  // safe to set an obviously-fake token for these tests (no SDK call is
  // ever made by startSpined() itself; see this file's header).
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token";
});

after(() => {
  if (originalStateDir === undefined) delete process.env.MRW_STATE_DIR;
  else process.env.MRW_STATE_DIR = originalStateDir;
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
});

function freshStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "spined-startup-test-"));
}

/** Seed a ledger exactly the way spine-prepare would, at the SAME path
 *  stateDir(root, ticket) resolves to under MRW_STATE_DIR. */
function seedLedger(stateRoot: string, ticket: string, instruction: string): void {
  const ledgerDir = path.join(stateRoot, ticket);
  const ledger = new SpineLedger(ticket, { app: { repoDir: "/tmp/app", baseSha: "base000" } }, undefined, ledgerDir);
  ledger.setInstruction(instruction);
  ledger.persist();
}

test("fails closed, naming the prepare command, when no ledger has been prepared", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  await assert.rejects(
    () => startSpined(["--ticket", "T-1"], { root: "/irrelevant" }),
    /no persisted ledger.*run 'npm run spine-prepare -- --ticket T-1'/s,
  );
});

test("a failed start (no ledger) releases the lock it took, so a retry after prepare succeeds", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  await assert.rejects(() => startSpined(["--ticket", "T-1"], { root: "/irrelevant" }));
  assert.equal(fs.existsSync(path.join(stateRoot, "T-1", "spined.lock")), false);

  seedLedger(stateRoot, "T-1", "do the thing");
  const startup = await startSpined(["--ticket", "T-1"], { root: "/irrelevant" });
  startup.lock.release();
});

test("usage error when --ticket is missing", async () => {
  await assert.rejects(() => startSpined([]), /usage: npm run spined/);
});

test("credential guard fails closed with neither credential set", async () => {
  const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  const savedKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  try {
    await assert.rejects(() => startSpined(["--ticket", "T-1"]), /No Anthropic credential|no Anthropic credential/);
  } finally {
    if (savedToken !== undefined) process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
    if (savedKey !== undefined) process.env.ANTHROPIC_API_KEY = savedKey;
  }
});

test("a successful start assembles all seven action tools plus status, and restores the persisted instruction", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  seedLedger(stateRoot, "T-2", "implement the feature");

  const startup = await startSpined(["--ticket", "T-2"], { root: "/irrelevant" });
  try {
    assert.equal(startup.ticket, "T-2");
    assert.equal(startup.ledger.getInstruction(), "implement the feature");
    const names = startup.tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "abort",
      "done",
      "plan_repo",
      "request_publish",
      "review_diff",
      "run_tests",
      "run_worker",
      "status",
    ]);
  } finally {
    startup.lock.release();
  }
});

test("a second startSpined() for the SAME ticket fails closed on the lock while the first is still running", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  seedLedger(stateRoot, "T-3", "x");

  const first = await startSpined(["--ticket", "T-3"], { root: "/irrelevant" });
  try {
    await assert.rejects(() => startSpined(["--ticket", "T-3"], { root: "/irrelevant" }), /already holds the lock/);
  } finally {
    first.lock.release();
  }

  // Now that the first has released, a fresh start succeeds again.
  const second = await startSpined(["--ticket", "T-3"], { root: "/irrelevant" });
  second.lock.release();
});

// --- load-failure advice must not suggest wiping a corrupt/invalid ledger --
// (independent review, SHOULD-FIX #2c): only "missing" (no ledger file at
// all) is safe to answer with "run spine-prepare"; a ledger that EXISTS but
// failed to load (bad JSON, wrong version/shape, wrong ticket) must be
// described honestly, without pointing at a command that would overwrite it.

test("a CORRUPT (invalid JSON) ledger's startup error does NOT suggest spine-prepare", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  const ledgerDir = path.join(stateRoot, "T-9");
  fs.mkdirSync(ledgerDir, { recursive: true });
  fs.writeFileSync(path.join(ledgerDir, "spine-ledger.json"), "{ not valid json");

  await assert.rejects(() => startSpined(["--ticket", "T-9"], { root: "/irrelevant" }), (e: Error) => {
    assert.match(e.message, /not valid JSON/);
    assert.match(e.message, /manual inspection/);
    assert.doesNotMatch(e.message, /run 'npm run spine-prepare/);
    return true;
  });
  // The failed start must still have released its lock.
  assert.equal(fs.existsSync(path.join(ledgerDir, "spined.lock")), false);
});

test("a VERSION-MISMATCHED ledger's startup error does NOT suggest spine-prepare", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  const ledgerDir = path.join(stateRoot, "T-10");
  seedLedger(stateRoot, "T-10", "x");
  const file = path.join(ledgerDir, "spine-ledger.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.version = 999;
  fs.writeFileSync(file, JSON.stringify(raw));

  await assert.rejects(() => startSpined(["--ticket", "T-10"], { root: "/irrelevant" }), (e: Error) => {
    assert.match(e.message, /does not match the expected ledger shape\/version/);
    assert.doesNotMatch(e.message, /run 'npm run spine-prepare/);
    return true;
  });
});

test("a WRONG-TICKET ledger's startup error does NOT suggest spine-prepare", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  seedLedger(stateRoot, "T-11-actual", "x");
  // Ask for a DIFFERENT ticket whose stateDir happens to collide only if we
  // seed under that name — simulate by copying the persisted file to the
  // requested ticket's own directory (same failure surface load() reports).
  const wrongDir = path.join(stateRoot, "T-11-requested");
  fs.mkdirSync(wrongDir, { recursive: true });
  fs.copyFileSync(
    path.join(stateRoot, "T-11-actual", "spine-ledger.json"),
    path.join(wrongDir, "spine-ledger.json"),
  );

  await assert.rejects(() => startSpined(["--ticket", "T-11-requested"], { root: "/irrelevant" }), (e: Error) => {
    assert.match(e.message, /is for ticket 'T-11-actual', not 'T-11-requested'/);
    assert.doesNotMatch(e.message, /run 'npm run spine-prepare/);
    return true;
  });
});

test("the MISSING-ledger case is still the ONE case that suggests spine-prepare", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  await assert.rejects(() => startSpined(["--ticket", "T-12"], { root: "/irrelevant" }), (e: Error) => {
    assert.match(e.message, /run 'npm run spine-prepare/);
    return true;
  });
});

test("two DIFFERENT tickets never contend on each other's lock", async () => {
  const stateRoot = freshStateRoot();
  process.env.MRW_STATE_DIR = stateRoot;
  seedLedger(stateRoot, "T-4", "x");
  seedLedger(stateRoot, "T-5", "y");

  const a = await startSpined(["--ticket", "T-4"], { root: "/irrelevant" });
  const b = await startSpined(["--ticket", "T-5"], { root: "/irrelevant" }); // must not throw
  a.lock.release();
  b.lock.release();
});
