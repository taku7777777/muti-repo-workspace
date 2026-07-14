# Phase 2 — the publish broker (the only thing that can push)

Phase 0 caged the coder (network boundary, no push credential, no GitHub egress).
Phase 1 gave it a deterministic plan→implement→review⇄fix→test→approve pipeline
that ends at a **publish stub**. Phase 2 replaces that stub with a **publish
broker**: a small TypeScript service that is the **only** component that can push.

The coder does **not** gain a token, a push capability, or GitHub egress. It gains
one thing: a **unix socket** over which it sends a **typed intent**
`{ repo, branch, title, body }`. Everything that matters — the diff the human
sees, the push target, the approval, the push — is computed on the trusted side
from git objects **by sha**, never from anything the coder says or from any
coder-writable config, ref, remote, or policy file.

## Core principle (the v2 redesign)

The broker treats the **entire coder-writable worktree tree** — the bind-mounted
repo including its `.git`, `.gitattributes`, `config/`, `.githooks/` — as
**untrusted input**. It never executes coder-controlled git config, never reads
policy from a coder-writable path, never derives ground truth from coder-writable
refs, and never pushes to a coder-controlled remote.

```
   caged coder container                        broker container (own, on `egress`)
 ┌──────────────────────────┐  shared         ┌────────────────────────────────────────┐
 │ harness/orchestrator      │  named-vol      │ broker  (holds the GH token)            │
 │  └ publish.ts ───────────── unix socket ───►│  1. typed request only                 │
 │    { repo,branch,         │  broker-sock    │  2. TRUSTED policy (baked file)         │
 │      title,body }         │  publish.sock   │  3. SCAN coder .git config → fail-closed│
 │  NO token                 │                 │  4. read HEAD/branch/clean (isolated)   │
 │  NO github egress         │                 │  5. parse origin → validate → build URL │
 │  NO push capability       │                 │  6. FETCH branch → GROUND-TRUTH diff    │
 │  caged (internal) network │                 │     (broker-private scratch repo)       │
 └──────────────────────────┘                 │  7. HUMAN approves (target+sha shown)   │
      cap_drop ALL                             │  8. re-validate → push sha → gh pr create│
      internal network only                    └────────────────────────────────────────┘
                                                    egress network; token in ITS env only
```

## The six hard requirements (and where each lives)

**F1 — git-config-injection RCE + token isolation.** Every read-side git command
runs with `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`,
`-c core.fsmonitor=false`, prompts/pager neutralized, and **no token in env**;
diffs add `--no-ext-diff --no-textconv`. All commands are argv arrays (no shell).
Because global/system nulling does **not** neutralize the coder's **local**
`.git/config`, the broker first **scans** local config and **fails closed**
(`untrusted_config`) on any exec-/redirect-capable key (`core.fsmonitor`, `filter.*`,
`url.*.insteadOf`, `http.*`, `credential.*`, `core.hooksPath`, `include.path`, …) —
so no coder config is ever executed by `status`/`log`/`diff`. See
`broker/src/git.ts` (`isolatedEnv`, `readEnv`, `scanUntrustedLocalConfig`).

