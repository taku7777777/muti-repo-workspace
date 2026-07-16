/**
 * spined/tools.ts — the spined daemon's MCP tool table: turns one validated
 * tool call into an `executor.dispatch()` call (or, for `status`, a
 * read-only ledger peek), the SAME shape as spine/session.ts's buildTools()
 * but over @modelcontextprotocol/sdk's McpServer instead of the Agent SDK's
 * in-process createSdkMcpServer (see spined/index.ts's header for why that
 * distinction matters for a STANDALONE stdio server).
 *
 * Deliberately framework-light: this file describes tools as plain
 * `{name, description, inputSchema?, handler}` records — NOT direct
 * `server.registerTool()` calls — so the dispatch logic itself is testable
 * with a fake `Executor`/`SpineLedger` and a fake `SpinedToolExtra`, with no
 * McpServer/StdioServerTransport in the loop at all. spined/index.ts is the
 * thin adapter that registers these onto a real McpServer (mirrors
 * workerd/handlers.ts vs workerd/server.ts's split: this file is the
 * "dispatch table", index.ts is the "listener").
 *
 * Two things this file is the enforcement point for:
 *   - `ask_human`/`show_human` are NEVER built here — the action surface
 *     (spine/actions.ts) still defines them (the legacy REPL needs them),
 *     but spined exposes only the seven effect tools below plus `status`.
 *     Since a SpineAction can only ever be constructed by translating a
 *     REGISTERED tool call's validated args (never from free-form model
 *     text), omitting these two from ACTION_TOOL_BUILDERS makes them
 *     UNREACHABLE by construction over this MCP surface — see
 *     spined/index.ts's askHuman/say stubs for the matching defense-in-depth
 *     on the executor side.
 *   - `status` NEVER calls `executor.dispatch()` — every dispatched action
 *     burns the ledger's action budget by design (executor.ts's runAction:
 *     "every action consumes the total-action budget FIRST"); a "summon any
 *     time" status tool must not, so this file reads the ledger directly
 *     (SpineLedger.snapshot()/budgetsSnapshot(), both pure getters) and
 *     executor.endedInfo() (also a pure getter — see executor.ts's Executor
 *     interface), never touching dispatch() at all.
 */
import type { z } from "zod";
import * as actions from "../spine/actions.js";
import type { SpineAction } from "../spine/actions.js";
import type { Executor } from "../spine/executor.js";
import type { SpineLedger } from "../spine/ledger.js";

// --- the extra context a tool handler needs, trimmed to exactly what this
// file uses from the real MCP RequestHandlerExtra (progress notifications) —
// spined/index.ts adapts the real SDK type down to this shape at the wiring
// boundary, so tests here never need to construct a real one.
export interface SpinedToolExtra {
  /** extra._meta?.progressToken from the real MCP request — undefined when
   *  the client did not ask for progress notifications for this call. */
  progressToken?: string | number;
  /** extra.sendNotification from the real MCP RequestHandlerExtra. Used ONLY
   *  for the notifications/progress keep-alive below; a rejected promise
   *  from this must never propagate into (or fail) the dispatch itself. */
  sendNotification: (notification: {
    method: "notifications/progress";
    params: Record<string, unknown>;
  }) => Promise<void>;
}

export interface SpinedToolResult {
  content: Array<{ type: "text"; text: string }>;
  // McpServer's CallToolResult carries an index signature (it also allows
  // arbitrary _meta/other fields) — this keeps our narrower result type
  // structurally assignable to it at the registerTool() call site (index.ts)
  // without a cast.
  [key: string]: unknown;
}

export interface SpinedTool {
  name: string;
  description: string;
  /** A zod raw shape (spine/actions.ts's *Shape exports) — undefined for the
   *  zero-argument `status` tool. */
  inputSchema?: Record<string, z.ZodTypeAny>;
  handler: (args: Record<string, unknown>, extra: SpinedToolExtra) => Promise<SpinedToolResult>;
}

function textResult(value: unknown): SpinedToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

// --- keep-alive progress (docs/mrw-chat.md "New pieces": "Keep-alive
// progress") --------------------------------------------------------------
// While a dispatch is in flight, if the client supplied a progressToken,
// emit a coarse notifications/progress every ~10s so a long run_worker
// renders live in the TUI (C1-proven) instead of looking hung. A
// notification failure (e.g. the client went away) must NEVER kill the
// dispatch it is merely narrating — caught and swallowed, not rethrown.
export const DEFAULT_KEEPALIVE_INTERVAL_MS = 10_000;

async function withKeepAliveProgress<T>(
  actionName: string,
  extra: SpinedToolExtra,
  intervalMs: number,
  fn: () => Promise<T>,
): Promise<T> {
  if (extra.progressToken === undefined) {
    return fn();
  }
  const progressToken = extra.progressToken;
  let elapsedSec = 0;
  const timer = setInterval(() => {
    elapsedSec += intervalMs / 1000;
    extra
      .sendNotification({
        method: "notifications/progress",
        params: { progressToken, progress: elapsedSec, message: `${actionName} running — ${elapsedSec}s elapsed` },
      })
      .catch(() => {
        // Boundary-side narration only (docs/mrw-chat.md: "This is
        // boundary-side narration only") — a dropped/errored notification is
        // never a reason to fail (or even log noisily during) the underlying
        // dispatch, which keeps running regardless.
      });
  }, intervalMs);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

// --- action tools (dispatch through the executor) -----------------------------
// One tool per SpineAction variant EXCEPT ask_human/show_human (see header).
// Each does the SAME three things spine/session.ts's buildTools() does:
// build the typed SpineAction from validated args, dispatch it, JSON.stringify
// the ActionResult into the tool's text block — plus the keep-alive wrapper.
interface ActionToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  toAction: (args: Record<string, unknown>) => SpineAction;
}

