import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { isTicketRegistered } from "../src/config.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-ticket-registry-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));

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
