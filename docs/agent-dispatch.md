# Agent dispatch — the `.worker-targets` control plane (design memo)

**Status: DESIGN, not built.** Companion to [agent-roles.md](agent-roles.md).
That memo defines *what the roles are*; this one defines *how one role hands off
to another* without any caged role gaining a capability it does not own. It is
the concrete form of the "`.worker-targets` map + a spawn-worker skill" planned
extension in [architecture.md](architecture.md).

## The one rule that makes dispatch safe

**The dispatcher is a trusted control plane. The roles are caged leaves.**
Sequencing — "Coder finished → have Reviewer judge → have Reporter announce" —
lives in the dispatcher, **never inside a caged role**. A caged role cannot:

- choose *which* role runs next,
- rewrite the target map to point a role name at a different surface,
- hand another role a raw payload that becomes that role's action verbatim.

If any of those were possible, dispatch would become an escape hatch: a
prompt-injected Coder (no egress by construction) could simply *ask the
Reporter* to post its secret, and exfiltrate through a role that legitimately
has write-egress. **Dispatch transitions are themselves a security boundary**,
governed exactly like the publish broker: typed intents, re-validation on the
trusted side, and a human gate on any transition that crosses into egress.

## Two precedents already in the tree

1. **macOS `.worker-target` (singular).** /open-task pins the worker's cmux
   surface **UUID** into `agents/orchestrator/.claude/skills/.worker-target`.
   The orchestrator can read it but not rewrite it (denyWrite), and the
   messaging scripts reject `--workspace`/`--surface` overrides — so an
   orchestrator can only ever command *its own* worker, regardless of a runtime
   prompt. Dispatch generalizes this from one target to a **named map**, keeping
   the same pin discipline (trusted writer, read-only to roles, id-pinned,
   no override).

2. **The harness driver (coded control plane).** `harness/src/multi/driver.ts`
   is already a dispatcher for one flow: it plans every repo, takes combined
   human gates, and runs each repo through the Phase-1 pipeline sequentially,
   deferring publish to the broker. Determinism comes from the coded flow; the
   LLM steps are leaves; the only deciders are typed verdicts, the test gate's
   exit code, and human gates. Multi-role dispatch is the **same shape**, widened
   from "N repos, one role (coder)" to "one ticket, several roles."

## `.worker-targets` — the map

A trusted-side file (written by the task creator, read-only to every role),
resolving a **role name** to a concrete, pinned surface/container — never a
free-form address a role can point elsewhere.

```jsonc
// tasks/<TICKET>/.worker-targets  (illustrative)
{
  "coder":      { "kind": "container", "id": "<container-uuid>", "boundary": "caged-internal" },
  "reviewer":   { "kind": "container", "id": "<container-uuid>", "boundary": "readonly-internal" },
  "documenter": { "kind": "container", "id": "<container-uuid>", "boundary": "docs-only-internal" },
  "researcher": { "kind": "container", "id": "<container-uuid>", "boundary": "egress-read" },
  "reporter":   { "kind": "container", "id": "<container-uuid>", "boundary": "egress-write" }
}
```

Pin discipline (carried over verbatim from `.worker-target`): ids are opaque and
assigned at creation; the file is denyWrite for every role; the dispatch/
messaging layer refuses any caller-supplied target override and resolves the
target **only** by role name against this map. A role never names a surface, only
a role; the dispatcher owns the name→surface binding.

## The transition allowlist (the dispatch matrix)

Not every role may hand off to every other. The allowed transitions are a fixed,
trusted-side matrix; the dispatcher enforces it. Illustrative default:

| from → to | Reviewer | Documenter | Researcher | Reporter | broker (publish) |
|---|---|---|---|---|---|
| **Coder** | ✅ typed diff | ✅ typed notes | ➖ via dispatcher only | 🚫 (see below) | 🔒 human-gated |
| **Researcher** | ➖ | ✅ findings | — | 🔒 human-gated | 🚫 |
| **Reviewer** | — | ➖ | ➖ | 🚫 | 🔒 human-gated |
| **Documenter** | ➖ | — | ➖ | 🔒 human-gated | 🚫 |

