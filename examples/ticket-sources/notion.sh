#!/usr/bin/env bash
# EXAMPLE ticket source adapter: Notion.
#
# Copy to scripts/lib/ticket-sources/notion.sh, set ticket_source to "notion"
# in config/workspace.json, and export NOTION_API_TOKEN.
#
# Accepts a Notion page URL or raw page id and prints the page as markdown
# (title + top-level blocks). This is a pragmatic example: it covers common
# block types (paragraphs, headings, lists, code) — extend for your schema.
set -euo pipefail

CMD="${1:-}"
REF="${2:-}"
[ "$CMD" = "fetch" ] && [ -n "$REF" ] || { echo "usage: notion.sh fetch <page-url-or-id>" >&2; exit 2; }
: "${NOTION_API_TOKEN:?NOTION_API_TOKEN is required for the notion adapter}"
command -v jq >/dev/null 2>&1 || { echo "notion adapter requires jq" >&2; exit 3; }

# Extract the page id from the ref. Notion ids appear either dashless
# (32 hex) or as a dashed UUID (8-4-4-4-12); accept both, else use the ref
# as-is. Normalize a dashed id to dashless for the API path.
PAGE_ID="$(printf '%s' "$REF" | grep -oiE '[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}' | tail -1 || true)"
[ -n "$PAGE_ID" ] || PAGE_ID="$REF"
PAGE_ID="$(printf '%s' "$PAGE_ID" | tr -d '-')"

api() {
  curl -sf "https://api.notion.com/v1/$1" \
    -H "Authorization: Bearer $NOTION_API_TOKEN" \
    -H "Notion-Version: 2022-06-28"
}

page_json="$(api "pages/$PAGE_ID")" || { echo "failed to fetch page $PAGE_ID" >&2; exit 1; }
title="$(printf '%s' "$page_json" | jq -r '[.properties[] | select(.type=="title") | .title[].plain_text] | join("")')"
url="$(printf '%s' "$page_json" | jq -r '.url')"

printf '# %s\n\n> Source: %s\n\n' "${title:-Untitled}" "$url"

api "blocks/$PAGE_ID/children?page_size=100" | jq -r '
  def txt(f): [f[]?.plain_text] | join("");
  .results[] |
  if .type == "paragraph"          then txt(.paragraph.rich_text)
  elif .type == "heading_1"        then "# " + txt(.heading_1.rich_text)
  elif .type == "heading_2"        then "## " + txt(.heading_2.rich_text)
  elif .type == "heading_3"        then "### " + txt(.heading_3.rich_text)
  elif .type == "bulleted_list_item" then "- " + txt(.bulleted_list_item.rich_text)
  elif .type == "numbered_list_item" then "1. " + txt(.numbered_list_item.rich_text)
  elif .type == "to_do"            then "- [ ] " + txt(.to_do.rich_text)
  elif .type == "code"             then "```" + (.code.language // "") + "\n" + txt(.code.rich_text) + "\n```"
  elif .type == "quote"            then "> " + txt(.quote.rich_text)
  elif .type == "divider"          then "---"
  else empty
  end'
