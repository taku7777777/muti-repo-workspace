/**
 * index.ts — reviewer entrypoint (`npm start`, M3).
 *
 * Mirrors broker/src/index.ts's shape (fail-closed startup checks, a
 * startup banner, then the server takes over) — but this process runs an
 * SDK session, so it needs an Anthropic credential rather than a GitHub
 * token, and it holds NO push capability whatsoever (see
 * .devcontainer/reviewer.Dockerfile's header: no gh, no git — there is
 * nothing here to authenticate as).
 *
 * Deployment default: its OWN container (image-baked source, no workspace
 * mount — same supply-chain reasoning as broker.Dockerfile), on the shared
 * `caged` network with the worker/orchestrator (same egress allowlist; a
 * reviewer-specific allowlist is Phase 4, see
 * docs/egress-selfcheck-per-role.md's per-role manifest design). The broker
 * reaches this process ONLY through the shared REVIEWER_SOCKET_PATH unix
 * socket, and the consult is entirely OPTIONAL from the broker's side
 * (broker/src/reviewer.ts): if this process is down, unreachable, or slow,
 * the broker renders "no verdict" and publishing proceeds unaffected — this
 * process is advisory, never load-bearing.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { handleReviewRequest, REVIEWER_DIFF_DIR } from "./handler.js";
import { startReviewerServer } from "./server.js";

const SOCKET_PATH = path.resolve(process.env.REVIEWER_SOCKET_PATH ?? "/run/reviewer/review.sock");

// NaN-defensive, same pattern as harness/src/sdk.ts's MAX_FIX_ATTEMPTS /
// harness/src/workerd/index.ts's STEP_TIMEOUT_MS: a non-numeric env value
// must not silently produce NaN, which would make `sessionBudgetMs > 0`
// false in server.ts and quietly disable the per-request abort budget.
function parseMs(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : def;
}
const REVIEWER_SESSION_TIMEOUT_MS = parseMs(process.env.REVIEWER_SESSION_TIMEOUT_MS, 120 * 1000);

function main(): void {
  // Fail-CLOSED at startup, same posture as broker/src/config.ts's
  // loadPolicy(): REVIEWER_DIFF_DIR has NO default because it IS the
  // containment boundary handler.ts's isInside() check enforces — an unset
  // or missing value must refuse to open the socket at all, never silently
  // accept an unintended root for that check.
  if (!REVIEWER_DIFF_DIR) {
    console.error(
      "[reviewer] refusing to start (fail-closed): REVIEWER_DIFF_DIR is not set — " +
        "point it at the read-only mount shared with the broker's diff-file volume " +
        "(review-diffs in .devcontainer/docker-compose.yml).",
    );
    process.exit(1);
  }
  try {
    if (!fs.statSync(REVIEWER_DIFF_DIR).isDirectory()) {
      throw new Error("not a directory");
    }
  } catch (e) {
    console.error(
      `[reviewer] refusing to start (fail-closed): REVIEWER_DIFF_DIR (${REVIEWER_DIFF_DIR}) ` +
        `is not a readable directory: ${(e as Error).message}`,
    );
    process.exit(1);
  }

  // Fail-CLOSED: without a credential every review would fail mid-session
  // anyway (and hold `busy` for nothing) — refuse before opening the socket
  // at all. Same message as harness/src/workerd/index.ts's guard.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error(
      "No Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the container env (host shell → scripts/devcontainer-up.sh).",
    );
    process.exit(2);
  }

  console.log(`[reviewer] socket:          ${SOCKET_PATH}`);
  console.log(`[reviewer] diff dir (ro):   ${REVIEWER_DIFF_DIR}`);
  console.log(`[reviewer] model:           ${process.env.REVIEWER_MODEL ?? "sonnet"}`);
  console.log(`[reviewer] session budget:  ${REVIEWER_SESSION_TIMEOUT_MS} ms`);
  console.log("[reviewer] advisory only — never load-bearing for publish (see broker/src/reviewer.ts)");

  const server = startReviewerServer(SOCKET_PATH, handleReviewRequest, REVIEWER_SESSION_TIMEOUT_MS);
  server.on("listening", () => console.log(`[reviewer] listening on ${SOCKET_PATH}`));
  server.on("error", (err) => {
    console.error(`[reviewer] server error: ${err.message}`);
    process.exit(1);
  });

  const shutdown = (sig: string) => {
    console.log(`\n[reviewer] ${sig} — shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
