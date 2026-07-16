/**
 * diff.ts — a unified-diff parser for the broker-rendered `ApprovalView.diff`
 * string (git's own `git diff`/`git format-patch` output — see
 * broker/src/git.ts's renderGroundTruth()). serve has NO repo access of its
 * own: this parser only structures the bytes the broker already rendered,
 * never re-derives or expands them (implementation contract §5 "no
 * context-expansion in diffs").
 *
 * Every string this produces (paths, hunk headers, line text) is exactly as
 * UNTRUSTED as the raw `diff` field it came from — the broker is trusted
 * infrastructure, but the diff CONTENT is the coder's own commits. Nothing in
 * this file escapes anything; it only structures. Escaping happens at the
 * render boundary (src/html.ts, assets/app.js) — never here.
 *
 * assets/app.js re-implements this same algorithm in plain JS for the
 * browser (no build step ships this .ts file to a client). That duplication
 * is deliberate, the same posture the rest of the repo takes at process
 * boundaries: broker/src/reviewer.ts re-declares reviewer/src/types.ts's
 * wire shape rather than importing it. Keep the two in sync by hand when
 * either changes; the fixtures in test/diff.test.ts pin the TS side's
 * behavior precisely enough that a port can be checked against them.
 *
 * Deliberately NOT handled (out of scope, no git diff we render ever
 * produces these): combined/octopus-merge diff format (`diff --cc`), and
 * literal `GIT binary patch` bodies (we only need to know a file IS binary,
 * never decode the patch — see `renderGroundTruth`, which never asks git for
 * binary patch bodies).
 */

export type DiffLineType = "context" | "add" | "del";

export interface DiffLine {
  type: DiffLineType;
  oldNo: number | null;
  newNo: number | null;
  text: string; // raw line content, WITHOUT the leading ' '/'+'/'-' marker
  noNewlineAtEnd?: true; // this line was immediately followed by git's "\ No newline at end of file"
}

