/**
 * spined/index.ts — the spined MCP daemon entrypoint (`npm run spined`).
 *
 * docs/mrw-chat.md "New pieces": a STANDALONE stdio MCP server wrapping the
 * EXISTING executor/ledger — same pattern as workerd/ (thin protocol
 * adapter, no new capability). Spawned by the Claude Code frontend via
 * `.mcp.json` (C3's job), receiving `--ticket/--repos/--purpose` on argv.
 *
 * Uses @modelcontextprotocol/sdk's McpServer + StdioServerTransport
 * DIRECTLY — NOT the Agent SDK's `createSdkMcpServer` (spine/session.ts's
 * choice), which only works IN-PROCESS inside an Agent SDK query() session.
 * spined has no such session: the LLM on the other end of this stdio pipe is
 * Claude Code itself (the frontend), a genuinely separate process spawned by
 * the frontend's own `.mcp.json` entry, so this file has to speak the raw
 * MCP wire protocol.
 *
 * FAST START, LOAD-ONLY (docs/mrw-chat.md: "spined starts instantly (stdio
 * MCP servers have a startup timeout) and only LOADS the ledger"): all
 * worktree setup / ledger seeding is spine-prepare's job (prepare.ts), run
 * once by the launcher BEFORE spawning this daemon. `startSpined()` below
 * does nothing but argv-parse, take the per-ticket lock, and
 * `SpineLedger.load()` — never `setupWorktree`, never a git/SDK call. A
 * missing/invalid ledger is a fail-closed startup error naming the prepare
 * command (see the catch block below).
 *
 * `ask_human`/`show_human` are NOT exposed as MCP tools (spined/tools.ts
 * only builds the other seven action tools + `status`) — the chat itself
 * (the human on the other end of Claude Code) is the human channel now. The
 * `askHuman`/`say` callbacks below exist ONLY to satisfy ExecutorDeps'
 * required fields; they must never actually be invoked — see their own
 * comments for why that is true BY CONSTRUCTION, not by convention.
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { resolveWorkspaceRoot } from "../multi/config.js";
import { stateDir } from "../multi/state.js";
import { createExecutor } from "../spine/executor.js";
import type { Executor } from "../spine/executor.js";
import { LedgerLoadError, SpineLedger } from "../spine/ledger.js";
import { parseSpinedArgs } from "./args.js";
import { sanitizeUnexpandedEnvPlaceholders } from "./env-sanitize.js";
import { acquireLock } from "./lock.js";
import type { SpinedLock } from "./lock.js";
import { guardStdoutForMcp } from "./stdio-guard.js";
import { buildActionTools, buildStatusTool } from "./tools.js";
import type { SpinedTool, SpinedToolExtra } from "./tools.js";

function parseKeepaliveMs(raw: string | undefined, def: number): number {
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n > 0 ? n : def;
}
export const KEEPALIVE_INTERVAL_MS = parseKeepaliveMs(process.env.MRW_SPINED_KEEPALIVE_MS, 10_000);

// --- unreachable-by-construction askHuman/say stubs ---------------------------
// Invariant 5 ("the spine owns the terminal") + this daemon's own design:
// ask_human/show_human are never registered as MCP tools (spined/tools.ts),
// so executor.ts's "ask_human"/"show_human" SpineAction cases can NEVER be
// reached from a call this process actually dispatches — a SpineAction is
// only ever built by translating a REGISTERED tool call's validated args
// (tools.ts's ActionToolSpec.toAction), never from free-form text. Separately,
// approvalPolicy:"broker-only" (engine adaptation A) removes every askHuman()
// call on the request_publish path too. If either callback below ever fires,
// one of those two invariants broke upstream — fail LOUD (throw) instead of
// hanging this stdio process waiting on input nobody can supply.
function unreachableAskHuman(question: string): Promise<string> {
  throw new Error(
    `spined: askHuman() invoked ("${question}") but this daemon has no human channel — this must never ` +
      "happen (ask_human is not an MCP tool here, and approvalPolicy='broker-only' removes every " +
      "publish-path ask). This indicates a bug upstream, not a normal refusal.",
  );
}
function unreachableSay(line: string): void {
  throw new Error(
    `spined: say() invoked ("${line}") but this daemon has no human channel — this must never happen ` +
      "(show_human is not an MCP tool here). This indicates a bug upstream, not a normal refusal.",
  );
}

export interface SpinedStartup {
  ticket: string;
  ledger: SpineLedger;
  executor: Executor;
  lock: SpinedLock;
  tools: SpinedTool[];
}

/**
 * Everything spined needs before it can accept MCP requests: parse argv, the
 * fail-closed credential guard, acquire the per-ticket lock, LOAD (never
 * seed) the ledger, build the executor + tool table. Factored out of main()
 * — which also connects a real stdio transport — so tests can exercise
 * startup failure modes (no ledger, lock contention) directly.
 */
