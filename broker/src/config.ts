/**
 * config.ts — TRUSTED-side configuration for the broker.
 *
 * The redesign's core principle: the entire coder-writable worktree tree (the
 * bind-mounted repo, including its .git, .gitattributes, config/, .githooks/) is
 * UNTRUSTED INPUT. Therefore the broker NEVER reads its allowlist policy from a
 * coder-writable path. Policy comes ONLY from BROKER_POLICY_FILE, a broker-owned
 * file the coder cannot write, loaded FAIL-CLOSED (F2).
 *
 * The GitHub token lives ONLY here (the broker's own env) and is NEVER sent to the
 * coder; it is attached exclusively to the fetch/push/PR commands in git.ts.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const thisDir = path.dirname(fileURLToPath(import.meta.url));

/** Absolute workspace root — used ONLY for startup messaging and as the default
 *  coder-writable tree to exclude the policy file from. Override with
 *  BROKER_WORKSPACE_ROOT. NOT used to locate policy. */
export const WORKSPACE_ROOT = path.resolve(
  process.env.BROKER_WORKSPACE_ROOT ?? path.resolve(thisDir, "..", ".."),
);

/** Base directory that holds bare-named repo worktrees: <WORKTREES_ROOT>/<repo>.
 *  Defaults to repositories/ but for per-ticket work point it at
 *  tasks/<TICKET>/repositories via BROKER_WORKTREES_DIR. This tree is
 *  CODER-WRITABLE and treated as untrusted. */
export const WORKTREES_ROOT = path.resolve(
  process.env.BROKER_WORKTREES_DIR ?? path.join(WORKSPACE_ROOT, "repositories"),
);

// Same bare-name shape harness/src/telemetry.ts and workerd/protocol.ts's
// BARE_NAME use: letters, digits, dot, underscore, hyphen, 1-100 chars —
// safe to embed in an OTEL_RESOURCE_ATTRIBUTES `k=v,k=v` string.
const SAFE_TICKET = /^[A-Za-z0-9._-]{1,100}$/;

/**
 * Derive the ticket this broker instance is serving from ITS OWN env
 * (WORKTREES_ROOT, set by the operator/compose file — never from anything
 * a publish request carries), when WORKTREES_ROOT sits exactly at
 * .../tasks/<ticket>/repositories. Returns null for a generic
 * `repositories/` root (single-repo / non-per-ticket deployment) or any
 * shape that doesn't match, so a malformed/unexpected value degrades to
 * "no ticket attribution" rather than a wrong one.
 *
 * Pure and self-contained (no fs/network) — mirrors harness/src/exec.ts's
 * deriveTicketRepo() layout check and harness/src/telemetry.ts's
 * ticketFromRepoDir(), reimplemented here because the broker cannot import
 * harness/ (separate package, separate image).
 */
export function ticketFromWorktreesRoot(): string | null {
  const segments = WORKTREES_ROOT.split(path.sep).filter((s) => s.length > 0);
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "tasks") continue;
    const ticket = segments[i + 1];
    const reposLiteral = segments[i + 2];
    if (ticket === undefined || reposLiteral !== "repositories") continue;
    if (segments.length !== i + 3) continue; // must END at .../repositories
    if (!SAFE_TICKET.test(ticket)) continue;
    return ticket;
  }
  return null;
}

/** The coder-writable tree(s) a trusted policy file must NEVER live inside. In the
 *  container deployment set BROKER_CODER_TREE to the mounted workspace path
 *  (e.g. /workspaces/muti-repo-workspace); on a host process it self-locates. */
export const CODER_TREE = path.resolve(process.env.BROKER_CODER_TREE ?? WORKSPACE_ROOT);

/** Where the broker listens. In the container default this is inside a Docker
 *  NAMED VOLUME shared with the coder (BROKER_SOCKET_PATH=/run/broker/publish.sock).
 *  The coder sees the same volume-mounted path via BROKER_SOCKET. */
