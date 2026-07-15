# Agent role taxonomy (design memo)

**Status: DESIGN, not built.** This memo defines the role archetypes the
workspace should grow into. It is the concrete form of the "multi-worker
archetypes (coder / reader / researcher / documenter …) are a planned
extension" note in [architecture.md](architecture.md), extended with a
`researcher`/`reporter` split for external read vs write. Nothing here is
implemented yet; it exists so that when the container path
([devcontainer-status.md](devcontainer-status.md)) grows more roles, each new
role is placed against a boundary, not invented ad hoc.

## The organizing principle

A role is **not** a fine-grained permission list. A role is **one distinct
containment boundary**, named by its purpose. Two roles are worth separating
if — and only if — they fall in different cells of the boundary matrix below.
Two purposes that land in the same cell do **not** need separate roles (that is
splitting too finely).

Only two axes actually decide containment in this workspace. Everything else
(which model, which MCP servers, prompt wording) is configuration *within* a
role, not a reason to mint a new one.

| Axis | Values | Why it is the axis that matters |
|---|---|---|
| **Source write** | `none` · `docs-only` · `code` | `code` means build/lint/test — i.e. **arbitrary code execution** from attacker-influenceable scripts. This is the highest-blast-radius capability. |
| **External egress** | `none` · `read-allowlist` · `write-allowlist` | The only way data leaves the boundary. Read and write egress are **different allowlists and different roles** — a role that can read a malicious source can be steered; it must not also be able to write out. |

**Enforcement rule (non-negotiable):** each boundary is enforced
*fail-closed* by the OS / network topology (network namespace, mounts, an
egress-proxy allowlist), **never** by Claude Code's in-app permission rules.
The workspace's own measurements found the in-app layer to be fail-open
(path-scoped `deny` is a no-op; Read/Write/WebFetch/MCP/hooks bypass the
sandbox; local-settings drift re-opens denies). Coarse roles are safe *only*
because each is backed by a real OS boundary. A coarse role enforced by app
permissions is worse than no role.

## The boundary matrix

|            | egress `none` | egress `read-allowlist` | egress `write-allowlist` |
|---|---|---|---|
| **write `none`**      | — | **Researcher**, **Reviewer** | **Reporter** |
| **write `docs-only`** | **Documenter** | (docs + read research, if ever needed) | — |
| **write `code`**      | **Coder** | 🚫 forbidden combination | 🚫 forbidden combination |

The two 🚫 cells are the whole point: **`code` write must never coexist with
any external egress.** A cell in the matrix that would combine them is a design
red flag — reject it, or route the egress need through a *separate* role +
human gate instead.

## Roles

Each role below is: a purpose, its matrix cell, the tool posture, the boundary
that enforces it, and the injection story (what a prompt-injected instance of
this role can and cannot do).

### Coder
- **Purpose:** implement, lint, build, test. Edits source.
- **Cell:** write `code` × egress `none`.
- **Tools:** edit + Bash (must run the test runner). No network tools (there is
  no egress for them to use anyway).
- **Boundary:** caged container on an `internal: true` network — zero route to
  the internet. This is exactly today's harness coder / macOS `worker`.
- **Injection story:** the most easily injected role (it reads the repo and
  runs its code), and therefore the *most* caged. Injected → it can corrupt its
  own worktree, but cannot exfiltrate, cannot push, cannot reach any external
  service. Containment is the network boundary, not its good behavior.

### Documenter
- **Purpose:** non-source docs, design authoring, knowledge aggregation.
- **Cell:** write `docs-only` × egress `none` (or `anthropic-only`).
- **Tools:** edit restricted to the docs/knowledge subtree; read across source
  for context. No Bash test/build need.
- **Boundary:** container/uid whose only writable mount is the docs subtree;
  source mounted read-only.
- **Injection story:** cannot touch source, cannot execute, cannot egress. Worst
  case is bad docs in its own writable subtree.

### Reviewer
- **Purpose:** read-only judge of a diff/design. Independence is the feature.
- **Cell:** write `none` × egress `read-allowlist` (usually `none` — reads the
  diff handed to it in-prompt).
- **Tools:** read-only, enforced with `tools: READ_ONLY_TOOLS` **and**
  `disallowedTools: DENY_MUTATION` (under bypassPermissions, allowlist alone
  does not remove Edit/Write/Bash), and `settingSources: []` so a malicious
  target-repo `CLAUDE.md` cannot instruct the judge. This is verbatim today's
  harness REVIEW step.
- **Boundary:** separate session/instance from Coder — never the same one that
  wrote the code (independence). If containerized, a read-only mount.
- **Injection story:** no write, no egress → an injected reviewer can only lie
  in its verdict; the verdict is advisory to a human gate + the exit-code test
  gate, never the sole decider.

### Researcher
- **Purpose:** investigate — Slack, Notion, source logs, Datadog, cloud logging.
  Read-only, both on source and externally.
- **Cell:** write `none` × egress `read-allowlist`.
- **Tools:** read on source; a **read-only** external allowlist (specific hosts,
  ideally specific read APIs). No edit, no push, no external write.
- **Boundary:** its own egress-proxy allowlist admitting only the read
  endpoints it needs; source mounted read-only; no writable source mount.
- **Injection story:** this is the **new attack surface** the taxonomy
  introduces. A researcher that reads an attacker-controlled Datadog log / Notion
  page can be steered. It is contained *because* it has no write egress and no
  source write — it can be fooled, but has no channel to act on the fooling.
  This is exactly why Researcher and Reporter are split.

