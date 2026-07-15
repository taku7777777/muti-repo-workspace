/**
 * telemetry.ts — per-ticket OTEL resource attributes, SELF-DERIVED only.
 *
 * The containerized coder path (worker/orchestrator/reviewer) sends no
 * telemetry today: the split-container SDK sessions don't read user
 * settings (settingSources excludes 'user' by design — see sdk.ts's
 * baseOptions()) and the cage network is `internal: true` with no route to
 * the host collector. The fix opens ONE deliberate internal network
 * (`mrw-telemetry`, docker-compose.yml) reaching ONLY the collector — see
 * docs/devcontainer-status.md item 10.
 *
 * Propagation is NOT "forward whatever string arrived over the wire" — that
 * would let an untrusted value (a coder-controlled prompt, an orchestrator
 * RPC field) inject arbitrary OTEL resource attributes. Instead every
 * session builds its OWN `OTEL_RESOURCE_ATTRIBUTES` from a ticket value it
 * already trusts by construction: `req.ticket` is zod-validated by the
 * worker RPC schema (workerd/protocol.ts's BARE_NAME), and `repoDir` is a
 * path this process itself resolved (steps.ts's plan/review, run under the
 * orchestrator's own worktree layout). ticketFromRepoDir() re-derives the
 * ticket the SAME way exec.ts's deriveTicketRepo() does (mirrored regex,
 * not imported — see the note below on why this file stays import-free).
 *
 * This module is deliberately dependency-free (node builtins only, no
 * imports from exec.ts, config.ts, etc.) so it can be imported from
 * steps.ts without risking an import cycle (exec.ts already imports
 * steps.ts) and reused verbatim-in-spirit (not verbatim-in-code — each
 * package is its own build target) by broker/ and reviewer/, which cannot
 * import harness/ at all (separate npm packages, separate container images).
 */
import * as path from "node:path";

// Same bare-name shape as workerd/protocol.ts's BARE_NAME and
// broker/src/reviewer.ts's ticket field: letters, digits, dot, underscore,
// hyphen, 1-100 chars. Anything outside this set (notably comma/equals/
// space, which would break OTEL_RESOURCE_ATTRIBUTES's `k=v,k=v` syntax) is
// rejected, never sanitized-by-stripping — a rejected value degrades to
// "unlabeled", it never gets silently mangled into a different-looking
// value that could collide with another ticket's.
const SAFE_ATTR_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

function sanitizeAttrValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return SAFE_ATTR_VALUE.test(value) ? value : null;
}

/**
 * Derive a ticket id from a worktree path, requiring it sit EXACTLY at
 * tasks/<ticket>/repositories/<repo>[/...] — mirrors exec.ts's
 * deriveTicketRepo() layout check, but returns `null` on mismatch instead
 * of throwing (telemetry must never be the reason a step fails) and allows
 * an optional deeper path (steps.ts's plan/review run with `cwd: repoDir`
 * itself, but callers may pass a subdirectory in principle).
 *
 * Deliberately does NOT use path.relative() against a resolved workspace
 * root (that's exec.ts's job, and importing multi/config.ts here would
 * pull in its whole dependency chain) — instead splits the resolved path
 * segments directly and matches the LAST occurrence of
 * .../tasks/<ticket>/repositories/<repo>, so it works regardless of what
 * sits above `tasks/` in the absolute path.
 */
export function ticketFromRepoDir(repoDir: string): string | null {
  if (!repoDir) return null;
  const resolved = path.resolve(repoDir);
  const segments = resolved.split(path.sep).filter((s) => s.length > 0);

  // Find the LAST "tasks" segment followed by <ticket>/repositories/<repo>
  // so a workspace root that itself contains a literal "tasks" component
  // earlier in the path can't be mistaken for the boundary.
  for (let i = segments.length - 1; i >= 0; i--) {
    if (segments[i] !== "tasks") continue;
    const ticket = segments[i + 1];
    const reposLiteral = segments[i + 2];
    const repo = segments[i + 3];
    if (ticket === undefined || reposLiteral !== "repositories" || repo === undefined) continue;
    if (ticket === "." || ticket === ".." || ticket.includes("..")) continue;
    if (!SAFE_ATTR_VALUE.test(ticket)) continue;
    return ticket;
  }
  return null;
}

/**
 * Build the env for an SDK session's `env` option: the FULL inherited
 * process env (so auth/proxy/etc. still flow — same base every caller
 * already used) plus a self-composed OTEL_RESOURCE_ATTRIBUTES. `ticket` is
 * the caller's own validated/derived value (never a raw wire string);
 * `role` is a code-supplied literal ("worker" | "plan" | "review" |
 * "spine" | "reviewer" | ...), never user input.
 *
 * `work_type` defaults to "feature" and is overridable via the operator's
 * OWN env (MRW_WORK_TYPE) — NOT from anything ticket/request-scoped — so a
 * coder cannot pick its own work_type value; sanitized with the same
 * SAFE_ATTR_VALUE regex, falling back to "feature" on an invalid override
 * rather than propagating a value that could break the attribute string.
 */
export function telemetryEnv(ticket: string | null, role: string): NodeJS.ProcessEnv {
  const workspace = sanitizeAttrValue(ticket) ?? "unlabeled";
  const workType = sanitizeAttrValue(process.env.MRW_WORK_TYPE) ?? "feature";
  return {
    ...process.env,
    OTEL_RESOURCE_ATTRIBUTES: `workspace=${workspace},work_type=${workType},role=${role}`,
  };
}
