# Browser approval (`mrw serve`)

**Status: BUILT.** Companion to [mrw-cli.md](mrw-cli.md) (the "Thread B"
design memo — the decisions this doc implements, verbatim) and
[agent-orchestration.md](agent-orchestration.md) (the broker's sha-typed
human gate this feature renders in a browser, alongside — never instead
of — the existing TTY prompt).

> 🇯🇵 日本語版: [browser-approval.ja.md](browser-approval.ja.md)

## Motivation

The Phase 2 publish broker's sha-typed approval is the **one authoritative
human gate** in this whole design: the broker renders a ground-truth summary
from git objects (never the coder's words) — push target, full diff,
advisory reviewer verdict — on its own container's TTY, and a push only
happens if the human **types the exact short sha**, not a reflexive `y`.
That is deliberately more friction than a button: typing the sha proves the
human looked at *that specific commit*.

A raw terminal is a poor medium for a large multi-file diff, though — no
syntax structure, no collapsible file tree, no "3 / 12 files viewed"
progress. `mrw serve` renders the **exact same ground-truth view** as a
GitHub-PR-style web page (commits tab, files-changed tab with a real diff
viewer, unified/split modes, word-level highlights) while keeping the
approval act itself unchanged: **you still type the short sha**, now into a
page instead of a terminal. The broker still does not trust the rendering
layer — see [Trust model](#trust-model-what-a-compromised-serve-could-and-could-not-do)
below.

`mrw serve` is **off by default** (compose `profiles: ["serve"]`) and is a
**separate, token-less process** — it never holds `BROKER_GITHUB_TOKEN` and
cannot push on its own. It renders and relays only.

## Architecture

```
┌───────────┐   HTTP, localhost-only         ┌────────────┐   unix socket           ┌────────────┐
│  Browser  │ ──────────────────────────────▶│  mrw serve │ ───────────────────────▶│   broker   │
│ (you)     │  session token + CSRF + Host    │ (token-    │  approve-sock (a NEW    │ (holds the │
│           │  header check                   │  less)     │  named volume, NOT the  │  GitHub    │
└───────────┘ ◀────────────────────────────── └────────────┘  publish.sock the coder │  token)    │
      ▲             polls GET /api/state              ▲       side already uses)     └─────┬──────┘
      │                                                │                                    │
      │        type the short sha into the page        └── broker re-verifies the          │ push, if
      │        (the approval act itself, unchanged)        submitted sha IN-PROCESS         │ approved
      └─────────────────────────────────────────────────── against the actual pending       ▼
                                                             publish, before pushing   github.com (or your
                                                             anything — see below      allowed_push_hosts)
```

- **Topology reason for the host port**: named-volume unix sockets do not
  traverse to the macOS host (the same Docker Desktop constraint documented
  throughout `.devcontainer/docker-compose.yml` for `broker-sock` /
  `worker-sock` / `reviewer-sock`), so the browser cannot dial a socket
  directly. `serve` is instead a compose service publishing
  `127.0.0.1:<port>` on the host; the browser talks HTTP to it, and `serve`
  talks the socket protocol to the broker over the new `approve-sock` named
  volume.
- **The TTY gate is unchanged and races the socket.** With
  `BROKER_APPROVAL_SOCKET` unset the broker is byte-identical to before
  Thread B existed. With it set (the default in `docker-compose.yml` now —
  see [Security invariants](#security-invariants)), the broker's
  `ApprovalHub` starts the TTY prompt *and* accepts socket decisions at the
  same time; whichever channel decides first wins, and the other is
  cancelled (the aborted TTY prints one line noting the decision came from
  the browser). This means the browser approval flow is **additive**: you
  can always fall back to `docker compose attach broker` even if `serve` is
  down, mis-configured, or you simply prefer the terminal.
- **The socket protocol (v1)** is three JSON ops, one per connection,
  newline-terminated (same framing spirit as `publish.sock`):
  - `status` — `serve` polls this to learn the current pending publish (a
    `Pending` object carrying every field the TTY header already renders,
    plus a `shortSha` and a `ticket`) and the outcome of the last decision.
  - `approve` — carries the id of the pending publish and the typed sha.
    The broker compares it against **its own** in-memory pending view — not
    anything `serve` asserts — and only resolves APPROVE on an exact match.
    A mismatch decrements a 3-attempt budget; exhausting it auto-declines.
  - `decline` — resolves DECLINE for the given pending id.
  - Every response also carries a `code` on failure (`no_pending`, `stale`,
    `sha_mismatch`, `attempts_exhausted`, `invalid_request`) so `serve` can
    render a precise state instead of a generic error.
- **`serve` re-declares this wire schema locally with zod** — it does not
  import broker source. Same separate-package reasoning as the existing
  `broker/src/reviewer.ts` vs. `reviewer/src/types.ts` split.

## Trust model: what a compromised `serve` could — and could not — do

Stated honestly, per the design memo's own instruction not to paper over
this: **a browser-facing HTTP process is attack surface**, and this section
assumes the worst case — `serve`'s process, container, or the page itself is
fully compromised (malicious code execution, a hostile actor with the
session token, whatever) — and asks what that buys an attacker.

**What it COULD do:**
- Auto-approve the **one exact sha already pending**, to the **same
  allowlist-validated target** (host/org/repo/branch) the TTY gate would
  have pushed to. It cannot choose a *different* sha, a different repo, or
  a different org — the broker's `ApprovalHub.submitApprove(id, sha)`
  compares against its **own** in-memory `Pending` view, constructed from
  git objects the broker itself resolved; `serve` supplies only a string,
  never a decision the broker takes on faith.
- Decline approvals it should not (a denial-of-service on the browser
  channel only — the TTY gate still works, so this cannot block publishing
  outright, only annoy).
- Read the ground-truth view of whatever publish is **already pending**
  (diff, PR body, reviewer verdict) — information already destined for a
  human's eyes at the gate, not previously secret.

**What it could NOT do, structurally:**
- **Push anything itself.** `serve` never holds `BROKER_GITHUB_TOKEN` — that
  credential lives only in the broker's own container env (see
  `.devcontainer/docker-compose.yml`'s `broker` service). `serve`'s
  `docker-compose.yml` service block carries no GitHub credential, no
  `git`, no `gh`, at all.
- **Approve a sha that is not the one actually pending**, or fabricate a
  pending publish out of thin air — the broker's re-verification is
  IN-PROCESS, synchronous, and reads its own state, not anything `serve`
  reports back to it.
- **Tamper with a worktree or the broker's policy.** `serve` gets **no**
  workspace mount, **no** `state_root` (`tasks/`/`repositories/`) mount at
  all — nothing to read or write beyond the approval socket and its own
  read-only cosmetic config.
- **Run arbitrary code the operator didn't build.** `serve`'s only runtime
  dependency is `zod`; both it and the TypeScript source are baked into the
  image at `docker build` time (`.devcontainer/serve.Dockerfile`) — nothing
  the coder-writable workspace tree can write influences a running `serve`
  container. Changing what `serve` executes requires an image rebuild, a
  trusted, human-initiated moment (same supply-chain posture as `broker`
  and `reviewer`).
- **Reach the internet with any real capability.** `serve` sits on its own
  `approve` bridge network (see the next section) with zod-only baked-in
  deps and no secrets — see [Security invariants](#security-invariants) for
  the honest accounting of that network's own tradeoff.

**Every mitigation, listed:**

| # | Mitigation | Where |
|---|---|---|
| 1 | Token-less — never holds `BROKER_GITHUB_TOKEN` | `serve`'s compose env carries no GitHub credential at all |
| 2 | No workspace/state mounts | `serve`'s compose volumes: only `approve-sock` + a read-only cosmetic config bind |
| 3 | zod-only runtime deps, baked in at build | `.devcontainer/serve.Dockerfile` |
| 4 | localhost-only bind + per-session token + CSRF header + Host-header allowlist | `serve`'s own HTTP layer (see [Security invariants](#security-invariants)) |
| 5 | Broker re-verifies the submitted sha IN-PROCESS before pushing | `broker/src/gate.ts`'s `ApprovalHub` |
| 6 | TTY gate unchanged, races the socket, first decision wins | `broker/src/gate.ts` / `broker/src/approve.ts` |
| 7 | Profile-gated, off by default | `docker-compose.yml`'s `profiles: ["serve"]` |
| 8 | `approve-sock` mounted in exactly two services | see [Security invariants](#security-invariants) |

## Setup

Prerequisites: the devcontainer stack is up (`mrw infra-up`), ideally with
`broker` already running (if it isn't, `mrw serve up` still starts and warns
— the page will show a clear "broker unreachable" state until you run
`mrw infra-up`).

```
mrw serve            # same as: mrw serve up
```

This:
1. Resolves the active `config_dir` (same discovery `mrw` always uses —
   `$MRW_CONFIG_DIR`, else the nearest ancestor `.mrw/`, else
   `<toolHome>/config`) and reads `serve.json`'s `port` from it, if present.
2. Applies `--port N` on top, if you passed one.
3. Mints a fresh session token (`crypto.randomBytes(32)`, 64 hex chars —
   well over the minimum this feature's own env contract requires) — a
   **new** token every time you run `mrw serve up`; nothing is persisted
   across runs.
4. Runs `docker compose --profile serve up -d --no-deps serve` — `--no-deps`
   so a running `broker` (which may be holding a live `BROKER_GITHUB_TOKEN`
   in a shell you don't want to re-run) is never recreated as a side effect.
5. Prints `http://localhost:<port>/?token=<token>`, and on macOS opens it in
   your default browser unless you pass `--no-open`.

```
mrw serve down        # stop it
mrw serve status       # docker compose ps serve
mrw serve url          # lost the tab? reprint the tokened URL
```

**Customize before first boot** (see the [customization reference](#customization-reference)
below for every field): edit `config/serve.json` (or `<config_dir>/serve.json`
in workspace mode — `mrw init` copies a starter one) for port/theme/title/
accent color/diff defaults, and drop a `serve.css` next to it for full
cosmetic control. Both are read fresh on container start; there is nothing
to rebuild for a config-only change — `mrw serve down && mrw serve up` picks
it up (the image itself only needs rebuilding if the *code* changes).

## UI guide

The page has three states:

- **idle** — "Waiting for a publish request…", the workspace/ticket label,
  and a connection indicator (green = broker reachable, red = broker
  unreachable — see [Troubleshooting](#troubleshooting)).
- **review** — a pending publish is waiting for a decision. GitHub-PR-like
  layout:
  - Sticky header: title, `org/targetRepo ← branch`, a copyable mono sha
    chip, commit count, `+A −D`, an advisory-reviewer badge (green check /
    orange warning / gray "unavailable" / hidden when the feature is off),
    and a ticket chip when applicable.
  - **Overview** tab: the push-target card (`will push <sha> →
    refs/heads/<branch>`), the PR body (rendered with a small, safe
    markdown subset — headings, bold/italic, code, lists, blockquotes,
    links restricted to `http(s)://`), and the reviewer's notes.
  - **Commits** tab: one row per commit, short-sha chip + subject.
  - **Files changed** tab: a collapsible file tree sidebar (filterable,
    click-to-scroll), per-file cards with a copy button and a "viewed"
    checkbox (persisted in your browser's `localStorage`, drives a
    "3 / 12 files viewed" progress pill and auto-collapses a file once
    checked, like GitHub), unified or side-by-side diff bodies with
    word-level highlights on changed spans, a wrap toggle, and large files
    collapsed behind a "Load diff" button. Keyboard: `j`/`k` next/prev
    file, `v` toggle viewed.
  - Sticky **approval footer**: an input with placeholder `type <shortSha>
    to approve` — the Approve button stays disabled until what you typed
    matches (this is pure UX; the broker re-verifies regardless), a
    warning once fewer than 3 attempts remain, and a Decline button with a
    confirm step.
- **decided** — an outcome banner (approved / declined / canceled, and
  which channel decided it); after an approval, "pushing…" until the push
  result arrives, then either a PR link or the error text; a short session
  history of prior outcomes below it.

Theme: a visible light/dark/auto toggle, persisted in `localStorage`,
defaulting to `serve.json`'s `theme` on first visit and otherwise following
`prefers-color-scheme`.

## Customization reference

`<config_dir>/serve.json` (default `config/serve.json` in this checkout —
see [`../config/serve.json`](../config/serve.json) for the shipped defaults
with inline `_note` documentation on every field). **Every field is
optional**; unknown keys are warned about and ignored, invalid values are
warned about and replaced with the built-in default — `serve` never refuses
to start over this file.

| Field | Default | Meaning |
|---|---|---|
| `port` | `7787` | Published host port `mrw serve up` binds to by default. `--port N` overrides it for one run. |
| `theme` | `"auto"` | Initial theme (`"auto"` \| `"light"` \| `"dark"`); the page's own toggle (in `localStorage`) always wins after the first visit. |
| `title` | `"mrw approval"` | Page `<title>` and header text. |
| `accentColor` | `"#0969da"` | Injected as the CSS custom property `--accent`. |
| `pollIntervalMs` | `2000` | How often the page polls `GET /api/state`. |
| `diff.view` | `"unified"` | `"unified"` or `"split"` (side-by-side) diff layout, initial default. |
| `diff.wrap` | `false` | Soft-wrap long diff lines instead of horizontal scroll. |
| `diff.tabSize` | `8` | Columns per tab character in the diff body. |
| `diff.collapseThresholdLines` | `400` | Files with more changed lines than this (or over 100 KB) render collapsed behind "Load diff". |
| `diff.intralineHighlight` | `true` | Word-level highlighting of the changed span within paired +/- lines. |
| `sections.body` | `true` | Show the PR body on the Overview tab. |
| `sections.commits` | `true` | Show the Commits tab. |
| `sections.reviewer` | `true` | Show the advisory-reviewer verdict card. |
| `sections.fileTree` | `true` | Show the collapsible file-tree sidebar (off ⇒ a flat file list). |
| `customCss` | `true` | When true **and** `<config_dir>/serve.css` exists, serve it as `/assets/custom.css`, loaded **last** (after the built-in stylesheet). |

**CSS variable surface** — `serve.css` is loaded last, so overriding any of
these fully re-themes the page without fighting the built-in rules. The
canonical, authoritative list is documented at the top of the package's own
`app.css` (`serve/src` — keep that comment in sync if this list and the code
ever diverge); as specified for this feature, the stable surface is:

```css
:root {
  --bg: ...;         /* page background */
  --fg: ...;         /* primary text */
  --muted: ...;       /* secondary text */
  --border: ...;      /* hairline borders, dividers */
  --accent: ...;       /* links, buttons, focus rings — overridable via serve.json's accentColor too */
  --add-bg: ...;       /* diff: added-line background */
  --add-fg: ...;       /* diff: added-line text/marker */
  --del-bg: ...;       /* diff: deleted-line background */
  --del-fg: ...;       /* diff: deleted-line text/marker */
  --chip-bg: ...;       /* sha chips, badges */
  /* … see serve/src's app.css header comment for the complete, current list */
}
```

Both light and dark values are defined (the built-in stylesheet has no
`'unsafe-inline'` dependency — everything lives in `/assets/app.css` /
`/assets/custom.css`, never inline `<style>`, per the page's CSP).

## Security invariants

These are the properties this feature must never regress, cross-referenced
to where each is enforced:

- **`approve-sock` is mounted in exactly two services: `broker` and
  `serve`.** This is checked by construction in
  `.devcontainer/docker-compose.yml` (search for `approve-sock` — it
  appears only in those two services' `volumes:`) and called out with a
  `CRITICAL INVARIANT` comment at both the `broker` service's volume entry
  and the top-level `volumes:` declaration. **Never** add this volume to
  `worker`, `orchestrator`, or `reviewer`: any of those cages already knows
  its own pending commit sha, and holding this socket on top of that would
  let it self-approve its own publish — the entire point of the sha-typed
  human gate is that the party proposing a change cannot also be the party
  confirming it.
- **Every route but `/healthz` requires a valid session cookie**, set only
  by a timing-safe token compare on the bootstrap URL
  (`/?token=<t>` → `Set-Cookie: mrw_serve=…; HttpOnly; SameSite=Strict`).
- **Every POST additionally requires** a same-allowlist `Origin` header and
  an `x-mrw-csrf` header derived from the session token — delivered to the
  page only via the boot payload, never guessable from the URL alone.
- **Host-header allowlist** (`localhost`, `127.0.0.1`, `[::1]`, any port) on
  every request — closes DNS-rebinding: a hostile page on the open internet
  cannot point your browser at `serve` by resolving an attacker-controlled
  domain to `127.0.0.1`, because the `Host` header itself is checked, not
  just where the TCP connection landed.
- **`SERVE_SESSION_TOKEN` is fail-closed in-process**: empty or under 32
  characters ⇒ `serve` logs and `exit(1)` rather than ever listening
  unauthenticated. `mrw serve up` always mints a fresh 64-hex-char token, so
  this path is never exercised in the intended flow — it exists for anyone
  running the `serve` image by hand outside `mrw`.
- **No inline scripts or styles anywhere** — the CSP
  (`default-src 'none'; script-src 'self'; style-src 'self'; …`) has no
  `'unsafe-inline'`; all JS/CSS lives in `/assets/*` files baked into the
  image.
- **The published port is `127.0.0.1` only**, never `0.0.0.0`, at the
  compose `ports:` level (`SERVE_BIND=0.0.0.0` is safe only *because of*
  that host-side restriction — see the `serve` service's own comment in
  `docker-compose.yml`).
- **The `approve` network is a non-internal bridge** (unlike `caged`), which
  is an honest, accepted tradeoff, not an oversight — see that network's
  comment block in `docker-compose.yml` and the
  [Trust model](#trust-model-what-a-compromised-serve-could-and-could-not-do)
  section above for the full reasoning.

## Troubleshooting

- **Page shows "broker unreachable".** The `serve` process can reach the
  `approve-sock` volume but nothing is listening on the far end — almost
  always the `broker` container is not running. Run `mrw infra-up` (or
  check `docker compose -f .devcontainer/docker-compose.yml ps broker`) and
  the page recovers on its next poll; no restart of `serve` needed.
- **Lost the tab / URL / token.** Run `mrw serve url` — it reads the
  running `serve` container's actual published port and session token back
  out (`docker port` / `docker inspect`) and reprints
  `http://localhost:<port>/?token=<token>`. It errors cleanly if `serve`
  isn't running (`mrw serve up` first).
- **Port already in use / want a different port.** `mrw serve up --port N`
  for one run, or set `"port"` in `serve.json` permanently. `mrw serve
  down` first if a previous instance is still holding the old port.
- **403 on the bootstrap URL.** The token in the URL doesn't match the
  running container's `SERVE_SESSION_TOKEN` — usually because the URL is
  stale (from a previous `mrw serve up`, which mints a new token every
  time). Run `mrw serve url` for the current one.
- **403 with a valid-looking token.** Check the `Host` you're browsing to —
  it must be exactly `localhost`, `127.0.0.1`, or `[::1]`. A reverse proxy,
  SSH port-forward that rewrites `Host`, or a `/etc/hosts` alias will fail
  this check by design (see [Security invariants](#security-invariants)) —
  this feature is intentionally not built for remote/tunneled access (see
  "Out of scope" in `mrw-cli.md`'s Thread B section).
- **Approve button never enables.** It only enables once the typed text
  exactly matches the short sha shown in the header (case-sensitive,
  whitespace-trimmed) — this is deliberate friction, the same property the
  TTY gate has always had.
- **"attempts exhausted" / auto-declined.** Three wrong sha submissions
  auto-decline the pending publish (same budget the protocol enforces
  server-side, not just a UI limit) — re-run the publish step to get a new
  pending request and a fresh attempt budget.
