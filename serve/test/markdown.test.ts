/**
 * markdown.test.ts — mini-markdown scheme checks + XSS assertions on
 * rendered HTML strings (implementation contract §3, "Tests").
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderMarkdown } from "../src/markdown.js";

test("headings, bold, italic, inline code render as expected tags", () => {
  const out = renderMarkdown("# Title\n\nSome **bold** and *italic* and `code`.");
  assert.match(out, /<h1>Title<\/h1>/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<em>italic<\/em>/);
  assert.match(out, /<code>code<\/code>/);
});

test("fenced code block content is escaped but not further transformed", () => {
  const out = renderMarkdown("```js\nconst x = **not bold** <b>tag</b>;\n```");
  assert.match(out, /<pre><code class="lang-js">/);
  assert.doesNotMatch(out, /<strong>/);
  assert.doesNotMatch(out, /<b>tag<\/b>/);
  assert.match(out, /&lt;b&gt;tag&lt;\/b&gt;/);
});

test("unordered and ordered lists", () => {
  const out = renderMarkdown("- one\n- two\n\n1. first\n2. second");
  assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
  assert.match(out, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
});

test("blockquote and horizontal rule", () => {
  const out = renderMarkdown("> quoted text\n\n---\n");
  assert.match(out, /<blockquote>quoted text<\/blockquote>/);
  assert.match(out, /<hr>/);
});

// --- scheme-checked links ---------------------------------------------

test("http(s) links become <a> with rel=noopener noreferrer", () => {
  const out = renderMarkdown("[click me](https://example.com/path?a=1)");
  assert.match(out, /<a href="https:\/\/example\.com\/path\?a=1" rel="noopener noreferrer">click me<\/a>/);

  const outHttp = renderMarkdown("[plain](http://example.com)");
  assert.match(outHttp, /<a href="http:\/\/example\.com" rel="noopener noreferrer">plain<\/a>/);
});

test("javascript: scheme is NOT turned into a link — rendered as inert escaped text", () => {
  const out = renderMarkdown("[click me](javascript:alert(1))");
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /javascript:alert\(1\)"/); // never lands inside an href attribute
});

test("data: scheme is NOT turned into a link", () => {
  const out = renderMarkdown("[x](data:text/html,<script>alert(1)</script>)");
  assert.doesNotMatch(out, /<a /);
});

test("bare/unknown scheme (no scheme at all) is NOT turned into a link", () => {
  const out = renderMarkdown("[x](evil)");
  assert.doesNotMatch(out, /<a /);
});

test("mailto: is NOT turned into a link (only http/https are allowed)", () => {
  const out = renderMarkdown("[mail](mailto:a@example.com)");
  assert.doesNotMatch(out, /<a /);
});

// --- XSS: hostile input never reaches output unescaped ------------------

test("a <script> tag in the raw body is escaped, never emitted as a real tag", () => {
  const out = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(out, /<script>/);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("an inline attribute-breakout attempt is escaped", () => {
  const out = renderMarkdown('"><img src=x onerror=alert(1)>');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&quot;&gt;&lt;img src=x onerror=alert\(1\)&gt;/);
});

test("javascript: link injection combined with markdown syntax stays inert", () => {
  const out = renderMarkdown("[innocuous text](javascript:alert(document.cookie))");
  // Never a real <a> tag, and specifically never inside an href attribute —
  // the literal text is expected to remain visible (same as GitHub's own
  // handling of an unlinkified URL), it just must never be clickable.
  assert.doesNotMatch(out, /<a /);
  assert.doesNotMatch(out, /href="javascript:/);
});

test("link TEXT containing HTML is escaped even when the URL is a legitimate http(s) link", () => {
  const out = renderMarkdown('[<img src=x onerror=alert(1)>](https://example.com)');
  assert.doesNotMatch(out, /<img/);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<a href="https:\/\/example\.com"/);
});

test("raw HTML anywhere in the body (headings, list items, blockquotes) is always escaped", () => {
  const out = renderMarkdown("# <svg onload=alert(1)>\n\n- <b>bold-ish</b> item\n\n> <iframe src=evil></iframe>");
  assert.doesNotMatch(out, /<svg/);
  assert.doesNotMatch(out, /<iframe/);
  assert.doesNotMatch(out, /<b>bold-ish<\/b>/);
  assert.match(out, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(out, /&lt;iframe src=evil&gt;&lt;\/iframe&gt;/);
});