### Reporter
- **Purpose:** write/reply to a narrow set of external destinations (Slack,
  Notion). Limited means, limited resources.
- **Cell:** write `none` (source) × egress `write-allowlist`.
- **Tools:** external write to a **narrow, per-destination** allowlist. No source
  read/write need beyond what it is handed.
- **Boundary:** an egress-proxy allowlist admitting only the write endpoints;
  a *different* allowlist from Researcher's read one.
- **Injection story:** can post to its allowlisted destinations, nothing else.
  Blast radius = "an unwanted Slack/Notion message," not exfiltration to an
  arbitrary host. **git push / PR creation is NOT a Reporter capability** — see
  invariants.

## Invariants (the guardrails that keep this safe as it grows)

1. **Every boundary is fail-closed at the OS/topology layer**, never an in-app
   permission rule. New role → new OS boundary (namespace / mount / egress
   allowlist), or it does not exist.
2. **`code` write never coexists with external egress.** The Coder stays on an
   internal-only network. No exceptions, no "just for this one dep fetch."
3. **Reviewer independence is structural**, not prompted: read-only tools +
   `settingSources: []` + a *different instance* than the Coder that produced
   the diff.
4. **git push / PR / publish is not one of these five roles.** It stays isolated
   in the out-of-container **broker** (its own container, its own trust, holds
   the only token, human-gated, re-renders ground truth from a fetched sha).
   Reporter's "external write" is Slack/Notion-class destinations only; code
   publication is a separate, more-gated boundary. Do not merge them for
   convenience.

## Egress allowlist — per role (template)

Egress is defined *per role*, as the union of nothing by default. Fill only what
a role provably needs; the proxy denies everything else fail-closed.

| Role | egress allowlist (illustrative — set real hosts in config) |
|---|---|
| Coder | *(empty — internal network only)* |
| Documenter | *(empty; `api.anthropic.com` only if it drives an LLM itself)* |
| Reviewer | *(empty; reads the diff in-prompt)* |
| Researcher | `*.slack.com` (read) · `api.notion.com` (read) · `api.datadoghq.com` (read) · cloud-logging read endpoints |
| Reporter | `slack.com/api/chat.postMessage` · `api.notion.com` (write) — nothing else |

Two rules for this table: (a) read and write endpoints for the *same* product
(Slack read vs Slack write) live in **different roles**, not one merged
allowlist; (b) if a role's allowlist would need a code-host (github.com,
package registries) for *writing*, that is the broker's job, not this role's.

## Mapping onto the container topology

The current devcontainer proves the pattern with three containers: `coder`
(caged), `broker` (token holder), `egress-proxy` (allowlist). These roles slot
onto the same primitives:

- **Coder** = today's `coder` service, unchanged.
- **Documenter / Reviewer** = read-only or docs-only variants of the coder
  boundary (source mounted `:ro`, or only the docs subtree writable). Same
  internal-only network as Coder — no egress.
- **Researcher / Reporter** = the first roles that legitimately touch the
  `egress` network, each behind the egress-proxy with its **own** allowlist.
  They never hold a push token (that is the broker's alone).
- **Broker** = unchanged; the only publisher.

**Instance policy (from the shared-vs-disposable discussion):** a role defines
an *image/policy* (its boundary profile). Instances are **per-ticket disposable**,
not shared across tickets. Sharing one long-lived container across tickets would
(a) accumulate every ticket's secrets in one place and (b) force task isolation
back onto fail-open directory ACLs — both rejected. Cost is controlled by
templating the role image and throwing instances away, not by pooling.

**Adoption order (agreed 2026-07-15):** the first concrete increment after the
Phase 2/3 live validations is a **read-only judge container** — source mounted
`:ro`, `api.anthropic.com`-only egress — running the harness PLAN and REVIEW
steps. Plan and Review land in the *same* cell of the boundary matrix (write
`none` × egress anthropic-only), so **one profile serves both** — splitting
per-step would be splitting too finely. This upgrades review independence from
app-layer tool scoping (`tools`/`disallowedTools`) to an OS boundary; Implement
stays in today's coder container (its cell is unchanged, and its containment
never rested on tool scoping). Further role splits (Documenter / Researcher /
Reporter) wait for the dispatch control plane
([agent-dispatch.md](agent-dispatch.md)) — cross-container handoffs must be
typed and dispatcher-mediated before more roles exist.

## Open questions / next steps

1. **Reviewer vs Researcher overlap:** both are `write:none`. Keep separate
   roles (Reviewer = code-diff judge with `settingSources:[]`; Researcher =
   external read) or one read-only role with two configs? Leaning: separate,
   because their egress differs (Reviewer none, Researcher read-allowlist).
2. **Does Documenter ever need Researcher's read egress** (pull a Notion design
   doc to write from)? If yes, that is the `docs-only × read-allowlist` cell —
   allowed, but make it a deliberate, separately-allowlisted role, not a quiet
   widening of Documenter.
3. **How does a role invoke another?** (e.g. Coder finishes → Reviewer judges →
   Reporter announces.) Needs a `.worker-targets` map + a spawn/dispatch skill,
   per the architecture.md planned extension. The dispatcher, not the roles,
   holds the sequencing — keep it out of the caged roles. Design in
   [agent-dispatch.md](agent-dispatch.md).
4. **Validation:** none of this is booted live. Before adopting Researcher/
   Reporter, add a minimal egress-allowlist test per role proving the proxy
   admits exactly the intended endpoints and denies the rest (extend
   `scripts/egress-selfcheck.sh`). Design in
   [egress-selfcheck-per-role.md](egress-selfcheck-per-role.md).
