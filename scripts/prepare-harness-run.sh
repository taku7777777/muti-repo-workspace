#!/usr/bin/env bash
# Populate a container-LOCAL copy of the harness and install its Linux deps.
#
# Why a copy instead of running from the bind mount: harness/ is mounted :ro in
# both cages (the worker must not be able to rewrite its own daemon; the
# orchestrator's whole workspace is :ro), and the HOST's harness/node_modules
# carries darwin-arm64 binaries owned by the host uid. A named volume layered
# over the :ro bind initializes itself FROM that host content (wrong platform,
# wrong owner → npm ci dies with EACCES; hit live on the first M1 boot).
# Copying the source (minus node_modules) to container-local disk and running
# `npm ci` there sidesteps both problems and keeps the :ro boundary intact.
#
# Callers must set MRW_WORKSPACE_ROOT=/workspaces/muti-repo-workspace in the
# environment of anything they run from the copy — the harness resolves the
# workspace root from its own module path, which now lives outside the tree.
set -euo pipefail

SRC="${HARNESS_SRC_DIR:-/workspaces/muti-repo-workspace/harness}"
RUN="${HARNESS_RUN_DIR:-/home/node/harness-run}"

mkdir -p "$RUN"
# GNU tar; --exclude keeps the host's (wrong-platform) node_modules out of the
# copy. Existing node_modules inside $RUN from a prior run is left in place —
# npm ci below replaces it wholesale anyway.
#
# tar exit code 1 means "a file changed while reading" — on colima/virtiofs
# bind mounts the directory mtime of '.' is unstable enough to trip this even
# when nothing is writing, so treat 1 as a warning and only >=2 (real errors)
# as fatal. The extract side must be exactly 0.
set +e
tar -C "$SRC" -c --exclude=./node_modules . | tar -C "$RUN" -x
# PIPESTATUS is clobbered by the NEXT command (any command, even an
# assignment) — snapshot the whole array in one statement.
rcs=("${PIPESTATUS[@]}")
set -e
if [ "${rcs[0]:-2}" -ge 2 ] || [ "${rcs[1]:-1}" -ne 0 ]; then
  echo "[prepare-harness-run] copy failed (tar create=${rcs[0]:-?} extract=${rcs[1]:-?})" >&2
  exit 1
fi

cd "$RUN"
npm ci
echo "[prepare-harness-run] ready at $RUN (source: $SRC)"
