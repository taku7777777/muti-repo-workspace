#!/usr/bin/env bash
# Phase 0 egress self-check — run FROM the coder service.
#
# Proves the boundary is both CLOSED (a non-allowlisted host is blocked) and
# USABLE (an allowlisted host is reachable), and that containment is TOPOLOGICAL
# (bypassing the proxy has no route out). Exits non-zero on ANY violation so the
# dev container / harness surface a broken boundary immediately.
#
# Reasoning about curl exit codes through an explicit proxy:
#   - Allowed  CONNECT: tunnel + TLS succeed -> curl exit 0 (any HTTP status,
#     e.g. 401 from api.anthropic.com without a key, still counts as reachable).
#   - Denied   CONNECT: Squid answers 403 to the CONNECT -> curl exits non-zero.
#   - No route (proxy bypassed on an internal net): connect times out -> non-zero.
set -uo pipefail

FAIL=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=1; }

BLOCKED_HOST="https://example.com"        # NOT on the allowlist
ALLOWED_HOST="https://api.anthropic.com"  # on the allowlist (the SDK endpoint)

# 1. Non-allowlisted host MUST be blocked by the proxy.
if curl -sS -o /dev/null --connect-timeout 5 --max-time 10 "$BLOCKED_HOST" 2>/dev/null; then
  bad "$BLOCKED_HOST was reachable through the proxy (ALLOWLIST BREACH)"
else
  pass "$BLOCKED_HOST blocked by the egress allowlist"
fi

# 2. Allowlisted host MUST be reachable through the proxy.
if curl -sS -o /dev/null --connect-timeout 5 --max-time 15 "$ALLOWED_HOST" 2>/dev/null; then
  pass "$ALLOWED_HOST reachable via the proxy"
else
  bad "$ALLOWED_HOST NOT reachable via the proxy (allowlist too tight or proxy down)"
fi

# 3. Topology fail-closed: bypassing the proxy MUST have no route to the internet.
#    If this succeeds, the coder is not confined to the internal network.
if curl -sS --noproxy '*' -o /dev/null --connect-timeout 5 --max-time 10 "$ALLOWED_HOST" 2>/dev/null; then
  bad "direct (no-proxy) egress SUCCEEDED — coder is NOT confined to the internal network"
else
  pass "direct (no-proxy) egress has no route (internal-network confinement holds)"
fi

# 4. DNS-exfil guard: the coder should have no direct external name resolution
#    (the proxy resolves names). A warning, not a hard failure — the proxy still
#    gates every connection regardless.
if getent hosts example.com >/dev/null 2>&1; then
  printf 'WARN: external DNS resolvable from the coder (expected none on an internal net); proxy still gates egress\n'
else
  pass "no direct external DNS from the coder (DNS-tunnel vector closed)"
fi

# 5. No Docker control socket. A coder that can reach the Docker API could spawn
#    an unconfined sibling container and escape the cage entirely — assert it is
#    absent (we never mount it).
if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then
  bad "a Docker socket is present in the coder — container-escape risk"
else
  pass "no Docker socket in the coder"
fi

# 6. "The coder cannot push" is a TESTED invariant, not an assumption. Domain
#    allowlisting cannot distinguish git fetch from git push (same host:port),
#    so — for as long as any GitHub host is ever allowlisted — push-containment
#    rests entirely on there being NO usable git credential in the coder.
cred_found=0
for v in GITHUB_TOKEN GH_TOKEN GH_ENTERPRISE_TOKEN GITHUB_PAT GIT_ASKPASS; do
  if [ -n "${!v:-}" ]; then
    bad "a git-push credential env var ($v) is present — push would be possible"
    cred_found=1
  fi
done
helper="$(git config --get credential.helper 2>/dev/null || true)"
if [ -n "$helper" ]; then
  bad "git credential.helper is configured ($helper) — a stored push credential may exist"
  cred_found=1
fi
[ "$cred_found" -eq 0 ] && pass "no git-push credential in the coder (push-containment holds)"

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "egress-selfcheck: OK"
else
  echo "egress-selfcheck: FAILED — the Phase 0 boundary is not intact"
fi
exit "$FAIL"