export interface DiffHunk {
  header: string; // the raw "@@ -a,b +c,d @@ trailing context" line, verbatim
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export type DiffFileStatus = "added" | "deleted" | "renamed" | "copied" | "modified";

export interface DiffFile {
  oldPath: string | null; // null when this file did not exist before (added) — /dev/null side
  newPath: string | null; // null when this file no longer exists after (deleted) — /dev/null side
  status: DiffFileStatus;
  similarity: number | null; // rename/copy "similarity index NN%", else null
  oldMode: string | null;
  newMode: string | null;
  isBinary: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface ParsedDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
}

// --- git's quoted-path C-string decoding ------------------------------------
//
// Git quotes a path (wraps it in "...") whenever it contains characters
// core.quotePath considers "unusual" — by default that includes any
// non-ASCII byte (each such byte rendered as a \NNN octal escape) as well as
// the ASCII control/escape characters below. We decode into a raw BYTE
// array first (git's octal escapes are per-BYTE, not per-codepoint) and
// UTF-8-decode only once at the end, so multi-byte sequences split across
// several \NNN escapes reassemble correctly.

function findClosingQuote(s: string, openAt: number): number {
  for (let i = openAt + 1; i < s.length; i++) {
    if (s[i] === "\\") {
      i++; // skip the escaped char, whatever it is
      continue;
    }
    if (s[i] === '"') return i;
  }
  return -1;
}

function unquoteGitPath(raw: string): string {
  const s = raw.trim();
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const inner = s.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\" && i + 1 < inner.length) {
      const n = inner[i + 1];
      const simple: Record<string, number> = {
        n: 0x0a,
        t: 0x09,
        '"': 0x22,
        "\\": 0x5c,
        a: 0x07,
        b: 0x08,
        f: 0x0c,
        v: 0x0b,
        r: 0x0d,
      };
      if (n in simple) {
        bytes.push(simple[n]);
        i++;
        continue;
      }
      if (n >= "0" && n <= "7") {
        let oct = "";
        let j = i + 1;
        while (j < inner.length && oct.length < 3 && inner[j] >= "0" && inner[j] <= "7") {
          oct += inner[j];
          j++;
        }
        bytes.push(parseInt(oct, 8) & 0xff);
        i = j - 1;
        continue;
      }
      // Unrecognized escape — keep the literal char rather than dropping data.
      bytes.push(n.charCodeAt(0));
      i++;
      continue;
    }
    const codepoint = c.codePointAt(0) ?? 0;
    if (codepoint < 0x80) {
      bytes.push(codepoint);
    } else {
      for (const b of Buffer.from(c, "utf8")) bytes.push(b);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function stripAbPrefix(p: string): string {
  return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
}

/** Parse a `--- <path>` / `+++ <path>` value: `/dev/null` -> null, else the
 *  unquoted path with its synthetic a/ or b/ prefix stripped. */
function parseAbPathToken(token: string): string | null {
  const t = token.trim();
  if (t === "/dev/null") return null;
  return stripAbPrefix(unquoteGitPath(t));
}

/** Best-effort fallback path extraction from the `diff --git a/X b/Y` line
 *  itself, used ONLY when nothing more precise (---/+++/rename/copy lines)
 *  was present — i.e. pure mode-change diffs, which by construction are
 *  never renames, so old and new paths are always equal. That equality is
 *  exactly what disambiguates the split point for paths containing spaces. */
function parseDiffGitLine(line: string): { a: string; b: string } | null {
  const prefix = "diff --git ";
  if (!line.startsWith(prefix)) return null;
  const rest = line.slice(prefix.length);
  if (rest.startsWith('"')) {
    const aEnd = findClosingQuote(rest, 0);
    if (aEnd < 0) return null;
    const aTok = rest.slice(0, aEnd + 1);
    const bTok = rest.slice(aEnd + 1).trim();
    return { a: stripAbPrefix(unquoteGitPath(aTok)), b: stripAbPrefix(unquoteGitPath(bTok)) };
  }
  const marker = " b/";
  let from = 0;
  while (true) {
    const idx = rest.indexOf(marker, from);
    if (idx < 0) break;
    const aTok = rest.slice(0, idx);
    const bTok = rest.slice(idx + 1);
    if (aTok.startsWith("a/") && aTok.slice(2) === bTok.slice(2)) {
      return { a: aTok.slice(2), b: bTok.slice(2) };
    }
    from = idx + 1;
  }
  // No equal-halves split found (should not happen for a non-rename) — take
  // the first " b/" split as a best-effort, accepting the known ambiguity.
  const idx = rest.indexOf(marker);
  if (idx < 0) return null;
  const aTok = rest.slice(0, idx);
  const bTok = rest.slice(idx + 1);
  return {
    a: aTok.startsWith("a/") ? aTok.slice(2) : aTok,
    b: bTok.startsWith("b/") ? bTok.slice(2) : bTok,
  };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

interface Draft {
  diffGitLine: string;
  oldPath: string | null | undefined; // undefined = not yet seen from a --- /rename/copy line
  newPath: string | null | undefined;
  oldMode: string | null;
  newMode: string | null;
  similarity: number | null;
  isBinary: boolean;
  isRename: boolean;
  isCopy: boolean;
  isNewFile: boolean;
  isDeletedFile: boolean;
  hunks: DiffHunk[];
}

function newDraft(diffGitLine: string): Draft {
  return {
    diffGitLine,
    oldPath: undefined,
    newPath: undefined,
    oldMode: null,
    newMode: null,
    similarity: null,
    isBinary: false,
    isRename: false,
    isCopy: false,
    isNewFile: false,
    isDeletedFile: false,
    hunks: [],
  };
}

function finalizeDraft(d: Draft): DiffFile {
  let oldPath = d.oldPath ?? null;
  let newPath = d.newPath ?? null;
  if (d.oldPath === undefined && d.newPath === undefined) {
    // Nothing more precise ever showed up (pure mode-change diff) — fall
    // back to the diff --git line itself.
    const fallback = parseDiffGitLine(d.diffGitLine);
    if (fallback) {
      oldPath = fallback.a;
      newPath = fallback.b;
    }
  }

  let status: DiffFileStatus = "modified";
  if (d.isRename) status = "renamed";
  else if (d.isCopy) status = "copied";
  else if (d.isNewFile || (oldPath === null && newPath !== null)) status = "added";
  else if (d.isDeletedFile || (newPath === null && oldPath !== null)) status = "deleted";

  let additions = 0;
  let deletions = 0;
  for (const h of d.hunks) {
    for (const l of h.lines) {
      if (l.type === "add") additions++;
      else if (l.type === "del") deletions++;
    }
  }

  return {
    oldPath,
    newPath,
    status,
    similarity: d.similarity,
    oldMode: d.oldMode,
    newMode: d.newMode,
    isBinary: d.isBinary,
    additions,
    deletions,
    hunks: d.hunks,
  };
}

export function parseUnifiedDiff(text: string): ParsedDiff {
  const files: DiffFile[] = [];
  if (text.length === 0) return { files, additions: 0, deletions: 0 };

  // Strip a lone trailing '\r' per line (CRLF-tolerant) without collapsing
  // intentional blank lines.
  const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

  let draft: Draft | null = null;
  let hunk: DiffHunk | null = null;

  const flushHunk = () => {
    if (hunk && draft) {
      draft.hunks.push(hunk);
      hunk = null;
    }
  };
  const flushDraft = () => {
    flushHunk();
    if (draft) files.push(finalizeDraft(draft));
    draft = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushDraft();
      draft = newDraft(line);
      continue;
    }
    if (!draft) continue; // ignore any preamble before the first diff --git

    if (line.startsWith("old mode ")) {
      draft.oldMode = line.slice("old mode ".length).trim();
      continue;
    }
    if (line.startsWith("new mode ")) {
      draft.newMode = line.slice("new mode ".length).trim();
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      draft.isDeletedFile = true;
      draft.oldMode = line.slice("deleted file mode ".length).trim();
      draft.newPath = null;
      continue;
    }
    if (line.startsWith("new file mode ")) {
      draft.isNewFile = true;
      draft.newMode = line.slice("new file mode ".length).trim();
      draft.oldPath = null;
      continue;
    }
    if (line.startsWith("rename from ")) {
      draft.isRename = true;
      draft.oldPath = unquoteGitPath(line.slice("rename from ".length));
      continue;
    }
    if (line.startsWith("rename to ")) {
      draft.isRename = true;
      draft.newPath = unquoteGitPath(line.slice("rename to ".length));
      continue;
    }
    if (line.startsWith("copy from ")) {
      draft.isCopy = true;
      draft.oldPath = unquoteGitPath(line.slice("copy from ".length));
      continue;
    }
    if (line.startsWith("copy to ")) {
      draft.isCopy = true;
      draft.newPath = unquoteGitPath(line.slice("copy to ".length));
      continue;
    }
    if (line.startsWith("similarity index ")) {
      const m = /^similarity index (\d+)%/.exec(line);
      if (m) draft.similarity = Number(m[1]);
      continue;
    }
    if (line.startsWith("dissimilarity index ")) {
      const m = /^dissimilarity index (\d+)%/.exec(line);
      if (m) draft.similarity = 100 - Number(m[1]);
      continue;
    }
    if (line.startsWith("index ")) {
      continue; // sha1..sha2 [mode] — not surfaced in the UI
    }
    if (line.startsWith("Binary files ") && line.endsWith(" differ")) {
      draft.isBinary = true;
      const body = line.slice("Binary files ".length, -" differ".length);
      const mid = body.indexOf(" and ");
      if (mid >= 0) {
        const a = body.slice(0, mid).trim();
        const b = body.slice(mid + " and ".length).trim();
        if (draft.oldPath === undefined) draft.oldPath = a === "/dev/null" ? null : stripAbPrefix(unquoteGitPath(a));
        if (draft.newPath === undefined) draft.newPath = b === "/dev/null" ? null : stripAbPrefix(unquoteGitPath(b));
      }
      continue;
    }
    if (line === "GIT binary patch") {
      draft.isBinary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      draft.oldPath = parseAbPathToken(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      draft.newPath = parseAbPathToken(line.slice(4));
      continue;
    }

    const hunkMatch = HUNK_HEADER_RE.exec(line);
    if (hunkMatch) {
      flushHunk();
      const oldStart = Number(hunkMatch[1]);
      const oldLines = hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1;
      const newStart = Number(hunkMatch[3]);
      const newLines = hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1;
      hunk = { header: line, oldStart, oldLines, newStart, newLines, lines: [] };
      // A zero-length side has no starting line number to count from in
      // git's own convention (an empty file's hunk reports start 0); track
      // the NEXT line number to assign regardless, mirroring git's numbering.
      (hunk as DiffHunk & { _oldNext: number; _newNext: number })._oldNext = oldStart;
      (hunk as DiffHunk & { _oldNext: number; _newNext: number })._newNext = newStart;
      continue;
    }

    if (hunk) {
      const marker = line.charAt(0);
      const h = hunk as DiffHunk & { _oldNext: number; _newNext: number };
      if (marker === "\\") {
        // "\ No newline at end of file" — attach to the line just pushed.
        const last = hunk.lines[hunk.lines.length - 1];
        if (last) last.noNewlineAtEnd = true;
        continue;
      }
      if (marker === "+") {
        hunk.lines.push({ type: "add", oldNo: null, newNo: h._newNext, text: line.slice(1) });
        h._newNext++;
        continue;
      }
      if (marker === "-") {
        hunk.lines.push({ type: "del", oldNo: h._oldNext, newNo: null, text: line.slice(1) });
        h._oldNext++;
        continue;
      }
      if (marker === " ") {
        hunk.lines.push({ type: "context", oldNo: h._oldNext, newNo: h._newNext, text: line.slice(1) });
        h._oldNext++;
        h._newNext++;
        continue;
      }
      // Anything else ends the hunk implicitly (including a bare "" —
      // deliberately NOT treated as a blank context line: git always emits
      // an explicit leading space for a blank context line, so a truly
      // zero-length element here is a split() artifact of the diff text's
      // own trailing newline, never real hunk content). Fall through and
      // let the next loop iteration re-examine this same content as
      // file-level noise (ignored) rather than losing sync with the file
      // boundary.
      flushHunk();
    }
    // Unrecognized line outside any hunk (e.g. stray blank lines between
    // file sections) — ignored.
  }
  flushDraft();

  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files, additions, deletions };
}
