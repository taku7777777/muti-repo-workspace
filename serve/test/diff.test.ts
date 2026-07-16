/**
 * diff.test.ts — fixtures for every git diff shape src/diff.ts's parser has
 * to handle (implementation contract §3, "Tests": "diff-parser fixtures
 * (add/delete/rename/binary/mode/quoted paths/multi-hunk/no-newline)").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseUnifiedDiff } from "../src/diff.js";

test("simple modify: single hunk, additions/deletions counted", () => {
  const diff = [
    "diff --git a/src/foo.ts b/src/foo.ts",
    "index e69de29..4b825dc 100644",
    "--- a/src/foo.ts",
    "+++ b/src/foo.ts",
    "@@ -1,3 +1,4 @@",
    " line1",
    "-line2",
    "+line2 modified",
    "+line3 added",
    " line4",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.files.length, 1);
  const f = parsed.files[0];
  assert.equal(f.oldPath, "src/foo.ts");
  assert.equal(f.newPath, "src/foo.ts");
  assert.equal(f.status, "modified");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
  assert.equal(f.hunks.length, 1);
  assert.equal(parsed.additions, 2);
  assert.equal(parsed.deletions, 1);

  const lines = f.hunks[0].lines;
  assert.deepEqual(
    lines.map((l) => l.type),
    ["context", "del", "add", "add", "context"],
  );
  // context line numbering advances both sides; add/del only their own side.
  assert.equal(lines[0].oldNo, 1);
  assert.equal(lines[0].newNo, 1);
  assert.equal(lines[1].oldNo, 2);
  assert.equal(lines[1].newNo, null);
  assert.equal(lines[2].oldNo, null);
  assert.equal(lines[2].newNo, 2);
});

test("new file: oldPath null, status added, new file mode captured", () => {
  const diff = [
    "diff --git a/new.txt b/new.txt",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/new.txt",
    "@@ -0,0 +1,2 @@",
    "+hello",
    "+world",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.status, "added");
  assert.equal(f.oldPath, null);
  assert.equal(f.newPath, "new.txt");
  assert.equal(f.newMode, "100644");
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 0);
});

test("deleted file: newPath null, status deleted, deleted file mode captured", () => {
  const diff = [
    "diff --git a/old.txt b/old.txt",
    "deleted file mode 100644",
    "index e69de29..0000000",
    "--- a/old.txt",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-bye",
    "-world",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.status, "deleted");
  assert.equal(f.oldPath, "old.txt");
  assert.equal(f.newPath, null);
  assert.equal(f.oldMode, "100644");
  assert.equal(f.deletions, 2);
});

test("rename with similarity < 100%: content hunk still parsed", () => {
  const diff = [
    "diff --git a/src/old-name.ts b/src/new-name.ts",
    "similarity index 92%",
    "rename from src/old-name.ts",
    "rename to src/new-name.ts",
    "index abc1234..def5678 100644",
    "--- a/src/old-name.ts",
    "+++ b/src/new-name.ts",
    "@@ -1,2 +1,2 @@",
    " unchanged",
    "-old line",
    "+new line",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.status, "renamed");
  assert.equal(f.similarity, 92);
  assert.equal(f.oldPath, "src/old-name.ts");
  assert.equal(f.newPath, "src/new-name.ts");
  assert.equal(f.hunks.length, 1);
});

test("pure rename (100% similarity): no hunks, no textual change", () => {
  const diff = ["diff --git a/a.txt b/b.txt", "similarity index 100%", "rename from a.txt", "rename to b.txt", ""].join(
    "\n",
  );
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.status, "renamed");
  assert.equal(f.similarity, 100);
  assert.equal(f.hunks.length, 0);
  assert.equal(f.additions, 0);
  assert.equal(f.deletions, 0);
});

test("mode-only change: no rename, path recovered from the diff --git line fallback", () => {
  const diff = ["diff --git a/script.sh b/script.sh", "old mode 100644", "new mode 100755", ""].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.status, "modified");
  assert.equal(f.oldPath, "script.sh");
  assert.equal(f.newPath, "script.sh");
  assert.equal(f.oldMode, "100644");
  assert.equal(f.newMode, "100755");
  assert.equal(f.hunks.length, 0);
});

test("binary file: isBinary true, paths recovered from the Binary files line", () => {
  const diff = [
    "diff --git a/image.png b/image.png",
    "index 1234567..89abcde 100644",
    "Binary files a/image.png and b/image.png differ",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.isBinary, true);
  assert.equal(f.oldPath, "image.png");
  assert.equal(f.newPath, "image.png");
  assert.equal(f.hunks.length, 0);
});

test("binary new file: /dev/null on the old side", () => {
  const diff = [
    "diff --git a/logo.png b/logo.png",
    "new file mode 100644",
    "index 0000000..1234567",
    "Binary files /dev/null and b/logo.png differ",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.isBinary, true);
  assert.equal(f.status, "added");
  assert.equal(f.oldPath, null);
  assert.equal(f.newPath, "logo.png");
});

test("quoted path with spaces", () => {
  const diff = [
    'diff --git "a/my file.txt" "b/my file.txt"',
    "index e69de29..4b825dc 100644",
    '--- "a/my file.txt"',
    '+++ "b/my file.txt"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.oldPath, "my file.txt");
  assert.equal(f.newPath, "my file.txt");
});

test("quoted path with octal-escaped unicode bytes decodes to the original UTF-8 name", () => {
  // "日本語.txt" as git renders it with core.quotePath's default octal escaping.
  const quoted = '"a/\\346\\227\\245\\346\\234\\254\\350\\252\\236.txt"';
  const quotedB = quoted.replace(/^"a\//, '"b/');
  const diff = [
    `diff --git ${quoted} ${quotedB}`,
    "index e69de29..4b825dc 100644",
    `--- ${quoted}`,
    `+++ ${quotedB}`,
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.oldPath, "日本語.txt");
  assert.equal(f.newPath, "日本語.txt");
});

test("multi-hunk file", () => {
  const diff = [
    "diff --git a/multi.txt b/multi.txt",
    "index 1111111..2222222 100644",
    "--- a/multi.txt",
    "+++ b/multi.txt",
    "@@ -1,3 +1,3 @@",
    " a",
    "-b",
    "+B",
    " c",
    "@@ -10,2 +10,3 @@",
    " x",
    "+y",
    " z",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  assert.equal(f.hunks.length, 2);
  assert.equal(f.hunks[0].oldStart, 1);
  assert.equal(f.hunks[1].oldStart, 10);
  assert.equal(f.additions, 2);
  assert.equal(f.deletions, 1);
});

test("no-newline-at-end-of-file markers attach to the immediately preceding line", () => {
  const diff = [
    "diff --git a/nonl.txt b/nonl.txt",
    "index 1111111..2222222 100644",
    "--- a/nonl.txt",
    "+++ b/nonl.txt",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");
  const f = parseUnifiedDiff(diff).files[0];
  const lines = f.hunks[0].lines;
  assert.equal(lines.length, 2);
  assert.equal(lines[0].type, "del");
  assert.equal(lines[0].noNewlineAtEnd, true);
  assert.equal(lines[1].type, "add");
  assert.equal(lines[1].noNewlineAtEnd, true);
});

test("multiple files in one diff are each parsed independently", () => {
  const diff = [
    "diff --git a/one.txt b/one.txt",
    "index 1111111..2222222 100644",
    "--- a/one.txt",
    "+++ b/one.txt",
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/two.txt b/two.txt",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/two.txt",
    "@@ -0,0 +1 @@",
    "+c",
    "",
  ].join("\n");
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.files.length, 2);
  assert.equal(parsed.files[0].newPath, "one.txt");
  assert.equal(parsed.files[1].newPath, "two.txt");
  assert.equal(parsed.files[1].status, "added");
});

test("empty diff text yields no files", () => {
  const parsed = parseUnifiedDiff("");
  assert.deepEqual(parsed.files, []);
  assert.equal(parsed.additions, 0);
  assert.equal(parsed.deletions, 0);
});