**F2 — trusted policy, not coder-writable.** The allowlist
(`allowed_push_orgs` / `allowed_push_hosts` / `branch_prefix`) is loaded from
`BROKER_POLICY_FILE`, a broker-owned file. Fail-closed if it is missing, invalid,
**or resolves inside the coder-writable worktrees/workspace tree** (checked with
both paths `realpath`-resolved, so a symlink can't smuggle it in). The bind-mounted
`config/workspace.json` is **never** read at request time. Enforcement is
**in-process**; the pre-push hook and `jq` are not depended on. See
`broker/src/config.ts` and `config/broker-policy.json` (baked into the image).

**F3 — ref hygiene / no diff-blinding.** To render ground truth the broker
**first `git fetch`es** the branch from the constructed, validated URL (with the
token) into a broker-private ref inside a **scratch repo**, then computes the
unpushed set and diff base against that **freshly-fetched ref** (empty-tree
`4b825dc…` for a brand-new branch) — never against local `refs/remotes/*`. Every
git call is asserted complete (`ok && !truncated`); a git error or `maxBuffer`
overflow is a hard fail-closed (`render_incomplete`), so the human is never shown a
truncated/empty "ground truth". See `broker/src/git.ts` (`renderGroundTruth`).

**F4 — push the approved sha to a constructed, validated URL.** The origin string
is parsed for `host/org/repo`, validated against the policy, and a canonical
`https://<host>/<org>/<repo>.git` URL is **rebuilt from the validated pieces**
(defeating embedded creds, extra path segments, insteadOf-shaped inputs). The push
runs from a **broker-private scratch bare repo** whose config the broker controls,
reaching the coder's objects **by sha** via `GIT_ALTERNATE_OBJECT_DIRECTORIES` — so
the coder's local `insteadOf` / `pushInsteadOf` / `http.proxy` / `credential.helper`
can **never** redirect the push or capture the token. The exact object is pushed:
`git push <constructedURL> <approvedSha>:refs/heads/<branch>`. The approval summary
displays the resolved host/org/repo/URL **and** the sha. See `pushApprovedSha` and
`approve.ts`.

**F5 — cancellation-safe, serial human gate.** The socket read timeout bounds
**only** the pre-request read. Once a request line is dispatched (a `dispatched`
guard ensures **exactly one** per connection), that timeout is cleared and the
human gate is bounded by a **separate** budget wired to an `AbortController` that
cancels the pending approval and replies failure — and because the post-approval
path is synchronous, the broker **never pushes after replying failure**. The
handler is fully **serial**: `busy` is held until the entire handler (validation +
human gate + push) completes; a second connection while busy is answered `busy`
immediately. See `broker/src/server.ts`.

**F6 — re-validate immediately before push.** After the sha-bind and right before
the push — **synchronously, in-process** — the broker re-scans the local config,
re-resolves and re-validates the target (host/org allowlist + reconstructed URL
must equal the approved one), and confirms `HEAD` is still the approved sha. Any
mismatch or parse failure aborts without pushing. See `broker/src/handler.ts`
(step 9).

## Files

| File | Role |
|---|---|
| `broker/src/index.ts` | Entrypoint. Loads TRUSTED policy fail-closed, starts the socket server, wires the approval budget. |
| `broker/src/server.ts` | Unix-socket listener. One-line-per-connection dispatch; serial `busy`; split read-timeout vs abortable human-gate budget (F5). |
| `broker/src/handler.ts` | Decision procedure: parse → policy → scan config → read facts → validate+construct URL → fetch+ground-truth → approve → re-validate → push → PR (F6). |
| `broker/src/git.ts` | Isolated read-side git; local-config scan; origin parse + canonical URL; scratch-repo fetch/ground-truth/push via object alternates; `gh pr create`. |
| `broker/src/config.ts` | TRUSTED policy loader (fail-closed, coder-tree containment); token/paths/budget from the broker's own env. |
| `broker/src/approve.ts` | Human gate — renders ground truth + resolved target + sha; abortable prompt. |
| `broker/src/types.ts` | Wire contract + zod validation + failure codes. |
| `config/broker-policy.json` | The trusted allowlist, baked into the broker image at build. |
| `harness/src/publish.ts` | In-container client. Builds the intent, sends it, reports the result. No token, no push. |

## Configuration (broker env, trusted side only)

| Env | Default | Meaning |
|---|---|---|
| `BROKER_GITHUB_TOKEN` (or `GH_TOKEN`/`GITHUB_TOKEN`) | — | Short-lived push token. Attached ONLY to fetch/push/PR; stripped from reads. |
| `BROKER_POLICY_FILE` | *(required)* | Trusted allowlist file. Fail-closed if unset/invalid/inside the coder tree. Baked at `/etc/mrw-broker/policy.json` in the image. |
| `BROKER_WORKTREES_DIR` | `<ws>/repositories` | Base dir of bare-named worktrees `<dir>/<repo>` (coder-writable, untrusted). |
| `BROKER_CODER_TREE` | self-located `<ws>` | The coder-writable tree the policy file must not live inside (F2). Container: `/workspaces/muti-repo-workspace`. |
| `BROKER_SOCKET_PATH` | `<ws>/.devcontainer/run-broker/publish.sock` | Where the broker listens. Container: inside the shared named volume. |
| `BROKER_APPROVAL_TIMEOUT_MS` | `1800000` (30 min) | Human-gate budget. `0` = unlimited. |

The coder side needs only `BROKER_SOCKET=/run/broker/publish.sock`
(**unset ⇒ Phase-1 stub, no push**), and optionally `PUBLISH_REPO`/`PUBLISH_BRANCH`
(the broker re-derives and re-validates both).

## Deployment default — the broker as its OWN container (recommended)

Portability + trust split: the broker runs as a compose service on the `egress`
network (github access), holds the token in **its** env, and shares the socket with
the coder via a Docker **named volume** (`broker-sock`). This works on Docker
Desktop for macOS, where a host-process + host-path-bind-mounted unix socket does
**not** traverse the container boundary. The coder stays on the `caged`
(internal) network only, with **no** github egress and **no** token; its only new
surface is the shared socket.

```bash
# 1. Both credentials come from the HOST SHELL — nothing is written into the
#    worktree. The coder's Anthropic credential is read from the macOS Keychain
#    by scripts/devcontainer-up.sh (or exported manually); the broker push token
#    is exported here so compose interpolates it into the BROKER ONLY. Neither
#    ever reaches the other container: the coder holds no push token, the broker
#    holds no Anthropic credential.
export BROKER_GITHUB_TOKEN=ghs_xxx

# 2. Edit config/broker-policy.json (allowed_push_orgs/hosts, branch_prefix). It is
#    baked into the broker image at build, so the runtime coder cannot alter it.

# 3. Bring it all up (same shell, so $BROKER_GITHUB_TOKEN is in scope). The broker
#    builds from .devcontainer/broker.Dockerfile.
docker compose -f .devcontainer/docker-compose.yml up -d --build

# 4. The coder is still fully caged (no github egress, no token):
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash scripts/egress-selfcheck.sh

# 5. Attach a terminal to the broker so you can answer approval prompts:
docker compose -f .devcontainer/docker-compose.yml attach broker
#   [broker] policy OK (/etc/mrw-broker/policy.json) — hosts=[github.com] …
#   [broker] listening on /run/broker/publish.sock

# 6. Run the pipeline in the coder. At publish, the intent crosses the socket and
#    the BROKER terminal shows the ground-truth diff + resolved target + sha.
docker compose -f .devcontainer/docker-compose.yml exec coder \
  bash -lc 'cd harness && npm run orchestrate -- "add a --version flag to the CLI"'
```

On `y`, the broker fetches, re-validates, pushes the approved sha to the
constructed URL, and opens the PR; the harness prints the PR URL. On anything but
`y` (or on a mismatch at re-validation), nothing is pushed.

To override the baked policy without rebuilding, bind-mount a host file **outside
the workspace** over the path (do NOT point it into `/workspaces`, or the broker
fail-closes):

```yaml
  broker:
    volumes:
      - /etc/mrw-broker/policy.json:/etc/mrw-broker/policy.json:ro   # host path OUTSIDE the repo
```

## Host-process alternative (secondary)

Running the broker as a plain host process is simplest when the socket does cross
the boundary (Linux hosts, or a bind that works in your setup). It already has the
git host network and the token in its shell:

```bash
cd broker && npm install
BROKER_GITHUB_TOKEN=ghs_xxx \
BROKER_POLICY_FILE="$HOME/.config/mrw-broker/policy.json" \
BROKER_WORKTREES_DIR="$PWD/../tasks/TICKET-123/repositories" \
  npm start
```

Put `BROKER_POLICY_FILE` **outside** the workspace (e.g. `~/.config/mrw-broker/`),
and bind-mount the broker's socket dir into the coder. The trust boundary is
identical: the coder reaches the broker only through the typed socket, and only a
human-approved, git-verified diff pushed to a constructed URL ever leaves.

## Failure codes (broker → harness)

`invalid_request`, `config_missing`, `repo_not_allowed`, `worktree_missing`,
`untrusted_config`, `detached_head`, `branch_mismatch`, `branch_not_allowed`,
`dirty_worktree`, `remote_unparseable`, `host_not_allowed`, `org_not_allowed`,
`fetch_failed`, `render_incomplete`, `nothing_to_publish`, `declined`, `canceled`,
`sha_changed`, `push_failed`, `pr_failed`, `busy`. Every one is fail-closed: the
default outcome is **not published**. A non-ok response makes
`harness/src/publish.ts` throw, which the orchestrator turns into `exit 1`.

## What Phase 2 does and does NOT change

**Does:** a real publish path **outside** the coder, human-gated on ground truth
rendered from git objects by sha; the push target locked to a trusted, in-process
allowlist and a broker-constructed URL; the token isolated from all coder config.

**Does NOT:** give the coder a token, push capability, or GitHub egress
(`scripts/egress-selfcheck.sh` still passes); terminate TLS or inspect PR contents
beyond the human's diff review; provide a secrets store — inject the token from
your environment / secrets manager, never commit it.
