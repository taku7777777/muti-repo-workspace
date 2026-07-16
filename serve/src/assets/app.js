/**
 * app.js — mrw approval UI. Plain vanilla JS, no framework, no build step
 * (CSP forbids inline script/style — see routes.ts/security.ts — so this
 * file, loaded from /assets/app.js, is the ONLY place the review UI is
 * built; GET / ships app chrome only, see html.ts's renderShell doc
 * comment).
 *
 * Everything this file receives from the server (boot config aside) is
 * UNTRUSTED, coder-authored text forwarded verbatim from the broker (see
 * wire.ts's header comment: "All strings RAW — serve must escape"). The
 * single rule that keeps this file safe: every dynamic string interpolated
 * into an HTML template literal below goes through esc() first. The two
 * exceptions are deliberate and both still escape-first internally:
 * renderMarkdown() (escapes, THEN adds its own tags) and the diff line
 * renderer's intraline <mark> spans (escapes each token before wrapping).
 *
 * This file duplicates three algorithms that also exist, tested, in this
 * package's TypeScript source (src/diff.ts, src/markdown.ts, src/html.ts's
 * escapeHtml) — there is no build step to ship those .ts files to a
 * browser, so a hand-written port lives here instead. Keep them in sync by
 * hand; see diff.ts's header comment for why this duplication is this
 * package's established posture at process/runtime boundaries.
 */