export const SOCKET_PATH = path.resolve(
  process.env.BROKER_SOCKET_PATH ??
    path.join(WORKSPACE_ROOT, ".devcontainer", "run-broker", "publish.sock"),
);

/** Short-lived, repo-scoped GitHub token. From the broker's OWN env, never the
 *  coder's. Attached ONLY to fetch/push/PR (never to read-side commands). */
export const GITHUB_TOKEN =
  process.env.BROKER_GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;

/** Optional separate budget (ms) for the human approval gate. 0 / unset disables
 *  it (the gate then blocks indefinitely). This does NOT bound the pre-request
 *  socket read (that has its own short timeout in server.ts). */
export const APPROVAL_TIMEOUT_MS = (() => {
  const raw = process.env.BROKER_APPROVAL_TIMEOUT_MS;
  if (!raw) return 30 * 60 * 1000; // 30 min default
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 30 * 60 * 1000;
})();

/** TRUSTED policy path. Fail-closed if unset. */
export const POLICY_FILE = process.env.BROKER_POLICY_FILE
  ? path.resolve(process.env.BROKER_POLICY_FILE)
  : null;

// The subset of policy the broker enforces IN-PROCESS. allowed_push_hosts defaults
// to github.com. branch_prefix gates the branch a request may publish.
const PolicySchema = z
  .object({
    allowed_push_orgs: z.array(z.string()).default([]),
    allowed_push_hosts: z.array(z.string().min(1)).default(["github.com"]),
    branch_prefix: z.string().min(1),
  })
  .passthrough();

export type Policy = z.infer<typeof PolicySchema>;

/** Best-effort realpath so a symlinked tree (e.g. macOS /var -> /private/var) or a
 *  symlinked policy path cannot slip a coder-writable file past the containment
 *  check. Falls back to the resolved path when the target does not yet exist. */
function realOrResolved(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function isInside(child: string, parent: string): boolean {
  const c = realOrResolved(child);
  const pr = realOrResolved(parent);
  const withSep = pr.endsWith(path.sep) ? pr : pr + path.sep;
  return c === pr || c.startsWith(withSep);
}

/**
 * Load + validate the TRUSTED policy. FAIL-CLOSED (F2): throws when the file is
 * unset, unreadable, invalid JSON, shape-mismatched, OR resolves INSIDE a
 * coder-writable tree (worktrees root or the coder mount). Callers must treat a
 * throw as "refuse to publish".
 */
export function loadPolicy(): Policy {
  if (!POLICY_FILE) {
    throw new Error(
      "BROKER_POLICY_FILE is not set (fail-closed) — the broker refuses to derive " +
        "policy from any coder-writable path. Point it at a broker-owned file.",
    );
  }

  // Reject a policy path that lives inside the coder-writable tree BEFORE reading
  // it: such a file could be rewritten by the coder. isInside() realpaths BOTH
  // sides so neither a symlinked policy path nor a symlinked tree (macOS
  // /var -> /private/var) can smuggle it past this check.
  for (const tree of [WORKTREES_ROOT, CODER_TREE]) {
    if (isInside(POLICY_FILE, tree)) {
      throw new Error(
        `BROKER_POLICY_FILE (${POLICY_FILE}) resolves inside the coder-writable tree ${tree} ` +
          "(fail-closed) — policy must be broker-owned.",
      );
    }
  }

  let raw: string;
  try {
    raw = fs.readFileSync(POLICY_FILE, "utf8");
  } catch (e) {
    throw new Error(`cannot read policy ${POLICY_FILE} (fail-closed): ${(e as Error).message}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`cannot parse policy ${POLICY_FILE} as JSON (fail-closed): ${(e as Error).message}`);
  }
  const parsed = PolicySchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`policy ${POLICY_FILE} is invalid (fail-closed): ${parsed.error.message}`);
  }
  if (parsed.data.allowed_push_hosts.length === 0) {
    throw new Error(`policy ${POLICY_FILE} has empty allowed_push_hosts (fail-closed)`);
  }
  return parsed.data;
}
