/**
 * test/spined-publish-integration.test.ts — proves the FULL production
 * wiring (independent review, SHOULD-FIX #3c): a request_publish dispatched
 * through the REAL executor startSpined() builds — approvalPolicy:
 * "broker-only" baked in, the REAL unreachable askHuman/say stubs (not test
 * doubles) — succeeds via publish.ts's stub path (BROKER_SOCKET unset)
 * WITHOUT ever calling askHuman/say. Unlike executor.test.ts (which builds
 * its OWN executor with hand-supplied askHuman/say fakes), this test never
 * touches spine/executor.ts directly — it only calls startSpined() (the
 * spined/index.ts entrypoint) and dispatches through startup.executor,
 * exercising the exact object graph the real daemon assembles. If
 * unreachableAskHuman/unreachableSay were ever reachable on this path, they
 * would THROW (see spined/index.ts) and this test would fail loudly rather
 * than silently pass.
 *
 * Uses a REAL throwaway git fixture repo (same pattern as executor.test.ts/
 * gitops.test.ts) since request_publish needs a real commit-range diff;
 * BROKER_SOCKET is left unset so publish.ts's deterministic, network-free
 * Phase-1 stub path is what actually gets exercised. Run: `npm test`
 * (node:test).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { SpineLedger } from "../src/spine/ledger.js";
import { startSpined } from "../src/spined/index.js";

const IDENTITY = ["-c", "user.name=test-fixture", "-c", "user.email=test-fixture@local"];

let repoDir: string;
let shaA: string;
let shaB: string;
let originalBrokerSocket: string | undefined;
let originalToken: string | undefined;
let originalApiKey: string | undefined;
let originalStateDir: string | undefined;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoDir, ...IDENTITY, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return (r.stdout ?? "").trim();
}

before(() => {
  originalBrokerSocket = process.env.BROKER_SOCKET;
  delete process.env.BROKER_SOCKET; // publish.ts's stub path — no network, deterministic
  originalToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "test-token"; // startSpined()'s credential guard only checks presence
  originalApiKey = process.env.ANTHROPIC_API_KEY;
  originalStateDir = process.env.MRW_STATE_DIR;

  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "spined-publish-integration-"));
  git(["-c", "init.defaultBranch=main", "init", "-q"]);
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit A"]);
  shaA = git(["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(repoDir, "src.ts"), "export const x = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit B (simulated worker run)"]);
  shaB = git(["rev-parse", "HEAD"]);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
  if (originalBrokerSocket === undefined) delete process.env.BROKER_SOCKET;
  else process.env.BROKER_SOCKET = originalBrokerSocket;
  if (originalToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalToken;
  if (originalApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = originalApiKey;
  if (originalStateDir === undefined) delete process.env.MRW_STATE_DIR;
  else process.env.MRW_STATE_DIR = originalStateDir;
});

test("request_publish through the REAL startSpined()-built executor succeeds via the stub path, never invoking askHuman/say", async () => {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "spined-publish-integration-state-"));
  process.env.MRW_STATE_DIR = stateRoot;
  const ticket = "T-1";

  // Seed the ledger exactly the way spine-prepare would, publish-ready:
  // plan + green tests + approving review, all attesting the CURRENT head.
  const ledgerDir = path.join(stateRoot, ticket);
  const ledger = new SpineLedger(ticket, { app: { repoDir, baseSha: shaA } }, undefined, ledgerDir);
  ledger.recordWorkerRun("app", { committed: true, headSha: shaB });
  ledger.recordPlan("app", { summary: "do the thing", steps: ["step 1"], risks: [], ready_to_implement: true });
  ledger.recordTests("app", true, shaB);
  ledger.recordReview("app", { verdict: "approve", findings: [], summary: "looks good" }, shaB);
  ledger.setInstruction("implement the thing");
  ledger.persist();

  const startup = await startSpined(["--ticket", ticket], { root: "/irrelevant" });
  try {
    // The REAL executor startSpined() assembled — approvalPolicy:
    // "broker-only" and the unreachable askHuman/say stubs are baked in
    // here, not supplied by this test.
    const result = await startup.executor.dispatch({ action: "request_publish", repo: "app" });

    // If askHuman/say had been reachable, they would have THROWN (see
    // spined/index.ts's unreachableAskHuman/unreachableSay) and this
    // dispatch would have rejected instead of resolving cleanly — so a
    // clean {ok:true, published:false, note:"stub..."} result IS the proof
    // that no ask happened on this path.
    assert.deepEqual(result, {
      ok: true,
      published: false,
      note: "stub (BROKER_SOCKET unset) — nothing pushed",
    });
  } finally {
    startup.lock.release();
  }
});

test("the SAME publish-ready ledger, dispatched via a hand-built in-chat executor, WOULD ask (control case)", async () => {
  // Sanity control: proves the fixture itself is publish-ready and that
  // "no ask happened" above is specific to broker-only, not an artifact of
  // the fixture never reaching the human-approval block at all.
  const { createExecutor } = await import("../src/spine/executor.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spined-publish-integration-control-"));
  const ledger = new SpineLedger("T-2", { app: { repoDir, baseSha: shaA } }, undefined, dir);
  ledger.recordWorkerRun("app", { committed: true, headSha: shaB });
  ledger.recordPlan("app", { summary: "do the thing", steps: ["step 1"], risks: [], ready_to_implement: true });
  ledger.recordTests("app", true, shaB);
  ledger.recordReview("app", { verdict: "approve", findings: [], summary: "looks good" }, shaB);

  let asked = false;
  const executor = createExecutor({
    ledger,
    instruction: "x",
    askHuman: async () => {
      asked = true;
      return "y";
    },
    say: () => {},
    // approvalPolicy defaults to "in-chat" here — deliberately NOT broker-only.
  });
  await executor.dispatch({ action: "request_publish", repo: "app" });
  assert.equal(asked, true, "expected the in-chat control case to actually ask");
});