export async function startSpined(argv: string[], opts?: { root?: string }): Promise<SpinedStartup> {
  sanitizeUnexpandedEnvPlaceholders(process.env, ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);

  // Same fail-closed credential guard as spine/index.ts's / workerd/index.ts's
  // cli()s: a dispatched run_worker/plan_repo/review_diff calls the Agent SDK
  // directly whenever WORKERD_SOCKET is unset (exec.ts's mode switch), so
  // refuse before opening the transport at all rather than fail mid-dispatch.
  if (!process.env.ANTHROPIC_API_KEY && !process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    throw new Error(
      "no Anthropic credential — set CLAUDE_CODE_OAUTH_TOKEN (subscription) or ANTHROPIC_API_KEY in the " +
        "container env (host shell → scripts/devcontainer-up.sh)",
    );
  }

  const args = parseSpinedArgs(argv);
  if (!args.ticket) {
    throw new Error("usage: npm run spined -- --ticket T-1 [--repos a,b] [--purpose p]");
  }

  const root = opts?.root ?? resolveWorkspaceRoot();
  const ledgerDir = stateDir(root, args.ticket);

  // Per-ticket single-instance lock BEFORE touching the ledger — a second
  // spined for this ticket must fail closed before it can observe (let alone
  // mutate) any ledger state at all. See lock.ts's header for the full
  // rationale and its documented scope limit.
  const lock = acquireLock(ledgerDir);

  let ledger: SpineLedger;
  try {
    // Engine adaptation C: LOAD only — never seed here. See this file's
    // header on why worktree setup/seeding belongs entirely to prepare.ts.
    ledger = SpineLedger.load(args.ticket, ledgerDir);
  } catch (e) {
    lock.release();
    // FIX (independent review, SHOULD-FIX #2c): only "missing" (no ledger
    // file at all — LedgerLoadError.code, see ledger.ts) is safe to answer
    // with "run spine-prepare" — every OTHER load failure means a ledger
    // FILE EXISTS but could not be trusted (corrupt JSON, a shape/version
    // mismatch, a wrong ticket), and spine-prepare would OVERWRITE it
    // (prepare.ts independently refuses that without --force, but the
    // ADVICE text here must not even suggest a state-wiping command for a
    // problem that needs manual inspection instead).
    const code = e instanceof LedgerLoadError ? e.code : null;
    if (code === "missing") {
      const prepareArgs = [
        `--ticket ${args.ticket}`,
        args.repos.length ? `--repos ${args.repos.join(",")}` : null,
        args.purpose ? `--purpose ${args.purpose}` : null,
      ]
        .filter((s): s is string => s !== null)
        .join(" ");
      throw new Error(
        `${(e as Error).message} — run 'npm run spine-prepare -- ${prepareArgs}' first, then start spined again.`,
      );
    }
    throw new Error(
      `${(e as Error).message} — the ledger file exists but could not be loaded; this needs manual ` +
        `inspection, NOT 'npm run spine-prepare' (that would overwrite it — see spine-prepare's --force guard).`,
    );
  }

  const executor = createExecutor({
    ledger,
    instruction:
      ledger.getInstruction() ??
      "(no instruction was persisted by the prepare step — take the scope entirely from the chat.)",
    askHuman: unreachableAskHuman,
    say: unreachableSay,
    // Engine adaptation A: no terminal to ask on — see executor.ts's
    // ExecutorDeps.approvalPolicy for the full rationale.
    approvalPolicy: "broker-only",
  });

  const tools: SpinedTool[] = [
    ...buildActionTools(executor, { keepAliveIntervalMs: KEEPALIVE_INTERVAL_MS }),
    buildStatusTool(ledger, executor),
  ];

  return { ticket: args.ticket, ledger, executor, lock, tools };
}

/** Adapt the real MCP RequestHandlerExtra down to tools.ts's trimmed
 *  SpinedToolExtra — see tools.ts's header for why the dispatch logic itself
 *  never depends on the SDK's own extra type. Exported (with registerTools
 *  below) so the wire glue itself — progressToken plumbed from `_meta`,
 *  notification actually sent over a real transport, keep-alive timer
 *  cleaned up — is directly testable against a real McpServer/Client pair
 *  (InMemoryTransport), not just tools.ts's handlers in isolation. */
export function adaptExtra(extra: RequestHandlerExtra<ServerRequest, ServerNotification>): SpinedToolExtra {
  return {
    progressToken: extra._meta?.progressToken,
    sendNotification: (n) => extra.sendNotification(n as ServerNotification),
  };
}

export function registerTools(server: McpServer, tools: SpinedTool[]): void {
  for (const t of tools) {
    if (t.inputSchema) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema }, (args, extra) =>
        t.handler(args as Record<string, unknown>, adaptExtra(extra)),
      );
    } else {
      server.registerTool(t.name, { description: t.description }, (extra) => t.handler({}, adaptExtra(extra)));
    }
  }
}

async function main(): Promise<number> {
  let startup: SpinedStartup;
  try {
    startup = await startSpined(process.argv.slice(2));
  } catch (e) {
    // Nothing has connected a transport yet — ordinary stderr is safe and
    // correct here (this is the ONLY point spined ever exits non-zero).
    console.error(`[spined] ${(e as Error).message}`);
    return 2;
  }

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    startup.lock.release();
  };
  process.on("exit", releaseOnce);
  process.on("SIGINT", () => {
    releaseOnce();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    releaseOnce();
    process.exit(0);
  });

  // From here on, stdout is the JSON-RPC wire ONLY — see stdio-guard.ts.
  const mcpStdout = guardStdoutForMcp();
  console.error(`[spined] ticket=${startup.ticket} — ledger loaded, ${startup.tools.length} tools registered.`);

  const server = new McpServer({ name: "spine", version: "0.0.0" });
  registerTools(server, startup.tools);

  const transport = new StdioServerTransport(process.stdin, mcpStdout);
  await server.connect(transport);
  return 0; // unreachable while the transport stays open; kept for a clean return type
}

// Run the CLI only when this module is the process entrypoint (same pattern
// as spine/index.ts/workerd/index.ts) — importing spined/index.ts must never
// start the daemon or exit the process.
const invokedDirectly = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main()
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