const ACTION_TOOL_SPECS: ActionToolSpec[] = [
  {
    name: "run_worker",
    description:
      "Apply `instruction` to `repo` by editing files and committing deterministically. Use this both for " +
      "the first implementation and for any follow-up fix — there is no separate fix tool; describe what " +
      "changed and what still needs fixing in `instruction`.",
    inputSchema: actions.RunWorkerShape,
    toAction: (a) => ({ action: "run_worker", repo: a.repo as string, instruction: a.instruction as string }),
  },
  {
    name: "run_tests",
    description:
      "Run `repo`'s test command. The exit code is the ONLY test truth — you cannot influence or override " +
      "this verdict by claiming otherwise.",
    inputSchema: actions.RunTestsShape,
    toAction: (a) => ({ action: "run_tests", repo: a.repo as string }),
  },
  {
    name: "review_diff",
    description:
      "Get an independent, read-only review of `repo`'s committed diff (baseSha..HEAD) against its recorded " +
      "plan (or the ticket instruction if no plan was recorded).",
    inputSchema: actions.ReviewDiffShape,
    toAction: (a) => ({ action: "review_diff", repo: a.repo as string }),
  },
  {
    name: "plan_repo",
    description:
      "Produce a read-only implementation plan for `repo`. Recorded for later review context and the publish " +
      "body; not required before run_worker, but request_publish requires one.",
    inputSchema: actions.PlanRepoShape,
    toAction: (a) => ({ action: "plan_repo", repo: a.repo as string }),
  },
  {
    name: "request_publish",
    description:
      "Ask to publish `repo`'s committed changes. Requires a green run_tests AND an approving review_diff, " +
      "BOTH recorded of the CURRENT head in this session. There is no in-chat approval prompt on this path " +
      "(spined runs under approvalPolicy 'broker-only') — the authoritative human approval happens at the " +
      "publish broker, outside this session, via a SHA-typed gate you cannot see or answer yourself. A " +
      "missing/stale requirement is returned as a typed error naming exactly what to do next.",
    inputSchema: actions.RequestPublishShape,
    toAction: (a) => ({ action: "request_publish", repo: a.repo as string }),
  },
  {
    name: "done",
    description: "Declare the ticket complete and end this session, with a summary for the human.",
    inputSchema: actions.DoneShape,
    toAction: (a) => ({ action: "done", summary: a.summary as string }),
  },
  {
    name: "abort",
    description: "Abort this session (fail-closed stop) with a reason for the human.",
    inputSchema: actions.AbortShape,
    toAction: (a) => ({ action: "abort", reason: a.reason as string }),
  },
];

export function buildActionTools(executor: Executor, opts?: { keepAliveIntervalMs?: number }): SpinedTool[] {
  const intervalMs = opts?.keepAliveIntervalMs ?? DEFAULT_KEEPALIVE_INTERVAL_MS;
  return ACTION_TOOL_SPECS.map((spec) => ({
    name: spec.name,
    description: spec.description,
    inputSchema: spec.inputSchema,
    handler: async (args, extra) => {
      const result = await withKeepAliveProgress(spec.name, extra, intervalMs, () =>
        executor.dispatch(spec.toAction(args)),
      );
      return textResult(result);
    },
  }));
}

// --- status (budget-exempt, ledger-only, never dispatch()) --------------------
export function buildStatusTool(ledger: SpineLedger, executor: Executor): SpinedTool {
  return {
    name: "status",
    description:
      "Read-only ticket status: per-repo baseSha/headSha, whether tests are green and a review is approved " +
      "AT the current head, published state, remaining action/worker-run budgets, and whether the session has " +
      "ended. Does NOT count against the action budget — call this any time, as often as you like.",
    handler: async () => {
      // snapshot()/budgetsSnapshot() are pure getters (spine/ledger.ts) — no
      // I/O, no mutation, no budget consumption. endedInfo() is likewise a
      // pure getter on the executor's own in-memory state.
      const snap = ledger.snapshot();
      const budgets = ledger.budgetsSnapshot();
      const repos = Object.fromEntries(
        Object.entries(snap.repos).map(([name, entry]) => [
          name,
          {
            baseSha: entry.baseSha,
            headSha: entry.headSha,
            tests: entry.testGreen
              ? { sha: entry.testGreen.sha, atHead: entry.testGreen.sha === entry.headSha }
              : null,
            review: entry.reviewApproved
              ? {
                  verdict: entry.reviewApproved.review.verdict,
                  sha: entry.reviewApproved.sha,
                  atHead: entry.reviewApproved.sha === entry.headSha,
                }
              : null,
            published: entry.published,
          },
        ]),
      );
      return textResult({
        ok: true,
        ticket: snap.ticket,
        repos,
        budgets,
        ended: executor.endedInfo(),
      });
    },
  };
}
