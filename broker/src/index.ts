/**
 * index.ts — broker entrypoint. Runs on the TRUSTED side. Deployment DEFAULT is its
 * OWN container on the `egress` network (github access), sharing the unix socket
 * with the coder via a Docker NAMED VOLUME; the host-process alternative is
 * documented in docs/devcontainer-phase2.md.
 *
 * It holds the short-lived, repo-scoped GitHub token in its OWN env (never the
 * coder's) and reaches the git host directly. The caged coder reaches it ONLY
 * through the shared unix socket, sending a typed PublishRequest.
 *
 * Start:  BROKER_GITHUB_TOKEN=ghs_xxx BROKER_POLICY_FILE=/etc/mrw-broker/policy.json \
 *         npm --prefix broker start
 */
import {
  APPROVAL_TIMEOUT_MS,
  GITHUB_TOKEN,
  POLICY_FILE,
  SOCKET_PATH,
  WORKTREES_ROOT,
  loadPolicy,
} from "./config.js";
import { handleRequest } from "./handler.js";
import { startServer } from "./server.js";

function main(): void {
  // Fail-CLOSED at startup: if the TRUSTED policy cannot be loaded (missing, invalid,
  // or resolving inside a coder-writable tree), do not open the socket at all.
  try {
    const cfg = loadPolicy();
    console.log(
      `[broker] policy OK (${POLICY_FILE}) — hosts=[${cfg.allowed_push_hosts.join(", ")}] ` +
        `orgs=[${cfg.allowed_push_orgs.join(", ") || "(none: host-only)"}] ` +
        `branch_prefix='${cfg.branch_prefix}'`,
    );
  } catch (e) {
    console.error(`[broker] refusing to start (fail-closed): ${(e as Error).message}`);
    process.exit(1);
  }

  if (!GITHUB_TOKEN) {
    console.warn(
      "[broker] no BROKER_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN in env — push/PR will " +
        "rely on ambient credentials. Prefer a short-lived, repo-scoped token.",
    );
  }

  console.log(`[broker] worktrees root (coder-writable, untrusted): ${WORKTREES_ROOT}`);
  console.log(
    `[broker] approval budget: ${APPROVAL_TIMEOUT_MS > 0 ? `${APPROVAL_TIMEOUT_MS} ms` : "unlimited"}`,
  );

  const server = startServer(SOCKET_PATH, handleRequest, APPROVAL_TIMEOUT_MS);
  server.on("listening", () => console.log(`[broker] listening on ${SOCKET_PATH}`));
  server.on("error", (err) => {
    console.error(`[broker] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[broker] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