(function () {
  "use strict";

  // ==========================================================================
  // Escaping — the ONE function every render path below funnels through.
  // ==========================================================================

  function esc(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // prUrl is broker-generated (the `gh pr create` result — see wire.ts's
  // PublishResultWire), not coder-authored text, but the wire contract still
  // documents every string as raw/untrusted, and scheme-checking a URL
  // before it becomes an href is cheap insurance against ever rendering a
  // clickable javascript:/data: link — same discipline markdown.ts applies
  // to PR-body links. Returns the url if safe, else null (render no link).
  function safeHttpUrl(url) {
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
  }

  // ==========================================================================
  // localStorage helpers (§3.5: "user's localStorage toggles winning over
  // serve.json"). Every read is try/catched — a browser with storage
  // disabled (private mode, quota, etc.) must degrade to built-in/serve.json
  // defaults, never throw and blank the page.
  // ==========================================================================

  const LS = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* best effort — a full/disabled store just means the toggle resets next load */
      }
    },
  };

  const THEME_KEY = "mrw:theme"; // "auto" | "light" | "dark"
  const DIFF_VIEW_KEY = "mrw:diffView"; // "unified" | "split"
  const DIFF_WRAP_KEY = "mrw:diffWrap"; // boolean

  function viewedStorageKey(pendingId, path) {
    return `viewed:${pendingId}:${path}`;
  }

  // ==========================================================================
  // Diff parser — a hand-written JS port of src/diff.ts. See that file for
  // the full reasoning behind every branch; comments here stay short.
  // ==========================================================================

  const Diff = (function () {
    function findClosingQuote(s, openAt) {
      for (let i = openAt + 1; i < s.length; i++) {
        if (s[i] === "\\") {
          i++;
          continue;
        }
        if (s[i] === '"') return i;
      }
      return -1;
    }

    function unquoteGitPath(raw) {
      const s = raw.trim();
      if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
      const inner = s.slice(1, -1);
      const bytes = [];
      const simple = { n: 0x0a, t: 0x09, '"': 0x22, "\\": 0x5c, a: 0x07, b: 0x08, f: 0x0c, v: 0x0b, r: 0x0d };
      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (c === "\\" && i + 1 < inner.length) {
          const n = inner[i + 1];
          if (Object.prototype.hasOwnProperty.call(simple, n)) {
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
          bytes.push(n.charCodeAt(0));
          i++;
          continue;
        }
        const codepoint = c.codePointAt(0) || 0;
        if (codepoint < 0x80) {
          bytes.push(codepoint);
        } else {
          for (const b of new TextEncoder().encode(c)) bytes.push(b);
        }
      }
      return new TextDecoder("utf-8").decode(new Uint8Array(bytes));
    }

    function stripAbPrefix(p) {
      return p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p;
    }

    function parseAbPathToken(token) {
      const t = token.trim();
      if (t === "/dev/null") return null;
      return stripAbPrefix(unquoteGitPath(t));
    }

    function parseDiffGitLine(line) {
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

    function newDraft(diffGitLine) {
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

    function finalizeDraft(d) {
      let oldPath = d.oldPath === undefined ? null : d.oldPath;
      let newPath = d.newPath === undefined ? null : d.newPath;
      if (d.oldPath === undefined && d.newPath === undefined) {
        const fallback = parseDiffGitLine(d.diffGitLine);
        if (fallback) {
          oldPath = fallback.a;
          newPath = fallback.b;
        }
      }

      let status = "modified";
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

    function parse(text) {
      const files = [];
      if (!text) return { files, additions: 0, deletions: 0 };

      const lines = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));

      let draft = null;
      let hunk = null;

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
        if (!draft) continue;

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
        if (line.startsWith("index ")) continue;
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
          const newStart = Number(hunkMatch[3]);
          hunk = {
            header: line,
            oldStart,
            oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
            newStart,
            newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
            lines: [],
            _oldNext: oldStart,
            _newNext: newStart,
          };
          continue;
        }

        if (hunk) {
          const marker = line.charAt(0);
          if (marker === "\\") {
            const last = hunk.lines[hunk.lines.length - 1];
            if (last) last.noNewlineAtEnd = true;
            continue;
          }
          if (marker === "+") {
            hunk.lines.push({ type: "add", oldNo: null, newNo: hunk._newNext, text: line.slice(1) });
            hunk._newNext++;
            continue;
          }
          if (marker === "-") {
            hunk.lines.push({ type: "del", oldNo: hunk._oldNext, newNo: null, text: line.slice(1) });
            hunk._oldNext++;
            continue;
          }
          if (marker === " ") {
            hunk.lines.push({
              type: "context",
              oldNo: hunk._oldNext,
              newNo: hunk._newNext,
              text: line.slice(1),
            });
            hunk._oldNext++;
            hunk._newNext++;
            continue;
          }
          // A bare "" here is a split() artifact of the diff text's own
          // trailing newline, not a blank context line (git always emits an
          // explicit leading space for those) — fall through to end the hunk.
          flushHunk();
        }
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

    return { parse };
  })();

  // ==========================================================================
  // Word-level intraline highlighting — token LCS for paired ±runs of equal
  // length (§3.4); everything else falls back to whole-line coloring only.
  // ==========================================================================

  function tokenize(s) {
    return s.match(/\w+|[^\w]/g) || [];
  }

  const TOKEN_DIFF_CAP = 500; // guard against pathological O(n*m) on huge lines

  function tokenDiff(oldText, newText) {
    const a = tokenize(oldText);
    const b = tokenize(newText);
    if (a.length > TOKEN_DIFF_CAP || b.length > TOKEN_DIFF_CAP) {
      return { oldSegs: [{ text: oldText, kind: "del" }], newSegs: [{ text: newText, kind: "add" }] };
    }
    const n = a.length;
    const m = b.length;
    const dp = new Array(n + 1);
    for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    const oldSegs = [];
    const newSegs = [];
    const push = (arr, text, kind) => {
      const last = arr[arr.length - 1];
      if (last && last.kind === kind) last.text += text;
      else arr.push({ text, kind });
    };
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        push(oldSegs, a[i], "same");
        push(newSegs, b[j], "same");
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        push(oldSegs, a[i], "del");
        i++;
      } else {
        push(newSegs, b[j], "add");
        j++;
      }
    }
    while (i < n) {
      push(oldSegs, a[i], "del");
      i++;
    }
    while (j < m) {
      push(newSegs, b[j], "add");
      j++;
    }
    return { oldSegs, newSegs };
  }

  /** Annotates paired del/add runs of EQUAL length in-place with `.segments`. */
  function computeIntralineHighlights(hunk) {
    const lines = hunk.lines;
    let i = 0;
    while (i < lines.length) {
      if (lines[i].type === "del") {
        let delEnd = i;
        while (delEnd < lines.length && lines[delEnd].type === "del") delEnd++;
        let addEnd = delEnd;
        while (addEnd < lines.length && lines[addEnd].type === "add") addEnd++;
        const delCount = delEnd - i;
        const addCount = addEnd - delEnd;
        if (delCount === addCount && delCount > 0) {
          for (let k = 0; k < delCount; k++) {
            const delLine = lines[i + k];
            const addLine = lines[delEnd + k];
            const d = tokenDiff(delLine.text, addLine.text);
            delLine.segments = d.oldSegs;
            addLine.segments = d.newSegs;
          }
        }
        i = addEnd;
      } else {
        i++;
      }
    }
  }

  function renderSegmentsHtml(segments) {
    return segments
      .map((seg) => {
        const t = esc(seg.text);
        if (seg.kind === "add") return `<mark class="add">${t}</mark>`;
        if (seg.kind === "del") return `<mark class="del">${t}</mark>`;
        return t;
      })
      .join("");
  }

  // ==========================================================================
  // Mini-markdown — a hand-written JS port of src/markdown.ts. Escape-first;
  // see that file for the full safety argument.
  // ==========================================================================

  const CODE_TOKEN_OPEN = "\x01\x02CS";
  const CODE_TOKEN_CLOSE = "\x02\x01";

  function renderInlineMd(escapedText) {
    const codeSpans = [];
    let out = escapedText.replace(/`([^`\n]+)`/g, (_m, code) => {
      codeSpans.push(code);
      return `${CODE_TOKEN_OPEN}${codeSpans.length - 1}${CODE_TOKEN_CLOSE}`;
    });
    out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text, url) => {
      if (/^https?:\/\//i.test(url)) return `<a href="${url}" rel="noopener noreferrer">${text}</a>`;
      return whole;
    });
    out = out.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
    out = out.replace(/__([^\n]+?)__/g, "<strong>$1</strong>");
    out = out.replace(/\*([^\n]+?)\*/g, "<em>$1</em>");
    out = out.replace(/(^|[^\w])_([^\n_]+?)_(?!\w)/g, "$1<em>$2</em>");
    out = out.replace(new RegExp(`${CODE_TOKEN_OPEN}(\\d+)${CODE_TOKEN_CLOSE}`, "g"), (_m, idx) => {
      return `<code>${codeSpans[Number(idx)] || ""}</code>`;
    });
    return out;
  }

  function renderMarkdown(raw) {
    const escaped = esc(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const lines = escaped.split("\n");
    const out = [];
    let paragraph = [];
    let list = null;
    let quote = [];

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push(`<p>${renderInlineMd(paragraph.join("\n"))}</p>`);
        paragraph = [];
      }
    };
    const flushList = () => {
      if (list) {
        const tag = list.ordered ? "ol" : "ul";
        out.push(`<${tag}>${list.items.map((it) => `<li>${renderInlineMd(it)}</li>`).join("")}</${tag}>`);
        list = null;
      }
    };
    const flushQuote = () => {
      if (quote.length) {
        out.push(`<blockquote>${renderInlineMd(quote.join("\n"))}</blockquote>`);
        quote = [];
      }
    };
    const flushAll = () => {
      flushParagraph();
      flushList();
      flushQuote();
    };

    let i = 0;
    while (i < lines.length) {
      const line = lines[i];

      const fence = /^```(\w*)\s*$/.exec(line);
      if (fence) {
        flushAll();
        const lang = fence[1];
        const body = [];
        i++;
        while (i < lines.length && !/^```\s*$/.test(lines[i])) {
          body.push(lines[i]);
          i++;
        }
        i++;
        const langAttr = lang ? ` class="lang-${lang}"` : "";
        out.push(`<pre><code${langAttr}>${body.join("\n")}</code></pre>`);
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
        flushAll();
        out.push("<hr>");
        i++;
        continue;
      }
      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) {
        flushAll();
        const level = heading[1].length;
        out.push(`<h${level}>${renderInlineMd(heading[2].trim())}</h${level}>`);
        i++;
        continue;
      }
      // Matches "&gt;" — this line is ALREADY escaped (see renderMarkdown's
      // `escaped` above), and ">" is one of the chars esc() converts.
      const bq = /^&gt;\s?(.*)$/.exec(line);
      if (bq) {
        flushParagraph();
        flushList();
        quote.push(bq[1]);
        i++;
        continue;
      }
      if (quote.length) flushQuote();

      const ul = /^[-*]\s+(.*)$/.exec(line);
      const ol = /^\d+\.\s+(.*)$/.exec(line);
      if (ul || ol) {
        flushParagraph();
        const ordered = !!ol;
        const content = (ul || ol)[1];
        if (!list || list.ordered !== ordered) {
          flushList();
          list = { ordered, items: [] };
        }
        list.items.push(content);
        i++;
        continue;
      }
      if (list) flushList();

      if (line.trim() === "") {
        flushAll();
        i++;
        continue;
      }
      paragraph.push(line);
      i++;
    }
    flushAll();
    return out.join("\n");
  }

  // ==========================================================================
  // Boot data + app state
  // ==========================================================================

  const bootEl = document.getElementById("boot");
  const boot = JSON.parse(bootEl.textContent);

  const state = {
    connected: true,
    pending: null, // full PendingWire or null
    parsed: null, // Diff.parse(view.diff) for the current pending
    lastOutcome: null,
    history: [],
    renderKey: null,
    // review-local UI state, reset whenever renderKey's pending id changes
    activeTab: "overview",
    diffView: LS.get(DIFF_VIEW_KEY, null) || boot.diff.view,
    wrapLines: LS.get(DIFF_WRAP_KEY, null),
    activeFileIndex: 0,
    fileFilter: "",
    viewedFiles: new Set(), // fileKey() strings, for the CURRENT pending only
    collapseOverride: new Map(), // fileKey() -> boolean, explicit user override
    attemptsLeft: null,
    submitting: null,
  };
  if (state.wrapLines === null) state.wrapLines = !!boot.diff.wrap;

  function fileKey(f) {
    return f.newPath !== null ? f.newPath : f.oldPath !== null ? f.oldPath : "(unknown)";
  }

  // ==========================================================================
  // Theme
  // ==========================================================================

  function effectiveTheme() {
    return LS.get(THEME_KEY, null) || boot.theme || "auto";
  }

  function applyTheme() {
    const t = effectiveTheme();
    if (t === "light" || t === "dark") {
      document.documentElement.setAttribute("data-theme", t);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    for (const btn of document.querySelectorAll(".mrw-theme-toggle button")) {
      btn.setAttribute("aria-pressed", String(btn.dataset.theme === t));
    }
  }

  function setTheme(t) {
    LS.set(THEME_KEY, t);
    applyTheme();
  }

  // ==========================================================================
  // API client — every POST carries the CSRF header from boot JSON (§3.2:
  // "delivered to the page only via the boot JSON").
  // ==========================================================================

  async function apiGet(path) {
    const res = await fetch(path, { credentials: "same-origin" });
    return res.json();
  }

  async function apiPost(path, body) {
    const res = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "x-mrw-csrf": boot.csrf },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  // ==========================================================================
  // Polling loop
  // ==========================================================================

  let pollTimer = null;

  function effectivePollIntervalMs() {
    const n = Number(boot.pollIntervalMs);
    return Number.isFinite(n) && n > 0 ? n : 2000;
  }

  async function pollOnce() {
    try {
      const q = state.pending ? `?known=${encodeURIComponent(state.pending.id)}` : "";
      const data = await apiGet(`/api/state${q}`);
      applyStateUpdate(data);
    } catch {
      applyStateUpdate({ connected: false, pending: null, last: null, history: [] });
    }
  }

  function schedulePoll(delayMs) {
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
      await pollOnce();
      schedulePoll(effectivePollIntervalMs());
    }, delayMs);
  }

  function applyStateUpdate(data) {
    state.connected = !!data.connected;
    if (data.pending !== "unchanged") {
      state.pending = data.pending || null;
      state.parsed = state.pending ? Diff.parse(state.pending.view.diff) : null;
      if (state.parsed) {
        for (const f of state.parsed.files) {
          for (const h of f.hunks) computeIntralineHighlights(h);
        }
      }
    }
    state.lastOutcome = data.last || null;
    state.history = Array.isArray(data.history) ? data.history : [];
    render();
  }

  // ==========================================================================
  // Rendering — top-level dispatch. Full rebuilds happen ONLY when the
  // logical state actually changes (idle -> review -> decided, or a new
  // pending/outcome id); an unchanged review stays untouched across polls so
  // the sha input, scroll position, and open file cards never get disturbed.
  // ==========================================================================

  // Assigned by initShell() once #mrw-content exists (the SSR shell only
  // ships an empty #app — see html.ts's renderShell — so this element is
  // created client-side, not present at script-load time).
  let content = null;

  function computeRenderKey() {
    if (state.pending) return `review:${state.pending.id}`;
    if (state.lastOutcome) return `decided:${state.lastOutcome.id}`;
    return "idle";
  }

  let lastRenderedPublishJson = null; // dedupe key for the decided-state light-refresh path below

  function render() {
    updateConnDot();
    const key = computeRenderKey();
    if (key === state.renderKey) {
      // Same logical state as last render. Idle/review need no further work
      // (review never rebuilds on an unchanged id — see this function's doc
      // comment above computeRenderKey). Decided is the one case that can
      // still change UNDER the same id: `publish` fills in asynchronously
      // after approval. Only rebuild when that actually changed, so a
      // resolved decided screen does not silently churn the DOM every poll.
      if (key.startsWith("decided:")) {
        const publishJson = JSON.stringify(state.lastOutcome && state.lastOutcome.publish);
        if (publishJson !== lastRenderedPublishJson) {
          lastRenderedPublishJson = publishJson;
          renderDecided();
        }
      }
      return;
    }
    state.renderKey = key;
    if (key === "idle") renderIdle();
    else if (key.startsWith("review:")) renderReview();
    else {
      lastRenderedPublishJson = JSON.stringify(state.lastOutcome && state.lastOutcome.publish);
      renderDecided();
    }
  }

  function updateConnDot() {
    const dot = document.getElementById("mrw-conn");
    if (!dot) return;
    dot.classList.toggle("is-down", !state.connected);
    const label = dot.querySelector(".label");
    if (label) label.textContent = state.connected ? "connected" : "broker unreachable";
  }

  // --- idle ---------------------------------------------------------------

  function renderIdle() {
    const lastTicket = state.history.length ? state.history[0].ticket : null;
    content.innerHTML = `
      <div class="mrw-idle">
        <h1>Waiting for a publish request&hellip;</h1>
        <p>mrw serve is watching the broker's approval socket and will show the next publish here automatically.</p>
        ${lastTicket ? `<span class="mrw-chip">ticket: ${esc(lastTicket)}</span>` : ""}
      </div>
    `;
  }

  // --- review ---------------------------------------------------------------

  function reviewerBadgeHtml(verdict) {
    if (verdict === null || verdict === undefined) return "";
    if (verdict === "unavailable") {
      return `<span class="mrw-badge is-unavailable" title="the advisory reviewer failed or timed out">&#9675; reviewer unavailable</span>`;
    }
    const notes = esc(verdict.notes);
    if (verdict.verdict === "approve") {
      return `<span class="mrw-badge is-approve" title="${notes}">&#10003; reviewer: approve</span>`;
    }
    return `<span class="mrw-badge is-concerns" title="${notes}">&#9888; reviewer: concerns</span>`;
  }

  function filePathHtml(oldPath, newPath) {
    if (oldPath !== null && newPath !== null && oldPath !== newPath) {
      return `${esc(oldPath)} <span class="rename-arrow" aria-hidden="true">&rarr;</span> ${esc(newPath)}`;
    }
    const p = newPath !== null ? newPath : oldPath !== null ? oldPath : "(unknown path)";
    return esc(p);
  }

  function metaRowHtml(view, parsed) {
    const ticketChip = view.ticket ? `<span class="mrw-chip">ticket: ${esc(view.ticket)}</span>` : "";
    return `
      <div class="mrw-meta-row">
        <span class="target">${esc(view.org)}/${esc(view.targetRepo)}</span>
        <span>&larr; <code>${esc(view.branch)}</code></span>
        <span class="sep">|</span>
        <span class="mrw-sha-chip" title="click to copy">
          <code>${esc(view.shortSha)}</code>
          <button type="button" class="copy-sha" aria-label="copy full sha">&#128203;</button>
        </span>
        <span class="sep">|</span>
        <span>${view.commitCount} commit${view.commitCount === 1 ? "" : "s"}</span>
        <span class="mrw-stat"><span class="add">+${parsed.additions}</span> <span class="del">-${parsed.deletions}</span></span>
        ${reviewerBadgeHtml(view.reviewerVerdict)}
        ${view.testCaveat ? `<span class="mrw-badge is-concerns" title="the diff touches test files/config — the green-tests gate may not be independent">&#9888; tests touched</span>` : ""}
        ${ticketChip}
      </div>
    `;
  }

  function tabsHtml(view, parsed) {
    return `
      <div class="mrw-tabs" role="tablist">
        <button class="mrw-tab" role="tab" data-tab="overview" aria-selected="true">Overview</button>
        <button class="mrw-tab" role="tab" data-tab="commits" aria-selected="false">Commits (${view.commitCount})</button>
        <button class="mrw-tab" role="tab" data-tab="files" aria-selected="false">Files changed (${parsed.files.length})</button>
      </div>
    `;
  }

  function overviewPanelHtml(view) {
    const sections = boot.sections;
    const bodyHtml = view.body.trim().length
      ? `<div class="mrw-markdown">${renderMarkdown(view.body)}</div>`
      : `<p class="mrw-empty">(empty PR body)</p>`;
    const reviewerCard =
      sections.reviewer && view.reviewerVerdict && view.reviewerVerdict !== "unavailable"
        ? `
      <div class="mrw-card">
        <div class="hd">Advisory reviewer</div>
        <div class="bd mrw-reviewer-notes">${esc(view.reviewerVerdict.notes).replace(/\n/g, "<br>")}</div>
      </div>`
        : sections.reviewer && view.reviewerVerdict === "unavailable"
          ? `
      <div class="mrw-card">
        <div class="hd">Advisory reviewer</div>
        <div class="bd mrw-empty">no verdict — the reviewer failed or timed out; decide from the diff alone.</div>
      </div>`
          : "";
    return `
      <div class="mrw-panel">
        <div class="mrw-card mrw-target-card">
          <div class="hd">Push target</div>
          <div class="bd">
            <dl>
              <dt>host</dt><dd>${esc(view.host)}</dd>
              <dt>org</dt><dd>${esc(view.org)}</dd>
              <dt>repo</dt><dd>${esc(view.targetRepo)}</dd>
              <dt>url</dt><dd>${esc(view.url)}</dd>
            </dl>
            <div class="mrw-push-line">will push ${esc(view.headSha)} &rarr; refs/heads/${esc(view.branch)}</div>
          </div>
        </div>
        ${sections.body ? `<div class="mrw-card"><div class="hd">PR body</div><div class="bd">${bodyHtml}</div></div>` : ""}
        ${reviewerCard}
        ${
          view.testCaveat
            ? `<div class="mrw-card"><div class="hd">Caveat</div><div class="bd">&#9888; the diff touches test files/config &mdash; the green-tests gate may not be independent of the coder's edits (broker-computed, advisory only).</div></div>`
            : ""
        }
        ${
          view.diffStat.trim().length
            ? `<div class="mrw-card"><div class="hd">diffstat</div><div class="bd"><pre class="mono">${esc(view.diffStat)}</pre></div></div>`
            : ""
        }
      </div>
    `;
  }

  function commitsPanelHtml(view) {
    if (!boot.sections.commits) return `<div class="mrw-panel"><p class="mrw-empty">commits section disabled</p></div>`;
    const lines = view.commitList.split("\n").filter((l) => l.trim().length > 0);
    if (!lines.length) return `<div class="mrw-panel"><p class="mrw-empty">no commits</p></div>`;
    const rows = lines
      .map((line) => {
        const sp = line.indexOf(" ");
        const sha = sp === -1 ? line : line.slice(0, sp);
        const subject = sp === -1 ? "" : line.slice(sp + 1);
        return `<div class="mrw-commit-row"><code class="sha">${esc(sha)}</code><span class="subject">${esc(subject)}</span></div>`;
      })
      .join("");
    return `<div class="mrw-panel"><div class="mrw-card"><div class="bd">${rows}</div></div></div>`;
  }

  function fileStatHtml(f) {
    return `<span class="mrw-stat"><span class="add">+${f.additions}</span> <span class="del">-${f.deletions}</span></span>`;
  }

  function buildFileTree(files) {
    const root = { dirs: new Map(), files: [] };
    files.forEach((f, idx) => {
      const key = fileKey(f);
      const parts = key.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const seg = parts[i];
        if (!node.dirs.has(seg)) node.dirs.set(seg, { dirs: new Map(), files: [] });
        node = node.dirs.get(seg);
      }
      node.files.push({ index: idx, name: parts[parts.length - 1], file: f });
    });
    return root;
  }

  function renderTreeNode(node) {
    const dirNames = [...node.dirs.keys()].sort((a, b) => a.localeCompare(b));
    const fileEntries = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    let html = "<ul>";
    for (const name of dirNames) {
      html += `<li><details class="mrw-tree-dir" open><summary>${esc(name)}</summary>${renderTreeNode(node.dirs.get(name))}</details></li>`;
    }
    for (const entry of fileEntries) {
      const f = entry.file;
      html += `
        <li>
          <span class="mrw-tree-file" data-file-index="${entry.index}" role="button" tabindex="0">
            <input type="checkbox" class="tree-viewed" data-file-index="${entry.index}" aria-label="mark ${esc(entry.name)} as viewed">
            <span class="name">${esc(entry.name)}</span>
            ${fileStatHtml(f)}
          </span>
        </li>`;
    }
    html += "</ul>";
    return html;
  }

  function filesPanelHtml(parsed) {
    const sections = boot.sections;
    const sidebar = sections.fileTree
      ? `
      <div class="mrw-sidebar">
        <div class="filter">
          <input type="search" id="file-filter" placeholder="Filter files" aria-label="Filter files">
        </div>
        <div class="mrw-progress-pill" id="progress-pill"></div>
        <div class="mrw-tree" id="file-tree">${renderTreeNode(buildFileTree(parsed.files))}</div>
      </div>`
      : "";
    const toolbar = `
      <div class="mrw-diff-toolbar">
        <span class="seg" role="group" aria-label="diff view mode">
          <button data-view="unified" aria-pressed="${state.diffView === "unified"}">Unified</button>
          <button data-view="split" aria-pressed="${state.diffView === "split"}">Split</button>
        </span>
        <label><input type="checkbox" id="wrap-toggle" ${state.wrapLines ? "checked" : ""}> Wrap</label>
      </div>`;
    const files = parsed.files.map((f, idx) => fileCardHtml(f, idx)).join("");
    return `
      <div class="mrw-files-layout">
        ${sidebar}
        <div class="mrw-files-main">
          ${toolbar}
          ${files}
        </div>
      </div>
    `;
  }

  function fileCardHtml(f, idx) {
    const totalLines = f.hunks.reduce((n, h) => n + h.lines.length, 0);
    const approxBytes = f.hunks.reduce((n, h) => n + h.lines.reduce((m, l) => m + l.text.length, 0), 0);
    const threshold = boot.diff.collapseThresholdLines || 400;
    const isLarge = totalLines > threshold || approxBytes > 100 * 1024;
    // A large file's "collapse" is expressed by NOT rendering its rows until
    // the Load-diff button is clicked (the notice below stands in for them) —
    // NOT by the is-collapsed class, which hides the whole body and would
    // hide the notice/button too. The chevron stays a plain visibility
    // toggle either way.
    const collapsed = false;

    let body;
    if (f.isBinary) {
      body = `<div class="mrw-file-notice">Binary file${f.oldPath !== null && f.newPath !== null && f.oldPath !== f.newPath ? " (renamed)" : ""} — not shown.</div>`;
    } else if (f.hunks.length === 0) {
      const modeNote =
        f.oldMode && f.newMode
          ? `<div class="mrw-file-notice">mode changed: ${esc(f.oldMode)} &rarr; ${esc(f.newMode)}</div>`
          : `<div class="mrw-file-notice">no textual changes.</div>`;
      body = modeNote;
    } else if (isLarge) {
      body = `<div class="mrw-file-notice">Large file (${totalLines} lines) collapsed by default.<br><button type="button" class="mrw-btn mrw-load-diff" data-file-index="${idx}">Load diff</button></div>`;
    } else {
      body = diffBodyHtml(f);
    }

    return `
      <div class="mrw-file${collapsed ? " is-collapsed" : ""}" id="mrw-file-${idx}" data-file-index="${idx}">
        <div class="mrw-file-header">
          <button type="button" class="collapse-btn" data-file-index="${idx}" aria-label="toggle file">${collapsed ? "&#9656;" : "&#9662;"}</button>
          <span class="path">${filePathHtml(f.oldPath, f.newPath)}</span>
          ${fileStatHtml(f)}
          <button type="button" class="mrw-btn is-small is-ghost copy-path" data-file-index="${idx}" aria-label="copy path">copy</button>
          <label class="viewed">
            <input type="checkbox" class="file-viewed" data-file-index="${idx}"> viewed
          </label>
        </div>
        <div class="mrw-file-body" data-file-index="${idx}">${body}</div>
      </div>
    `;
  }

  function unifiedTableHtml(f) {
    let rows = "";
    for (const h of f.hunks) {
      rows += `<tr class="gap"><td colspan="3">${esc(h.header)}</td></tr>`;
      for (const l of h.lines) {
        const cls = l.type === "add" ? "add" : l.type === "del" ? "del" : "context";
        const marker = l.type === "add" ? "+" : l.type === "del" ? "-" : " ";
        const codeHtml = l.segments ? renderSegmentsHtml(l.segments) : esc(l.text);
        const nlNote = l.noNewlineAtEnd ? ` <span class="no-newline">(no newline at end of file)</span>` : "";
        rows += `<tr class="${cls}"><td class="ln">${l.oldNo || ""}</td><td class="ln">${l.newNo || ""}</td><td class="marker">${marker}</td><td class="code">${codeHtml}${nlNote}</td></tr>`;
      }
    }
    return `<table class="mrw-diff${state.wrapLines ? " wrap" : ""}"><tbody>${rows}</tbody></table>`;
  }

  function splitRowsFor(lines) {
    const rows = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (line.type === "context") {
        rows.push({ left: line, right: line });
        i++;
        continue;
      }
      if (line.type === "del") {
        let delEnd = i;
        while (delEnd < lines.length && lines[delEnd].type === "del") delEnd++;
        let addEnd = delEnd;
        while (addEnd < lines.length && lines[addEnd].type === "add") addEnd++;
        const delLines = lines.slice(i, delEnd);
        const addLines = lines.slice(delEnd, addEnd);
        const max = Math.max(delLines.length, addLines.length);
        for (let k = 0; k < max; k++) rows.push({ left: delLines[k] || null, right: addLines[k] || null });
        i = addEnd;
        continue;
      }
      rows.push({ left: null, right: line });
      i++;
    }
    return rows;
  }

  function splitCellHtml(line, side) {
    if (!line) return `<td class="ln"></td><td class="marker"></td><td class="code"></td>`;
    const cls = line.type === "add" ? "add" : line.type === "del" ? "del" : "context";
    const marker = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
    const codeHtml = line.segments ? renderSegmentsHtml(line.segments) : esc(line.text);
    const no = side === "left" ? line.oldNo : line.newNo;
    const nlNote = line.noNewlineAtEnd ? ` <span class="no-newline">(no newline)</span>` : "";
    return `<td class="ln">${no || ""}</td><td class="marker">${marker}</td><td class="code ${cls}">${codeHtml}${nlNote}</td>`;
  }

  // Split view renders two independent, aligned tables (left=old, right=new)
  // from the SAME row pairing (splitRowsFor) so hunk gap rows and blank-side
  // rows line up between panes; paneTableRows() re-walks that pairing once
  // per side.
  function paneTableRows(f, side) {
    let rows = "";
    for (const h of f.hunks) {
      rows += `<tr class="gap"><td colspan="3">${esc(h.header)}</td></tr>`;
      for (const r of splitRowsFor(h.lines)) {
        const line = side === "left" ? r.left : r.right;
        const rowCls = line ? (line.type === "add" ? "add" : line.type === "del" ? "del" : "context") : "blank";
        rows += `<tr class="${rowCls}">${splitCellHtml(line, side)}</tr>`;
      }
    }
    return rows;
  }

  function diffBodyHtml(f) {
    if (state.diffView === "split") {
      const wrapCls = state.wrapLines ? " wrap" : "";
      return `
        <div class="mrw-split">
          <div class="pane"><table class="mrw-diff${wrapCls}"><tbody>${paneTableRows(f, "left")}</tbody></table></div>
          <div class="pane"><table class="mrw-diff${wrapCls}"><tbody>${paneTableRows(f, "right")}</tbody></table></div>
        </div>`;
    }
    return unifiedTableHtml(f);
  }

  function footerHtml() {
    return `
      <div class="mrw-footer">
        <div class="progress" id="viewed-progress"></div>
        <div class="approve-group">
          <input type="text" class="sha-input mono" id="approve-sha" placeholder="type ${esc(state.pending.view.shortSha)} to approve" aria-label="type the short sha to approve" autocomplete="off" spellcheck="false">
          <button type="button" class="mrw-btn is-primary" id="approve-btn" disabled>Approve</button>
          <span class="attempts-warning" id="attempts-warning" hidden></span>
          <span id="approve-spinner" hidden class="spinner" aria-hidden="true"></span>
        </div>
        <div class="decline-group">
          <button type="button" class="mrw-btn is-danger" id="decline-btn">Decline</button>
        </div>
      </div>
    `;
  }

  function renderReview() {
    const pending = state.pending;
    const view = pending.view;
    const parsed = state.parsed;

    state.activeTab = "overview";
    state.activeFileIndex = 0;
    state.fileFilter = "";
    state.attemptsLeft = pending.attemptsLeft;
    state.submitting = null;
    state.viewedFiles = new Set();
    state.collapseOverride = new Map();
    for (const f of parsed.files) {
      if (LS.get(viewedStorageKey(pending.id, fileKey(f)), false)) state.viewedFiles.add(fileKey(f));
    }

    content.innerHTML = `
      <div class="mrw-review-header">
        ${renderTitleHtml(view.title)}
        ${metaRowHtml(view, parsed)}
        ${tabsHtml(view, parsed)}
      </div>
      <div class="mrw-review-body">
        <div class="tab-panel" data-panel="overview">${overviewPanelHtml(view)}</div>
        <div class="tab-panel" data-panel="commits" hidden>${commitsPanelHtml(view)}</div>
        <div class="tab-panel" data-panel="files" hidden>${filesPanelHtml(parsed)}</div>
      </div>
      ${footerHtml()}
    `;

    wireReviewEvents();
    updateViewedUi();
  }

  function renderTitleHtml(title) {
    return `<h1 class="pr-title">${esc(title)}</h1>`;
  }

  function switchTab(tab) {
    state.activeTab = tab;
    for (const btn of content.querySelectorAll(".mrw-tab")) {
      btn.setAttribute("aria-selected", String(btn.dataset.tab === tab));
    }
    for (const panel of content.querySelectorAll(".tab-panel")) {
      panel.hidden = panel.dataset.panel !== tab;
    }
  }

  function setDiffView(view) {
    state.diffView = view;
    LS.set(DIFF_VIEW_KEY, view);
    rerenderFilesPanel();
  }

  function setWrap(wrap) {
    state.wrapLines = wrap;
    LS.set(DIFF_WRAP_KEY, wrap);
    rerenderFilesPanel();
  }

  function rerenderFilesPanel() {
    const panel = content.querySelector('.tab-panel[data-panel="files"]');
    if (!panel) return;
    panel.innerHTML = filesPanelHtml(state.parsed);
    wireFilesPanelEvents();
    updateViewedUi();
  }

  function markViewed(idx, viewed) {
    const f = state.parsed.files[idx];
    const key = fileKey(f);
    if (viewed) state.viewedFiles.add(key);
    else state.viewedFiles.delete(key);
    LS.set(viewedStorageKey(state.pending.id, key), viewed);

    const card = content.querySelector(`.mrw-file[data-file-index="${idx}"]`);
    if (card) {
      card.classList.toggle("is-viewed", viewed);
      if (viewed) card.classList.add("is-collapsed"); // auto-collapse on check, like GitHub
      const cb = card.querySelector(".file-viewed");
      if (cb) cb.checked = viewed;
    }
    const treeCb = content.querySelector(`.tree-viewed[data-file-index="${idx}"]`);
    if (treeCb) treeCb.checked = viewed;
    const treeEntry = content.querySelector(`.mrw-tree-file[data-file-index="${idx}"]`);
    if (treeEntry) treeEntry.classList.toggle("is-viewed", viewed);

    updateViewedUi();
  }

  function updateViewedUi() {
    if (!state.parsed) return;
    const total = state.parsed.files.length;
    const viewed = state.viewedFiles.size;
    const pillText = `${viewed} / ${total} files viewed`;
    const pill = content.querySelector("#progress-pill");
    if (pill) pill.textContent = pillText;
    const footerProgress = content.querySelector("#viewed-progress");
    if (footerProgress) footerProgress.textContent = pillText;
  }

  function applyFileFilter(query) {
    state.fileFilter = query.toLowerCase();
    for (const entry of content.querySelectorAll(".mrw-tree-file")) {
      const idx = Number(entry.dataset.fileIndex);
      const f = state.parsed.files[idx];
      const matches = fileKey(f).toLowerCase().includes(state.fileFilter);
      entry.closest("li").style.display = matches ? "" : "none";
    }
  }

  function focusFile(idx, scroll) {
    state.activeFileIndex = idx;
    const card = content.querySelector(`.mrw-file[data-file-index="${idx}"]`);
    if (card && scroll) card.scrollIntoView({ behavior: "smooth", block: "start" });
    for (const el of content.querySelectorAll(".mrw-tree-file")) {
      el.classList.toggle("is-active", Number(el.dataset.fileIndex) === idx);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
  }

  function updateApproveButtonState() {
    const input = content.querySelector("#approve-sha");
    const btn = content.querySelector("#approve-btn");
    if (!input || !btn || !state.pending) return;
    const match = input.value.trim() === state.pending.view.shortSha;
    btn.disabled = !match || state.submitting !== null;
  }

  function showAttemptsWarning() {
    const warn = content.querySelector("#attempts-warning");
    if (!warn) return;
    if (state.attemptsLeft !== null && state.attemptsLeft < 3) {
      warn.hidden = false;
      warn.textContent = `${state.attemptsLeft} attempt${state.attemptsLeft === 1 ? "" : "s"} left`;
    } else {
      warn.hidden = true;
    }
  }

  function setSubmitting(kind) {
    state.submitting = kind;
    const spinner = content.querySelector("#approve-spinner");
    const approveBtn = content.querySelector("#approve-btn");
    const declineBtn = content.querySelector("#decline-btn");
    if (spinner) spinner.hidden = kind === null;
    if (approveBtn) approveBtn.disabled = kind !== null || !approveMatches();
    if (declineBtn) declineBtn.disabled = kind !== null;
  }

  function approveMatches() {
    const input = content.querySelector("#approve-sha");
    return !!input && !!state.pending && input.value.trim() === state.pending.view.shortSha;
  }

  async function submitApprove() {
    if (!state.pending || state.submitting) return;
    const sha = content.querySelector("#approve-sha").value.trim();
    setSubmitting("approve");
    try {
      const result = await apiPost("/api/approve", { id: state.pending.id, sha });
      if (result && result.ok === false && result.code === "sha_mismatch") {
        state.attemptsLeft = result.attemptsLeft;
        showAttemptsWarning();
      }
      // Whatever the outcome, poll immediately so the UI transitions (or
      // shows the fresh attempts count) without waiting a full interval.
      await pollOnce();
    } finally {
      setSubmitting(null);
      updateApproveButtonState();
    }
  }

  async function submitDecline() {
    if (!state.pending || state.submitting) return;
    if (!window.confirm("Decline this publish request?")) return;
    setSubmitting("decline");
    try {
      await apiPost("/api/decline", { id: state.pending.id });
      await pollOnce();
    } finally {
      setSubmitting(null);
    }
  }

  function wireFilesPanelEvents() {
    const filterInput = content.querySelector("#file-filter");
    if (filterInput) filterInput.addEventListener("input", () => applyFileFilter(filterInput.value));

    for (const btn of content.querySelectorAll('.mrw-diff-toolbar button[data-view]')) {
      btn.addEventListener("click", () => setDiffView(btn.dataset.view));
    }
    const wrapToggle = content.querySelector("#wrap-toggle");
    if (wrapToggle) wrapToggle.addEventListener("change", () => setWrap(wrapToggle.checked));

    for (const entry of content.querySelectorAll(".mrw-tree-file")) {
      entry.addEventListener("click", (e) => {
        if (e.target instanceof HTMLInputElement) return; // let the checkbox handle its own click
        focusFile(Number(entry.dataset.fileIndex), true);
      });
      entry.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          focusFile(Number(entry.dataset.fileIndex), true);
        }
      });
    }
    for (const cb of content.querySelectorAll(".tree-viewed")) {
      cb.addEventListener("click", (e) => e.stopPropagation());
      cb.addEventListener("change", () => markViewed(Number(cb.dataset.fileIndex), cb.checked));
    }
    for (const cb of content.querySelectorAll(".file-viewed")) {
      cb.addEventListener("change", () => markViewed(Number(cb.dataset.fileIndex), cb.checked));
    }
    for (const btn of content.querySelectorAll(".collapse-btn")) {
      btn.addEventListener("click", () => {
        const card = btn.closest(".mrw-file");
        card.classList.toggle("is-collapsed");
        btn.innerHTML = card.classList.contains("is-collapsed") ? "&#9656;" : "&#9662;";
      });
    }
    for (const btn of content.querySelectorAll(".copy-path")) {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.fileIndex);
        const f = state.parsed.files[idx];
        copyToClipboard(fileKey(f));
      });
    }
    for (const btn of content.querySelectorAll(".mrw-load-diff")) {
      btn.addEventListener("click", () => {
        const idx = Number(btn.dataset.fileIndex);
        const f = state.parsed.files[idx];
        const card = content.querySelector(`.mrw-file[data-file-index="${idx}"]`);
        const bodyEl = card.querySelector(".mrw-file-body");
        bodyEl.innerHTML = diffBodyHtml(f);
        card.classList.remove("is-collapsed");
      });
    }
  }

  function wireReviewEvents() {
    for (const btn of content.querySelectorAll(".mrw-tab")) {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    }
    const copyBtn = content.querySelector(".copy-sha");
    if (copyBtn) copyBtn.addEventListener("click", () => copyToClipboard(state.pending.view.headSha));

    wireFilesPanelEvents();

    const shaInput = content.querySelector("#approve-sha");
    if (shaInput) shaInput.addEventListener("input", updateApproveButtonState);
    const approveBtn = content.querySelector("#approve-btn");
    if (approveBtn) approveBtn.addEventListener("click", submitApprove);
    const declineBtn = content.querySelector("#decline-btn");
    if (declineBtn) declineBtn.addEventListener("click", submitDecline);

    showAttemptsWarning();
  }

  // --- decided --------------------------------------------------------------

  function renderDecided() {
    const last = state.lastOutcome;
    const decisionLabel = { approved: "Approved", declined: "Declined", canceled: "Canceled" }[last.decision] || last.decision;
    let publishHtml = "";
    if (last.decision === "approved") {
      if (!last.publish) {
        publishHtml = `<p>pushing&hellip;</p>`;
      } else if (last.publish.ok) {
        const safeUrl = safeHttpUrl(last.publish.prUrl);
        publishHtml = safeUrl
          ? `<p class="pr-link"><a href="${esc(safeUrl)}" rel="noopener noreferrer" target="_blank">${esc(safeUrl)}</a></p>`
          : `<p>pushed (no PR URL returned).</p>`;
      } else {
        publishHtml = `<p class="publish-error">push/PR failed: ${esc(last.publish.error)}</p>`;
      }
    }

    const historyHtml = state.history.length
      ? state.history
          .map((h) => {
            return `
        <div class="mrw-history-row">
          <span class="decision ${esc(h.decision)}">${esc(h.decision)}</span>
          <span class="title">${esc(h.title || "(unknown)")}</span>
          <span class="mono">${esc(h.org)}/${esc(h.repo)}@${esc(h.branch)} ${esc(h.shortSha)}</span>
          ${(() => {
            const safeUrl = safeHttpUrl(h.prUrl);
            return safeUrl ? `<a href="${esc(safeUrl)}" rel="noopener noreferrer" target="_blank">PR</a>` : "";
          })()}
        </div>`;
          })
          .join("")
      : `<div class="mrw-history-row mrw-empty">no earlier decisions this session</div>`;

    content.innerHTML = `
      <div class="mrw-decided">
        <div class="panel">
          <div class="mrw-outcome-banner is-${esc(last.decision)}">
            <h2>${esc(decisionLabel)}</h2>
            <span class="channel">via ${esc(last.channel)}</span>
            ${publishHtml}
          </div>
          <div class="mrw-history">
            <div class="hd">Session history</div>
            ${historyHtml}
          </div>
        </div>
      </div>
    `;
  }

  // ==========================================================================
  // Keyboard shortcuts (§3.4: j/k next/prev file, v toggle viewed)
  // ==========================================================================

  document.addEventListener("keydown", (e) => {
    if (state.renderKey === null || !state.renderKey.startsWith("review:")) return;
    if (state.activeTab !== "files") return;
    const target = e.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return;
    if (!state.parsed || state.parsed.files.length === 0) return;

    if (e.key === "j") {
      const next = Math.min(state.activeFileIndex + 1, state.parsed.files.length - 1);
      focusFile(next, true);
    } else if (e.key === "k") {
      const prev = Math.max(state.activeFileIndex - 1, 0);
      focusFile(prev, true);
    } else if (e.key === "v") {
      const viewed = state.viewedFiles.has(fileKey(state.parsed.files[state.activeFileIndex]));
      markViewed(state.activeFileIndex, !viewed);
    }
  });

  // ==========================================================================
  // Boot
  // ==========================================================================

  function initShell() {
    const app = document.getElementById("app");
    app.innerHTML = `
      <div class="mrw-topbar">
        <span class="mrw-conn" id="mrw-conn"><span class="mrw-conn-dot"></span><span class="label">connecting&hellip;</span></span>
        <span class="mrw-theme-toggle" role="group" aria-label="theme">
          <button type="button" data-theme="auto" aria-pressed="false">Auto</button>
          <button type="button" data-theme="light" aria-pressed="false">Light</button>
          <button type="button" data-theme="dark" aria-pressed="false">Dark</button>
        </span>
      </div>
      <div id="mrw-content"></div>
    `;
    content = document.getElementById("mrw-content");
    for (const btn of app.querySelectorAll(".mrw-theme-toggle button")) {
      btn.addEventListener("click", () => setTheme(btn.dataset.theme));
    }
    applyTheme();
    if (boot.accentColor) {
      document.documentElement.style.setProperty("--accent", boot.accentColor);
    }
    // Set via the CSSOM (style.setProperty), never via a literal style=""
    // attribute in generated markup — the CSP has no style-src
    // 'unsafe-inline', so an inline style attribute would silently be
    // dropped by the browser. app.css's table.mrw-diff reads this back via
    // var(--diff-tab-size).
    const tabSize = Number(boot.diff && boot.diff.tabSize);
    document.documentElement.style.setProperty("--diff-tab-size", String(Number.isFinite(tabSize) && tabSize > 0 ? tabSize : 8));
    if (boot.title) document.title = boot.title;
  }

  document.addEventListener("DOMContentLoaded", () => {
    initShell();
    renderIdle();
    state.renderKey = "idle";
    pollOnce().then(() => schedulePoll(effectivePollIntervalMs()));
  });
})();
