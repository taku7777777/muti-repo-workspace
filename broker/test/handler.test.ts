import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-handler-routing-"));
const coder = path.join(root, "coder");
const tasks = path.join(coder, "tasks");
const tickets = path.join(root, "tickets");
const legacy = path.join(coder, "repositories");
const policy = path.join(root, "policy.json");
fs.mkdirSync(tickets, { recursive: true });
fs.mkdirSync(tasks, { recursive: true });
fs.mkdirSync(legacy, { recursive: true });
fs.writeFileSync(policy, JSON.stringify({ branch_prefix: "feat/", allowed_push_orgs: [] }));
process.env.BROKER_CODER_TREE = coder;
process.env.BROKER_TASKS_DIR = tasks;
process.env.BROKER_TICKETS_DIR = tickets;
process.env.BROKER_WORKTREES_DIR = legacy;
process.env.BROKER_POLICY_FILE = policy;

const imported = await import("../src/handler.js");
const { handleRequest, resolveRoutedWorktree } = imported;
const request = { repo: "app", branch: "feat/T-1", title: "title", body: "body" };

after(() => fs.rmSync(root, { recursive: true, force: true }));

test("unregistered routed ticket fails before an absent worktree can be observed", async () => {
  const res = await handleRequest({ ...request, ticket: "T-1" });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "ticket_not_registered");
});

test("routed resolver enforces lexical containment", () => {
  assert.equal(resolveRoutedWorktree("T-1", "app", tasks), path.join(tasks, "T-1", "repositories", "app"));
  assert.equal(resolveRoutedWorktree("T-1", "../escape", tasks), null);
  // The TICKET segment is contained in-function too (defense in depth — the
  // function must not rely on callers having registry-validated it first).
  assert.equal(resolveRoutedWorktree("../escape", "app", tasks), null);
  assert.equal(resolveRoutedWorktree(".", "app", tasks), null);
  assert.equal(resolveRoutedWorktree("a/b", "app", tasks), null);
});

test("routed branch is bound exactly to branch_prefix + ticket", async () => {
  fs.writeFileSync(path.join(tickets, "T-1"), "");
  const wt = path.join(tasks, "T-1", "repositories", "app");
  fs.mkdirSync(wt, { recursive: true });
  // Isolate from the developer's real git config — a machine-global
  // commit.gpgsign=true (or similar) must not fail the suite.
  const git = (args: string[]) =>
    spawnSync("git", args, {
      cwd: wt,
      encoding: "utf8",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  assert.equal(git(["init", "-b", "feat/OTHER"]).status, 0);
  fs.writeFileSync(path.join(wt, "README.md"), "x\n");
  assert.equal(git(["add", "README.md"]).status, 0);
  assert.equal(git(["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-m", "init"]).status, 0);
  const res = await handleRequest({ ...request, ticket: "T-1" });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, "branch_mismatch");
    assert.match(res.error, /expected 'feat\/T-1'/);
  }
});

test("legacy request still uses BROKER_WORKTREES_DIR and its prior missing-worktree result", async () => {
  const res = await handleRequest(request);
  assert.deepEqual(res, {
    ok: false,
    code: "worktree_missing",
    error: `no worktree for 'app' under ${legacy}`,
  });
});
