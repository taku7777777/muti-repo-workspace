# Phase 0 dev container — a caged coder behind an egress allowlist

Phase 0 delivers a **bootable dev environment** where a Claude Agent SDK coding
harness runs with **no ability to push, exfiltrate, or reach arbitrary hosts** —
without asking the human to approve every command. Containment is a **network
boundary**, not a permission prompt.

## What's here

| File | Role |
|---|---|
| `.devcontainer/devcontainer.json` | Compose-backed dev container; attaches the editor/harness to the `coder` service. |
| `.devcontainer/docker-compose.yml` | The two services + two networks that form the boundary. |
| `.devcontainer/coder.Dockerfile` | Node 20 + git/jq/gh + Claude Code CLI, non-root `node` user. |
| `.devcontainer/postCreate.sh` | Wires tools to the proxy, installs harness deps, runs the self-check. |
| `.devcontainer/.env.example` | Template for the runtime-only `ANTHROPIC_API_KEY`. |
| `docker/egress/` | The egress gateway: Squid + baked-in allowlist + entrypoint. |
| `scripts/egress-selfcheck.sh` | Proves the boundary is closed AND usable, from the coder. |
| `harness/` | The bespoke SDK orchestrator skeleton (plan → implement → test → approve → publish-stub). |

## The boundary (why it holds)

We use **Approach A: an explicit Squid forward-proxy sidecar**, chosen over a
transparent NET_ADMIN gateway because it is strictly less privileged and gives
true domain allowlisting with no TLS interception.

```
        caged  (internal: true — NO route to the internet)
   ┌───────────────────────────────────────────────┐
   │   coder  ───HTTP(S)_PROXY──►  egress-proxy     │
   │  (cap_drop ALL,               (Squid, allowlist,│
   │   no NET_ADMIN,                cap_drop ALL)     │
   │   no docker.sock,                   │           │
   │   no host secrets)                  │           │
   └─────────────────────────────────────┼───────────┘
                                         │  egress (bridge)
                                         ▼
                                 allowlisted hosts only
                                 (api.anthropic.com, …)
```

Three independent facts make it fail-closed:

1. **Topology.** The `coder` is attached **only** to `caged`, a Docker network
   created with `internal: true` — it has no default route off the host. A tool
   that ignores `HTTP(S)_PROXY` has nowhere to send packets; it breaks, nothing
   leaks. Honoring the proxy is a *usability* property, not the security one.
2. **Allowlist.** The only route out is `egress-proxy`, which enforces a
   **domain allowlist over the cleartext CONNECT host** (`docker/egress/allowlist.txt`).
   No TLS termination, no CA in the coder. CONNECT is restricted to :443.
3. **No self-escalation.** Neither container holds `NET_ADMIN`/`NET_RAW`
   (`cap_drop: [ALL]`). The allowlist is baked into the proxy image, read-only,
   in a separate container the coder cannot exec into or reconfigure. There is no
   in-workload firewall to rewrite.

## Boot it

Prereq: Docker Desktop (macOS dev host; the containers are Linux) **with the
Compose v2 plugin** — check with `docker compose version`. If it prints
`docker: 'compose' is not a docker command`, the plugin is missing (a plain
`docker` CLI without Docker Desktop, or a minimal install): install the
`docker-compose-plugin` package or Docker Desktop, or substitute a standalone
`docker-compose` binary in the commands below. The devcontainer's
`dockerComposeFile` also requires this plugin.

```bash
# 1. Provide a runtime-only API key (never committed, never baked in).
cp .devcontainer/.env.example .devcontainer/.env
$EDITOR .devcontainer/.env          # set ANTHROPIC_API_KEY

# 2a. Open in VS Code / Cursor: "Dev Containers: Reopen in Container".
#     postCreate installs harness deps and runs the egress self-check.

# 2b. Or bring it up by hand and prove the boundary:
docker compose -f .devcontainer/docker-compose.yml up -d --build
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash scripts/egress-selfcheck.sh
```

Expected self-check result: `example.com` **blocked**, `api.anthropic.com`
**reachable**, direct (no-proxy) egress has **no route** → `egress-selfcheck: OK`.

## Run the harness

Inside the coder (dev container terminal, or `docker compose … exec coder`):

```bash
cd harness
npm run orchestrate -- "add a --version flag to the CLI"
```

The orchestrator runs **plan** and **implement** as separate `query()` sessions,
runs the repo's **test command** as a gate (branching on exit code), then stops
at an explicit **human approval gate** before a **publish stub**. Configure with
`REPO_DIR`, `TEST_COMMAND`, `HARNESS_MODEL`.

## What Phase 0 does and does NOT guarantee

**Does:**
- The coder cannot reach any host outside the allowlist (fail-closed by topology + proxy).
- The coder holds no elevated capabilities, no Docker socket, no host secret mounts.
- **The coder cannot push** — no GitHub host is allowlisted AND the coder holds no
  git-push credential. The self-check asserts both (no Docker socket, no
  `GITHUB_TOKEN`/`GH_TOKEN`/… env, no `credential.helper`), so this is *tested*,
  not assumed.
- The API key is injected at runtime only, not baked into any image.
- Egress is proven at boot by an automated self-check.
- The pipeline is deterministic coded control flow with a real test gate and a human gate.

**Does NOT (later phases):**
- **Publish.** No GitHub host is in the Phase-0 allowlist at all, so there is no
  push path (and no fetch path — the repo is bind-mounted, so none is needed).
  Note: domain allowlisting **cannot** distinguish `git fetch` from `git push`
  (same host:port), so if a later need forces adding `.github.com` for git+https
  deps, push-containment falls back to credential-absence (which the self-check
  already tests). Real publishing moves to a dedicated *publish broker* with its
  own narrow allowlist and the existing pre-push org/host validation +
  `push-create-pr.sh` hardening.
- **Multi-repo** orchestration.
- **TLS-terminating / L7 hardening** (path/method/body filtering would need
  SSL-bump + a CA, deliberately avoided in Phase 0).
- **A real secrets store.** `.env` is fine for local dev only; values are visible
  via `docker inspect`.
- **Prevent an allowlisted host from being abused** (e.g. a malicious npm
  package). Phase 0 gates *where* traffic can go, not *what* trusted hosts serve.

## Notes / conservative choices

- **Fallback (Approach B).** If a future tool cannot honor an explicit proxy, the
  documented fallback is a transparent gateway that holds `NET_ADMIN` (the coder
  still holds none) and does iptables REDIRECT + IP allowlist — accepting either
  SSL-bump (a CA in the coder, breaks pinning) or IP-only allowlisting with DNS
  pinned to `127.0.0.11`. Not built now.
- **git over SSH does not honor `HTTP(S)_PROXY`.** Use HTTPS remotes in the coder;
  SSH would fail closed (no route) unless a `ProxyCommand` is configured.
- **IPv6** is left disabled for the coder network (Docker default). An unfiltered
  v6 path would bypass a v4 allowlist.
- **SDK version is pinned** (`@anthropic-ai/claude-agent-sdk` 0.3.205); the 0.3.x
  line changes options nearly per release. Re-run the self-check and typecheck on
  any bump.
