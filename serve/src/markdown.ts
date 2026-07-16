/**
 * markdown.ts — a SAFE mini-markdown renderer for the coder-authored PR body
 * (implementation contract §3.4: "PR body rendered with a SAFE mini-markdown
 * (escape-first: escape ALL HTML, then transform...)").
 *
 * The whole safety argument rests on ONE ordering rule: escape the entire
 * raw input to HTML entities BEFORE any markdown transform runs. Every
 * transform below therefore only ever wraps ALREADY-INERT text in tags WE
 * chose — there is no code path where raw, attacker-controlled `<`/`>`/`"`
 * can reach the output, because by the time transforms run those bytes are
 * `&lt;`/`&gt;`/`&quot;` and no longer meaningful to an HTML parser. This is
 * why link hrefs below need no separate attribute-escaping step: the URL
 * text was already entity-escaped in the first pass.
 *
 * Intentionally NOT CommonMark: only the constructs implementation contract
 * §3.4 lists (headings, bold/italic, inline code, fenced code blocks, -/1.
 * lists, blockquotes, hr, and scheme-checked http(s) links). No nested
 * lists, no tables, no raw HTML passthrough (impossible by construction —
 * see above).
 *
 * assets/app.js carries a hand-written port of this same algorithm for the
 * browser (no build step turns this .ts file into something a script tag
 * can load) — see diff.ts's header comment for why that duplication is the
 * established posture at this package's boundaries.
 */
import { escapeHtml } from "./html.js";

// Placeholder delimiters for protecting inline code spans from further
// transforms. \x01/\x02 (SOH/STX) are control characters that never appear
// in the escaped text a coder's PR body could produce, so there is no
// realistic collision — and even a contrived collision would only garble
// rendering, never re-open an HTML injection (the substitution only ever
// wraps text in a <code> tag we control).
const CODE_TOKEN_OPEN = "\x01\x02CS";
const CODE_TOKEN_CLOSE = "\x02\x01";

function renderInline(escapedText: string): string {
  const codeSpans: string[] = [];
  let out = escapedText.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return `${CODE_TOKEN_OPEN}${codeSpans.length - 1}${CODE_TOKEN_CLOSE}`;
  });

  // [text](http(s)://url) ONLY — any other scheme (javascript:, data:, a
  // bare "evil" string, mailto:, etc.) is left as inert, already-escaped
  // literal text instead of becoming a link. `url` here is already
  // HTML-entity-escaped (see the module doc comment), so embedding it
  // straight into href="..." cannot break out of the attribute.
  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (whole, text: string, url: string) => {
    if (/^https?:\/\//i.test(url)) {
      return `<a href="${url}" rel="noopener noreferrer">${text}</a>`;
    }
    return whole;
  });

  out = out.replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^\n]+?)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^\n]+?)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[^\w])_([^\n_]+?)_(?!\w)/g, "$1<em>$2</em>");

  out = out.replace(new RegExp(`${CODE_TOKEN_OPEN}(\\d+)${CODE_TOKEN_CLOSE}`, "g"), (_m, idx: string) => {
    const span = codeSpans[Number(idx)] ?? "";
    return `<code>${span}</code>`;
  });
  return out;
}

const FENCE_RE = /^```(\w*)\s*$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
// Matches "&gt;", NOT ">" — block detection below runs on text that was
// ALREADY escaped (see renderMarkdown's `escaped` below), and ">" is one of
// the five characters escapeHtml() converts. Every other block marker here
// (#, -, *, _, backtick, digits) survives escaping unchanged, but the
// blockquote marker does not, so it alone needs the escaped spelling.
const BLOCKQUOTE_RE = /^&gt;\s?(.*)$/;
const UL_ITEM_RE = /^[-*]\s+(.*)$/;
const OL_ITEM_RE = /^\d+\.\s+(.*)$/;

export function renderMarkdown(raw: string): string {
  // Escape-first: EVERYTHING below this line operates on already-inert text.
  const escaped = escapeHtml(raw).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = escaped.split("\n");
  const out: string[] = [];

  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      out.push(`<p>${renderInline(paragraph.join("\n"))}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      const tag = list.ordered ? "ol" : "ul";
      out.push(`<${tag}>${list.items.map((it) => `<li>${renderInline(it)}</li>`).join("")}</${tag}>`);
      list = null;
    }
  };
  const flushQuote = () => {
    if (quote.length) {
      out.push(`<blockquote>${renderInline(quote.join("\n"))}</blockquote>`);
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

    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushAll();
      const lang = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      i++; // consume the closing fence, if any (unterminated fences just run to EOF)
      // `lang` is constrained to \w* by FENCE_RE — no HTML-breaking chars possible.
      const langAttr = lang ? ` class="lang-${lang}"` : "";
      out.push(`<pre><code${langAttr}>${body.join("\n")}</code></pre>`);
      continue;
    }

    if (HR_RE.test(line)) {
      flushAll();
      out.push("<hr>");
      i++;
      continue;
    }

    const heading = HEADING_RE.exec(line);
    if (heading) {
      flushAll();
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      i++;
      continue;
    }

    const bq = BLOCKQUOTE_RE.exec(line);
    if (bq) {
      flushParagraph();
      flushList();
      quote.push(bq[1]);
      i++;
      continue;
    }
    if (quote.length) flushQuote();

    const ul = UL_ITEM_RE.exec(line);
    const ol = OL_ITEM_RE.exec(line);
    if (ul || ol) {
      flushParagraph();
      const ordered = !!ol;
      const content = (ul ?? ol)![1];
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
