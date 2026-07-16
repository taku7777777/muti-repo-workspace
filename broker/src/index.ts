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
 *
 * Thread B (browser approval, docs/mrw-cli.md): set BROKER_APPROVAL_SOCKET
 * to also listen on a second, token-less unix socket that `mrw serve`
 * relays browser approve/decline decisions through. Unset (the default) is
 * BYTE-IDENTICAL to pre-Thread-B behavior — approval-server.ts is never
 * imported-and-constructed, only handler.ts's existing TTY gate runs.
 */
import {
  APPROVAL_TIMEOUT_MS,
  GITHUB_TOKEN,
  POLICY_FILE,
  SOCKET_PATH,
  WORKTREES_ROOT,
  loadPolicy,
} from "./config.js";
import { startApprovalServer } from "./approval-server.js";
import { handleRequest, hub } from "./handler.js";
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

  // Thread B: start the approval-socket listener ONLY when the operator
  // opted in. Unset is the default and must stay byte-identical to
  // pre-Thread-B behavior, so there is no server object constructed here at
  // all in that case — nothing that could fail or behave differently. When
  // set, a listen failure is fail-VISIBLE (log + exit(1)): the operator
  // explicitly asked for the browser channel, so silently degrading to
  // TTY-only would hide a broken deployment rather than surface it.
  let approvalServer: ReturnType<typeof startApprovalServer> | undefined;
  const approvalSocket = process.env.BROKER_APPROVAL_SOCKET;
  if (approvalSocket && approvalSocket.trim().length > 0) {
    approvalServer = startApprovalServer(approvalSocket, hub);
    approvalServer.on("listening", () =>
      console.log(`[broker] approval socket listening on ${approvalSocket}`),
    );
    approvalServer.on("error", (err) => {
      console.error(`[broker] approval socket error: ${err.message}`);
      process.exit(1);
    });
  }

  const server = startServer(SOCKET_PATH, handleRequest, APPROVAL_TIMEOUT_MS);
  server.on("listening", () => console.log(`[broker] listening on ${SOCKET_PATH}`));
  server.on("error", (err) => {
    console.error(`[broker] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[broker] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
    if (approvalServer) approvalServer.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