- ✅ = allowed, and the handoff is a **typed intent** (a schema-validated object),
  not free-form content.
- 🔒 = allowed only through a **human gate + trusted re-validation** — every
  transition from a no-egress role into an egress role (…→Reporter) or into
  publication (…→broker) is treated like the publish broker: the receiving side
  acts only on validated fields, and a human approves.
- 🚫 = forbidden. In particular **Coder→Reporter direct is forbidden**: it is the
  exact exfil path (caged role → egress role). Any legitimate "the code work
  produced something worth announcing" flows Coder→dispatcher→(human gate)→
  Reporter, with the dispatcher re-deriving the announcement from ground truth,
  not passing Coder's bytes through.
- ➖ = only the dispatcher initiates it (a role cannot request it itself).

## Payload discipline

Handoffs carry **typed intents**, never raw passthrough content. This is the same
lesson as the broker (which re-renders the diff from a fetched sha rather than
trusting the coder's bytes):

- Coder→Reviewer hands a `{ repoDir, plan, diff-is-computed-by-harness }` — the
  harness computes the diff, the Coder does not supply it (a reviewer-blinding
  guard already in `steps.ts`).
- Anything→Reporter hands a typed `{ template, fields }`, and the Reporter (or
  the dispatcher on its behalf) renders the message from allow-listed templates —
  a role cannot dictate an arbitrary outbound body. This keeps a compromised
  upstream role from turning Reporter's egress into a generic exfil channel.

## Where the dispatcher runs

**On the trusted side, outside every caged boundary** — the same side as the
broker. Concretely, in the container topology it is a process alongside the
driver/broker (its own container or the host-side controller), reachable by roles
only through a typed socket (as the coder reaches the broker), never by a role
holding the dispatcher's privileges. It holds:

- the `.worker-targets` map (authoritative name→surface binding),
- the transition matrix,
- the human gates for 🔒 transitions.

The macOS path's analogue is the orchestrator — but note the orchestrator is only
*semi-trusted* today (the C-3 `$(...)` escape). A real dispatcher should be a
genuinely trusted plane (no `excludedCommands` passthrough), which the container
topology gives for free (the Linux netns boundary leaves `$(...)` nowhere to
escape to).

## Fail-closed invariants

1. **Roles name roles, never surfaces.** Target resolution is dispatcher-only,
   against a denyWrite map; caller-supplied overrides are refused.
2. **The transition matrix is trusted-side and fixed.** A role cannot widen its
   own allowed handoffs.
3. **Every no-egress → egress transition is a typed intent + human gate**, re-
   validated on the trusted side. No raw content passthrough into an egress role.
4. **Publication stays the broker's**, not a general dispatch transition — see
   agent-roles.md invariant 4.
5. **The dispatcher is not a caged role** and no caged role holds its privileges.

## Open questions / next steps

1. **Declarative flow vs coded driver.** Keep sequencing as hand-written TS (like
   `driver.ts`, maximal determinism) or express flows declaratively (a per-purpose
   flow file)? Leaning coded, for the same reason the harness rejected takt.
2. **Transport.** Reuse the broker's typed unix-socket pattern (named volume,
   crosses the boundary on Docker Desktop for macOS) for every role handoff, or a
   dispatcher-mediated message bus? A socket per trusted-side edge keeps the
   caged roles reaching only *out* to the dispatcher, never to each other.
3. **Template registry for Reporter.** Where do the allow-listed outbound
   templates live (broker-owned file, à la `broker-policy.json`)? They must be
   trusted-side, never in a coder-writable tree.
4. **Validation.** Add a test proving (a) a caged role cannot resolve/override a
   target it is not allowed to reach, and (b) a Coder→Reporter direct attempt is
   refused — before any multi-role flow is booted live. Pairs with the per-role
   egress checks in [egress-selfcheck-per-role.md](egress-selfcheck-per-role.md).
