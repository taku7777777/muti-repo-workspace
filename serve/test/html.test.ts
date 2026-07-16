/**
 * html.test.ts — the escaping primitives + SSR shell (§3, "Tests": "XSS:
 * hostile title/body/notes/paths (`<script>`, `"><img onerror`,
 * `](javascript:...)`) never reach output unescaped — assert on rendered
 * HTML strings").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  escapeBootJson,
  escapeHtml,
  renderFilePathHtml,
  renderShaChipHtml,
  renderShell,
  renderTextWithBreaksHtml,
  renderTitleHtml,
  type BootPayload,
} from "../src/html.js";

test("escapeHtml escapes all five HTML-significant characters", () => {
  assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
});

test("escapeHtml neutralizes a <script> tag", () => {
  const out = escapeHtml("<script>alert(1)</script>");
  assert.doesNotMatch(out, /<script>/);
  assert.equal(out, "&lt;script&gt;alert(1)&lt;/script&gt;");
});

test("escapeHtml neutralizes an attribute-breakout attempt", () => {
  const out = escapeHtml(`"><img src=x onerror=alert(1)>`);
  assert.doesNotMatch(out, /<img/);
  assert.equal(out, "&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
});

// --- boot JSON embedding --------------------------------------------------

test("escapeBootJson round-trips through JSON.parse", () => {
  const value = { a: 1, b: "hello <world> /  line sep" };
  const embedded = escapeBootJson(value);
  const parsedBack = JSON.parse(embedded);
  assert.deepEqual(parsedBack, value);
});

test("escapeBootJson prevents a </script> breakout", () => {
  const hostile = { title: "</script><script>alert(1)</script>" };
  const embedded = escapeBootJson(hostile);
  assert.doesNotMatch(embedded, /<\/script>/i);
  assert.doesNotMatch(embedded, /<script>/i);
  // still round-trips to the original string
  assert.equal(JSON.parse(embedded).title, hostile.title);
});

test("escapeBootJson escapes U+2028/U+2029", () => {
  const embedded = escapeBootJson({ s: `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}` });
  assert.doesNotMatch(embedded, new RegExp(String.fromCharCode(0x2028)));
  assert.doesNotMatch(embedded, new RegExp(String.fromCharCode(0x2029)));
  assert.match(embedded, /\\u2028\\u2029/);
});

// --- SSR shell -------------------------------------------------------------

const BASE_BOOT: BootPayload = {
  csrf: "deadbeef",
  title: "mrw approval",
  theme: "auto",
  accentColor: "#0969da",
  pollIntervalMs: 2000,
  diff: { view: "unified", wrap: false, tabSize: 8, collapseThresholdLines: 400, intralineHighlight: true },
  sections: { body: true, commits: true, reviewer: true, fileTree: true },
};

test("renderShell embeds an escaped <title> and a safe boot script", () => {
  const html = renderShell(BASE_BOOT, false);
  assert.match(html, /<title>mrw approval<\/title>/);
  assert.match(html, /<script type="application\/json" id="boot">/);
  assert.match(html, /<script src="\/assets\/app\.js"><\/script>/);
  assert.doesNotMatch(html, /<link rel="stylesheet" href="\/assets\/custom\.css">/);
});

test("renderShell links custom.css only when customCssAvailable is true", () => {
  const html = renderShell(BASE_BOOT, true);
  assert.match(html, /<link rel="stylesheet" href="\/assets\/custom\.css">/);
});

test("renderShell with a HOSTILE title never emits an unescaped <script> or breakout", () => {
  const hostileBoot: BootPayload = { ...BASE_BOOT, title: '<script>alert(1)</script>"><img onerror=alert(2)>' };
  const html = renderShell(hostileBoot, false);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.doesNotMatch(html, /<img onerror/);
  // the title tag itself only ever contains entity-escaped text
  assert.match(html, /<title>&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&gt;&lt;img onerror=alert\(2\)&gt;<\/title>/);
});

// --- render-boundary helpers ------------------------------------------------

test("renderFilePathHtml: plain path is escaped", () => {
  assert.equal(renderFilePathHtml("src/a.ts", "src/a.ts"), "src/a.ts");
});

test("renderFilePathHtml: rename renders 'old -> new' with both sides escaped", () => {
  const out = renderFilePathHtml('<script>old</script>', '<script>new</script>');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;old&lt;\/script&gt;/);
  assert.match(out, /&lt;script&gt;new&lt;\/script&gt;/);
  assert.match(out, /rename-arrow/);
});

test("renderTextWithBreaksHtml preserves newlines as <br> and escapes hostile content", () => {
  const out = renderTextWithBreaksHtml('line one\n<script>alert(1)</script>\nline three');
  assert.doesNotMatch(out, /<script>/);
  assert.equal(out, "line one<br>&lt;script&gt;alert(1)&lt;/script&gt;<br>line three");
});

test("renderTitleHtml escapes a hostile title", () => {
  const out = renderTitleHtml('<script>alert(1)</script>');
  assert.doesNotMatch(out, /<script>alert/);
  assert.match(out, /<h1 class="pr-title">&lt;script&gt;alert\(1\)&lt;\/script&gt;<\/h1>/);
});

test("renderShaChipHtml escapes its input even though shortSha is normally hex", () => {
  const out = renderShaChipHtml('<script>x</script>');
  assert.doesNotMatch(out, /<script>x/);
});
