/**
 * test/gitops.test.ts — gitops.ts exercised against a REAL throwaway git
 * fixture (no mocking git — the fail-closed contracts commitAll and
 * commitRangeDiff make are only meaningful against real git output). The
 * fixture repo's identity is pinned with -c on every git call this test file
 * makes itself, mirroring gitops.ts's own COMMIT_IDENTITY, so this runs on
 * CI-less environments that have no global user.name/user.email configured.
 * Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { commitAll, commitRangeDiff } from "../src/gitops.js";

const IDENTITY = ["-c", "user.name=test-fixture", "-c", "user.email=test-fixture@local"];

let repoDir: string;
let shaA: string;

function git(args: string[]): string {
  const r = spawnSync("git", ["-C", repoDir, ...IDENTITY, ...args], { encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  }
  return (r.stdout ?? "").trim();
}

before(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitops-test-"));
  git(["-c", "init.defaultBranch=main", "init", "-q"]);
  fs.writeFileSync(path.join(repoDir, "seed.txt"), "seed\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "commit A"]);
  shaA = git(["rev-parse", "HEAD"]);
});

after(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

// --- commitAll -----------------------------------------------------------------

test("commitAll on a clean tree does not commit", () => {
  const result = commitAll(repoDir, "mrw: should not happen");
  assert.equal(result.committed, false);
  assert.equal(result.headSha, shaA);
});

test("commitAll on a dirty tree commits, moves HEAD, and stamps mrw-worker identity", () => {
  fs.writeFileSync(path.join(repoDir, "new-file.txt"), "hello\n");
  const result = commitAll(repoDir, "mrw: IMPLEMENT add new-file.txt");
  assert.equal(result.committed, true);
  assert.notEqual(result.headSha, shaA);
  assert.equal(result.headSha, git(["rev-parse", "HEAD"]));
  const author = git(["log", "-1", "--format=%an"]);
  assert.equal(author, "mrw-worker");
});

// --- commitRangeDiff -------------------------------------------------------------

test("commitRangeDiff(A..HEAD) is complete and contains the new filename", () => {
  const range = commitRangeDiff(repoDir, shaA);
  assert.equal(range.complete, true);
  assert.match(range.diff, /new-file\.txt/);
});

test("commitRangeDiff with a bogus base sha is fail-closed (complete: false)", () => {
  const range = commitRangeDiff(repoDir, "0000000000000000000000000000000000000000");
  assert.equal(range.complete, false);
});
