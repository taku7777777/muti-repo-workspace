/**
 * index.ts — serve entrypoint. Runs as its OWN process/container (the
 * implementation contract's top-level constraint: "mrw serve is a separate,
 * token-less process. It never holds BROKER_GITHUB_TOKEN and cannot push.
 * It renders and relays only."). Everything this process needs comes from
 * its own env (§3.1) plus an optional read-only config dir (§3.5) — it never
 * touches a worktree, never sees a GitHub token, and its only outbound
 * connection is the approval socket (broker-client.ts).
 *
 * Start:  SERVE_APPROVAL_SOCKET=/run/approve/approve.sock \
 *         SERVE_SESSION_TOKEN=$(openssl rand -hex 32) \
 *         npm --prefix serve start
 */
import { BrokerClient } from "./broker-client.js";
import { loadEnv, loadServeConfig, type ServeEnv } from "./config.js";
import { createServer } from "./server.js";

/** Fail-CLOSED at startup (§3.1): a missing/short session token or an unset
 *  approval socket path means serve must never open its listener at all —
 *  "never start unauthenticated" is a startup-time guarantee, not something
 *  checked per-request. */
function loadEnvOrExit(): ServeEnv {
  try {
    return loadEnv();
  } catch (e) {
    console.error(`[serve] refusing to start (fail-closed): ${(e as Error).message}`);
    process.exit(1);
  }
}

function main(): void {
  const env = loadEnvOrExit();

  // serve.json is the OPPOSITE posture (§3.5: never fatal) — see config.ts's
  // header comment for why these two loaders in the same file behave so
  // differently.
  const config = loadServeConfig(env.configDir);

  const broker = new BrokerClient(env.approvalSocket);
  const server = createServer({ sessionToken: env.sessionToken, broker, config, configDir: env.configDir });

  server.listen(env.port, env.bind, () => {
    console.log(`[serve] listening on http://${env.bind}:${env.port}`);
    console.log(`[serve] broker approval socket: ${env.approvalSocket}`);
    console.log(`[serve] config dir: ${env.configDir ?? "(none — built-in defaults)"}`);
  });
  server.on("error", (err) => {
    console.error(`[serve] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[serve] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
