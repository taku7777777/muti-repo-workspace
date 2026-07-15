# Per-role egress self-check (design memo)

**Status: DESIGN, not built.** Companion to [agent-roles.md](agent-roles.md).
Today `scripts/egress-selfcheck.sh` proves *one* boundary — the caged coder
(nothing reachable but the allowlist; no proxy-bypass route; no DNS; no docker
socket; no push credential). Once roles gain distinct egress
(Researcher = read, Reporter = write), each role needs its *own* proof that the
proxy admits exactly its allowlist and denies everything else. This memo designs
that generalization — and states honestly what a domain-only allowlist can and
cannot enforce.

## What the current script does (the baseline to generalize)

`egress-selfcheck.sh`, run FROM the coder, asserts six things:

1. a non-allowlisted host (`example.com`) is **blocked** by the proxy;
2. an allowlisted host (`api.anthropic.com`) is **reachable**;
3. **topology fail-closed**: bypassing the proxy (`--noproxy`) has no route out;
4. no direct external **DNS** from the role (proxy resolves names);
5. no **Docker socket** (a control socket would allow a sibling-container escape);
6. no **git-push credential** in the env or `credential.helper`.

Checks 3–6 are role-independent invariants (they hold for *every* boundary).
Checks 1–2 are the part that must become **per-role and data-driven**: the
"allowed" and "blocked" sets differ by role.

## The generalization

### A per-role allowlist manifest

Each role owns a manifest listing the hosts it may reach. Empty = no egress.

```
docker/egress/roles/coder.allow        # (empty)
docker/egress/roles/documenter.allow   # (empty, or api.anthropic.com)
docker/egress/roles/reviewer.allow     # (empty)
docker/egress/roles/researcher.allow   # slack.com, api.notion.com, api.datadoghq.com, <cloud-logging>
docker/egress/roles/reporter.allow     # slack.com, api.notion.com
```

The **same** manifest is the single source of truth for two consumers:
- the egress-proxy's ACL for that role's source network (what it actually
  enforces), and
- the self-check's "expected reachable" set (what we assert).

Deriving both from one file is the point: a drift between "what the proxy allows"
and "what we test" is impossible if they read the same manifest.

### The parameterized check

`egress-selfcheck.sh --role <name>` (run from that role's container):

- **Reachability (usable):** for every host in `<role>.allow`, expect reachable
  (curl exit 0 through the proxy). A tight-but-broken allowlist fails here.
- **Closure (denied):** for a fixed **canary set** — `example.com` plus the
  *exclusive* endpoints of every OTHER role — expect blocked. This is the
  cross-role bleed test: from Reporter, `api.datadoghq.com` (Researcher-only)
  must be blocked; from Researcher, a code host (`github.com`) must be blocked.
- **Empty-allowlist roles (Coder / Documenter / Reviewer):** assert **everything**
  in the canary set is blocked, i.e. the role is fully caged. Reuse checks 3–6
  verbatim (topology, DNS, docker, credential).
- **Egress roles (Researcher / Reporter):** check 3 (topology) **changes** — these
  roles *do* have a route out via the proxy, so "no proxy-bypass route" still
  holds (they reach the internet only *through* the proxy, never around it), but
  "nothing reachable" does not. Checks 4–6 still hold: no direct DNS (the proxy
  resolves), no docker socket, and — crucially — **no git-push credential**
  (push is the broker's alone; an egress role must never carry one).

### The honest limitation: domain allowlist cannot split read vs write on one host

agent-roles.md separates Researcher (read) from Reporter (write). A plain domain
allowlist over the cleartext CONNECT host **cannot** enforce that split when both
use the *same* host — exactly the limitation the current script already notes for
git ("domain allowlisting cannot distinguish git fetch from git push; same
host:port"). Consequences the self-check must not paper over:

- If Researcher-read and Reporter-write hit the **same host** (e.g. both
  `api.notion.com`), a domain allowlist that admits the host admits *both* verbs.
  The read/write split is then **advisory, not enforced** — a prompt-injected
  Researcher could issue a write to that host.
- Two ways to make the split real, both to be validated live:
  1. **Different hosts where the product allows it** (e.g. a read-only API
     subdomain vs a write endpoint) — then domain allowlisting suffices and the
     canary test above actually proves the split.
  2. **Phase 4 TLS-terminating proxy** (host+**path**+method allowlisting), which
     is where "Reporter may POST `chat.postMessage` but Researcher may not" becomes
     enforceable. Until then, the self-check should **explicitly report** any host
     that appears in both a read role's and a write role's manifest as
     "split-not-enforced (domain-only)" rather than silently passing.

This keeps the check honest: it proves what topology enforces and *flags* what it
cannot, instead of implying a guarantee the layer does not provide.

## Proposed shape

```
scripts/egress-selfcheck.sh --role <name>
  load docker/egress/roles/<name>.allow
  ROLE_INVARIANTS:            # 3–6, adjusted for egress-capable roles
    - no proxy-bypass route (always)
    - no direct external DNS (always)
    - no docker socket (always)
    - no git-push credential (always, except the broker which is not a role here)
  REACHABILITY:               # every allow entry reachable via proxy
  CLOSURE:                    # example.com + other-roles' exclusive hosts blocked
  SPLIT_AUDIT:                # any host shared by a read-role and write-role manifest
                              #   -> report "split-not-enforced (domain-only)"
  exit non-zero on any REACHABILITY/CLOSURE/INVARIANT violation
```

The macOS/host equivalent (for roles run without containers) checks the same
manifest against the sandbox `network.allowedDomains`, but note that path is
fail-open at the app layer — the container per-role proxy is the fail-closed
form and the one these assertions are meant to protect.

## Open questions / next steps

1. **One proxy with per-source ACLs, or a proxy per role?** Squid can ACL by
   source network, so one `egress-proxy` with a `role.allow`-derived ACL per
   caged network is likely enough; a proxy-per-role is simpler to reason about
   but heavier. Decide when the second egress role lands.
2. **Where the manifests live and who writes them.** Trusted-side, image-baked
   (like `broker-policy.json`), never in a coder-writable tree — a role must not
   edit its own allowlist.
3. **Wire into CI + postCreate.** Run each role's self-check after
   `docker compose up` (as Phase 0 already runs the coder check in
   `postCreate.sh`), so a boundary regression fails the boot, not a later push.
4. **Live validation first.** None of this is booted yet; the very first task is
   still Phase 0–3 live boot ([devcontainer-status.md](devcontainer-status.md)).
   Per-role checks are meaningful only once a second boundary actually exists.
