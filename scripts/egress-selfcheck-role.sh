#!/usr/bin/env bash
# M1 role self-check — run FROM either the `worker` or the `orchestrator`
# service, with ROLE set to say which. Layers on TOP of the base Phase 0
# egress-selfcheck.sh (still required in both cages: both are on `caged` and
# reach the internet only via egress-proxy) with the role-specific mount and
# socket boundaries the M1 container split depends on:
#   worker        can write tasks/, cannot write repositories/ or harness/,
#                 and — the load-bearing invariant — holds NO broker socket
#                 and NO BROKER_SOCKET env, so it cannot even REQUEST a
#                 publish, let alone perform one.
#   orchestrator  the workspace mount is entirely :ro (worktrees included —
#                 ONE mount-level fact is the boundary), and it holds BOTH
#                 the broker socket and the worker RPC socket.
# Exits non-zero on ANY violation, same fail-closed contract as the base check.
set -uo pipefail

FAIL=0
pass() { printf 'PASS: %s\n' "$1"; }
bad()  { printf 'FAIL: %s\n' "$1"; FAIL=1; }

if [ "${ROLE:-}" != "worker" ] && [ "${ROLE:-}" != "orchestrator" ]; then
  echo "usage: ROLE=worker|orchestrator bash $0" >&2
  exit 2
fi

WS=/workspaces/muti-repo-workspace

# Write-probe: try to create+remove a marker file under a directory. Prints
# PASS/FAIL itself (via the caller) — this only reports success/failure of the
# touch, it does not know which outcome ("writable" vs "not writable") is
# actually desired at the call site.
probe_writable() {
  local dir="$1"
  local marker="$dir/.mrw-rw-probe"
  if ( touch "$marker" ) 2>/dev/null; then
    rm -f "$marker" 2>/dev/null
    return 0
  fi
  return 1
}

echo "[role-selfcheck] running base egress-selfcheck.sh"
if bash "$(dirname "$0")/egress-selfcheck.sh"; then
  pass "base egress-selfcheck.sh"
else
  bad "base egress-selfcheck.sh reported a boundary violation (see above)"
fi

echo ""
echo "[role-selfcheck] ROLE=$ROLE mount/socket boundary checks"

if [ "$ROLE" = "worker" ]; then
  # tasks/ IS the worker's one writable surface — implement/fix/test land here.
  if probe_writable "$WS/tasks"; then
    pass "tasks/ is writable (worker can land worktree changes)"
  else
    bad "tasks/ is NOT writable — the worker cannot do its job"
  fi

  # repositories/ must stay read-only: the clone --reference origins every
  # ticket's worktrees derive from.
  if probe_writable "$WS/repositories"; then
    bad "repositories/ is writable (origin clones are NOT worker-writable — BREACH)"
  else
    pass "repositories/ is not writable (origin clones protected)"
  fi

  # harness/ (the daemon's own source) must stay read-only: a writable harness
  # would let an injected LLM re-arm its own tool posture.
  if probe_writable "$WS/harness"; then
    bad "harness/ is writable (worker could rewrite its own daemon — BREACH)"
  else
    pass "harness/ is not writable (daemon source protected)"
  fi

  # The load-bearing invariant: the worker cannot even REQUEST a publish.
  if [ -S /run/broker/publish.sock ]; then
    bad "/run/broker/publish.sock exists in the worker (it must hold NO broker socket)"
  else
    pass "no broker socket in the worker (cannot even request a publish)"
  fi
  if [ -n "${BROKER_SOCKET:-}" ]; then
    bad "BROKER_SOCKET is set in the worker ($BROKER_SOCKET) — must be unset"
  else
    pass "BROKER_SOCKET is unset in the worker"
  fi

  # Its own RPC socket directory should exist (created node-owned at image
  # build; the worker-sock named volume mounts over it at runtime).
  if [ -d /run/worker ]; then
    pass "/run/worker exists (worker's own RPC socket dir)"
  else
    bad "/run/worker is missing — the workerd daemon has nowhere to bind"
  fi
else
  # The workspace mount is entirely :ro — ONE fact is the boundary. Prove it
  # at both the mount root and specifically under tasks/ (the worktrees a
  # prompt-injected orchestrator would most want to tamper).
  if probe_writable "$WS"; then
    bad "$WS is writable in the orchestrator (workspace :ro boundary BREACHED)"
  else
    pass "$WS is not writable (workspace :ro boundary holds)"
  fi
  if probe_writable "$WS/tasks"; then
    bad "$WS/tasks is writable in the orchestrator (worktrees must stay :ro here)"
  else
    pass "$WS/tasks is not writable (worktrees stay :ro in the orchestrator)"
  fi

  # The orchestrator holds BOTH sockets — the only publish path and the RPC
  # transport to drive the worker.
  if [ -S /run/broker/publish.sock ]; then
    pass "/run/broker/publish.sock exists (orchestrator holds the publish path)"
  else
    bad "/run/broker/publish.sock is missing — the orchestrator cannot publish"
  fi
  if [ -S /run/worker/workerd.sock ]; then
    pass "/run/worker/workerd.sock exists (orchestrator can drive the worker)"
  else
    bad "/run/worker/workerd.sock is missing — the orchestrator cannot drive the worker"
  fi

  # MRW_STATE_DIR is the spine's rw ledger — must actually be writable, or
  # the spine has nowhere to record invariant state.
  if [ -z "${MRW_STATE_DIR:-}" ]; then
    bad "MRW_STATE_DIR is unset in the orchestrator"
  elif probe_writable "$MRW_STATE_DIR"; then
    pass "\$MRW_STATE_DIR ($MRW_STATE_DIR) is writable (spine ledger has a home)"
  else
    bad "\$MRW_STATE_DIR ($MRW_STATE_DIR) is NOT writable — the spine cannot record state"
  fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "role-selfcheck ($ROLE): OK"
else
  echo "role-selfcheck ($ROLE): FAILED — a role/mount boundary is not intact"
fi
exit "$FAIL"
