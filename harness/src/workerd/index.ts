/**
 * workerd/index.ts — worker daemon entrypoint (`npm run workerd`).
 *
 * Mirrors broker/src/index.ts's shape (fail-closed startup checks, a startup
 * banner, then the server takes over) but with the opposite credential: this
 * process runs the SDK sessions, so it needs an Anthropic credential — not a
 * GitHub token. It has NO broker socket and NO push capability (see
 * protocol.ts's header) — publishing stays exclusively the broker's job.
 */
import * as path from "node:path";
import { handleWorkerRequest, WORKERD_TEST_TIMEOUT_MS } from "./handlers.js";
import { startWorkerServer } from "./server.js";
import { resolveWorkspaceRoot } from "../multi/config.js";
import { TEST_COMMAND } from "../sdk.js";

const WORKSPACE_ROOT = resolveWorkspaceRoot();

// Host-fallback default lives under the workspace (mirrors broker/src/config.ts's
// SOCKET_PATH default of .devcontainer/run-broker/publish.sock); the container
// topology overrides this to /run/worker/workerd.sock (a named volume shared
// with the orchestrator container).
const SOCKET_PATH = path.resolve(
  process.env.WORKERD_SOCKET_PATH ??
    path.join(WORKSPACE_ROOT, ".devcontainer", "run-worker", "workerd.sock"),
);

// NaN-defensive, same pattern as sdk.ts's MAX_FIX_ATTEMPTS: a non-numeric env
// value must not produce NaN, which would make `stepBudgetMs > 0` false in
// server.ts and silently disable the per-op abort budget.
function parseMs(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : def;
}
const STEP_TIMEOUT_MS = parseMs(process.env.WORKERD_STEP_TIMEOUT_MS, 45 * 60 * 1000);

function main(): void {
  // Fail-CLOSED at startup: without a credential every run_implement/run_fix
  // would fail mid-step anyway (and hold `busy` for nothing) — refuse before
  // opening the socket at all, same posture as orchestrator.ts's cli().
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    process.exit(2);
  }

  console.log(`[workerd] socket:          ${SOCKET_PATH}`);
  console.log(`[workerd] workspace root:  ${WORKSPACE_ROOT}`);
  console.log(`[workerd] TEST_COMMAND:    ${TEST_COMMAND}`);
  console.log(`[workerd] step budget:     ${STEP_TIMEOUT_MS} ms`);
  console.log(`[workerd] test budget:     ${WORKERD_TEST_TIMEOUT_MS} ms`);

  const server = startWorkerServer(SOCKET_PATH, handleWorkerRequest, STEP_TIMEOUT_MS);
  server.on("listening", () => console.log(`[workerd] listening on ${SOCKET_PATH}`));
  server.on("error", (err) => {
    console.error(`[workerd] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[workerd] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
