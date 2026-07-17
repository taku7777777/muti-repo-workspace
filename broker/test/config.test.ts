import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-ticket-registry-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

// Env BEFORE the dynamic import — config.ts binds its roots at module load
// (same pattern as handler.test.ts). Keeps the coder-writable-tree test out
// of the real workspace's tasks/.
process.env.BROKER_TASKS_DIR = path.join(root, "tasks");
const { TASKS_ROOT, isTicketRegistered } = await import("../src/config.js");

test("isTicketRegistered requires an exact regular-file entry", () => {
  fs.writeFileSync(path.join(root, "ETE-1"), "content is deliberately irrelevant");
  fs.mkdirSync(path.join(root, "DIR-1"));
  assert.equal(isTicketRegistered("ETE-1", root), true);
  assert.equal(isTicketRegistered("ete-1", root), false, "case aliases must not authorize");
  assert.equal(isTicketRegistered("NOPE-1", root), false);
  assert.equal(isTicketRegistered("DIR-1", root), false);
});

test("isTicketRegistered rejects symlinks, invalid names, and missing directories", () => {
  fs.symlinkSync(path.join(root, "ETE-1"), path.join(root, "LINK-1"));
  assert.equal(isTicketRegistered("LINK-1", root), false);
  assert.equal(isTicketRegistered("../ETE-1", root), false);
  assert.equal(isTicketRegistered("ETE-1", path.join(root, "missing")), false);
});

test("isTicketRegistered refuses a registry dir inside a coder-writable tree (F2-style)", () => {
  // A registry under TASKS_ROOT would hand the routing kill-switch to the
  // coder — even a matching, regular-file entry must NOT authorize.
  const inTasks = path.join(TASKS_ROOT, "EVIL-1", "registry");
  fs.mkdirSync(inTasks, { recursive: true });
  fs.writeFileSync(path.join(inTasks, "ETE-1"), "");
  try {
    assert.equal(isTicketRegistered("ETE-1", inTasks), false);
  } finally {
    fs.rmSync(path.join(TASKS_ROOT, "EVIL-1"), { recursive: true, force: true });
  }
});
