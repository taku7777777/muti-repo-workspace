/**
 * html.ts — the escaping primitives every render boundary in this package
 * goes through, plus the SSR app-chrome shell (GET / — see routes.ts).
 *
 * Nothing broker-sourced is HTML by the time it reaches here (see wire.ts's
 * header comment): title/body/notes/paths/etc. are raw strings the coder
 * authored. This file is the one place that turns raw strings into HTML, and
 * it does so by escaping FIRST, always — never by trusting a caller to have
 * already done it. assets/app.js re-implements the SAME escaping discipline
 * for the fields it renders client-side (the CSP forbids inline
 * script/style, so the review UI itself is built in the browser, not here —
 * see routes.ts's GET / doc comment). The render* helpers below exist so
 * that discipline has ONE tested, canonical TS reference — mirrored by hand
 * into app.js's equivalent functions — and so the "XSS assertions on
 * rendered HTML strings" tests (§3, Tests) have real HTML to assert against
 * without standing up a browser.
 */

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Built via String.fromCharCode rather than a literal character in source:
// U+2028 LINE SEPARATOR / U+2029 PARAGRAPH SEPARATOR are LineTerminator code
// points and must never appear as raw source bytes in this file (a raw one
// inside a regex literal is a syntax error; inside a plain string literal it
// would silently make this file's own line numbers lie). String.fromCharCode
// builds them at runtime instead, and .split(...).join(...) below avoids
// needing them in a regex literal at all.
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/**
 * Serialize `value` for embedding inside `<script type="application/json">`.
 * Two independent HTML-parser hazards, not JSON hazards (JSON.parse handles
 * both fine either way):
 *  - a `</script` substring anywhere in a string value would end the
 *    element early as far as the HTML PARSER is concerned, regardless of
 *    JSON/JS syntax — escape every `<` as the JSON-legal `<` escape.
 *  - U+2028/U+2029 are legal, unescaped in JSON strings but have historically
 *    been mishandled by naive "embed JSON as if it were JS" recipes — escape
 *    them too, defense in depth, since it costs nothing and JSON.parse
 *    round-trips \u-escapes losslessly.
 */
export function escapeBootJson(value: unknown): string {
  return JSON.stringify(value)
    .split("<")
    .join("\\u003C")
    .split(LINE_SEPARATOR)
    .join("\\u2028")
    .split(PARAGRAPH_SEPARATOR)
    .join("\\u2029");
}

export interface DiffConfig {
  view: "unified" | "split";
  wrap: boolean;
  tabSize: number;
  collapseThresholdLines: number;
  intralineHighlight: boolean;
}

export interface SectionsConfig {
  body: boolean;
  commits: boolean;
  reviewer: boolean;
  fileTree: boolean;
}

export interface BootPayload {
  csrf: string;
  title: string;
  theme: "auto" | "light" | "dark";
  accentColor: string;
  pollIntervalMs: number;
  diff: DiffConfig;
  sections: SectionsConfig;
}

/**
 * The SSR shell is APP CHROME ONLY (implementation contract §3.3: "the
 * pending view itself arrives via /api/state so the page live-updates").
 * The boot JSON therefore carries config + csrf, never broker-sourced data —
 * there is nothing coder-authored for this function to mis-escape, which is
 * deliberate: it keeps the one HTML-generating route in the whole package
 * free of untrusted content by construction. Everything untrusted flows
 * through JSON (/api/state, /api/approve, /api/decline) and is escaped by
 * app.js at the point it touches the DOM.
 */
export function renderShell(boot: BootPayload, customCssAvailable: boolean): string {
  const titleHtml = escapeHtml(boot.title);
  const bootJson = escapeBootJson(boot);
  const customCssLink = customCssAvailable ? '\n<link rel="stylesheet" href="/assets/custom.css">' : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${titleHtml}</title>
<link rel="stylesheet" href="/assets/app.css">${customCssLink}
</head>
<body>
<div id="app" role="main">
<p class="boot-loading">Loading mrw approval&hellip;</p>
</div>
<script type="application/json" id="boot">${bootJson}</script>
<script src="/assets/app.js"></script>
</body>
</html>
`;
}

// --- canonical render-boundary helpers (mirrored by hand into app.js) ------

/** Escaped path, or `old -> new` for a rename/copy whose paths differ. */
export function renderFilePathHtml(oldPath: string | null, newPath: string | null): string {
  if (oldPath !== null && newPath !== null && oldPath !== newPath) {
    return (
      escapeHtml(oldPath) +
      ' <span class="rename-arrow" aria-hidden="true">&rarr;</span> ' +
      escapeHtml(newPath)
    );
  }
  const p = newPath ?? oldPath ?? "(unknown path)";
  return escapeHtml(p);
}

/** Escaped free text with newlines preserved as <br> (reviewer notes, PR body fallback). */
export function renderTextWithBreaksHtml(text: string): string {
  return escapeHtml(text).replace(/\n/g, "<br>");
}

export function renderTitleHtml(title: string): string {
  return `<h1 class="pr-title">${escapeHtml(title)}</h1>`;
}

export function renderShaChipHtml(shortSha: string): string {
  return `<code class="sha-chip">${escapeHtml(shortSha)}</code>`;
}
