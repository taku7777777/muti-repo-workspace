/**
 * spine/session.ts — the LLM (propose) side of "propose → validate →
 * execute". Builds ONE long-lived Agent SDK session over a streaming-input
 * queue, exposing the spine's typed actions as MCP tools whose handlers run
 * IN THIS PROCESS and call straight into `executor.dispatch()` — that in-
 * process handler boundary IS the propose/dispose seam (confirmed SDK fact:
 * "handlers of in-process MCP tools run in this process — the spine").
 *
 * Options built here deliberately do NOT go through sdk.ts's baseOptions():
 * that helper's cwd (defaults to REPO_DIR/process.cwd()) and its structured-
 * output outputFormat wiring are shaped for the single-repo pipeline steps,
 * not a long-lived multi-repo chat session, so composing options explicitly
 * here is clearer than fighting baseOptions()'s defaults through `extra`. The
 * SHARED, load-bearing pieces (MODEL, READ_ONLY_TOOLS, DENY_MUTATION) are
 * still imported from sdk.ts — no duplicated tool-set policy.
 *
 * Tool posture: `tools: READ_ONLY_TOOLS` + `disallowedTools: DENY_MUTATION`
 * restricts the model's BUILT-IN tools to Read/Grep/Glob (own orientation
 * only — the workspace root is `:ro` in the split-container topology anyway).
 * Confirmed live: this does NOT block the `mcp__spine__*` tools — those stay
 * available regardless, because they are not part of the built-in tool set
 * `tools`/`disallowedTools` govern. That is exactly the split we want: no
 * built-in capability, full access to the typed action surface.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { DENY_MUTATION, MODEL, READ_ONLY_TOOLS } from "../sdk.js";
import { resolveWorkspaceRoot } from "../multi/config.js";
import { telemetryEnv } from "../telemetry.js";
import * as actions from "./actions.js";
import type { SpineAction } from "./actions.js";
import type { Executor } from "./executor.js";

export interface SpineSession {
  /** Push one human chat line as a new user turn. */
  pushUser(text: string): void;
  /** Close the prompt queue — the session ends after its current turn. */
  end(): void;
  /** The raw SDK message stream (assistant text, stream_event deltas, tool
   *  use, results) — spine/repl.ts drains this to render the chat live. */
  messages: AsyncGenerator<SDKMessage>;
}

export interface CreateSpineSessionArgs {
  /** Seeded as the FIRST user message (no system-prompt override needed —
   *  see the header comment on why this is a user turn, not `systemPrompt`). */
  systemContext: string;
  executor: Executor;
  /** The ticket this session is running for — used ONLY to self-compose
   *  OTEL_RESOURCE_ATTRIBUTES (telemetry.ts's telemetryEnv()); never
   *  forwarded into any prompt or tool. */
  ticket: string;
}

// --- the streaming-input queue ------------------------------------------------
// query({prompt: AsyncIterable<SDKUserMessage>}) keeps the session alive as
// long as the iterable stays open (confirmed SDK fact). This is a minimal
// async queue: pushUser() resolves a pending `next()` waiter (or buffers if
// none is pending yet); end() closes the iterable so the SDK ends the session
// after the turn in flight completes.
function createUserQueue(): {
  iterable: AsyncIterable<SDKUserMessage>;
  push: (text: string) => void;
  end: () => void;
} {
  const buffered: SDKUserMessage[] = [];
  const waiters: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  let ended = false;

  function toUserMessage(text: string): SDKUserMessage {
    return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
  }

  const push = (text: string) => {
    if (ended) return; // end() already called — a late push is dropped, not queued
    const msg = toUserMessage(text);
    const waiter = waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else buffered.push(msg);
  };

  const end = () => {
    if (ended) return;
    ended = true;
    while (waiters.length) {
      const waiter = waiters.shift()!;
      waiter({ value: undefined as unknown as SDKUserMessage, done: true });
    }
  };

  const iterable: AsyncIterable<SDKUserMessage> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          if (buffered.length > 0) {
            return Promise.resolve({ value: buffered.shift()!, done: false });
          }
          if (ended) {
            return Promise.resolve({ value: undefined as unknown as SDKUserMessage, done: true });
          }
          return new Promise((resolve) => waiters.push(resolve));
        },
      };
    },
  };

  return { iterable, push, end };
}

// --- action tools --------------------------------------------------------
// One MCP tool per SpineAction variant, names exactly matching the action
// tag (they surface to the model as mcp__spine__<name>). Every handler does
// the SAME three things: build the typed SpineAction from validated args,
// dispatch it through the executor, and JSON.stringify the ActionResult into
// the tool's text block — there is no other code path from "model calls a
// tool" to "spine does something".
function buildTools(executor: Executor) {
  const dispatch = async (action: SpineAction) => {
    const result = await executor.dispatch(action);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  };

  return [
    tool(
      "run_worker",
      "Apply `instruction` to `repo` by editing files and committing deterministically. Use this " +
        "both for the first implementation and for any follow-up fix — there is no separate fix tool; " +
        "describe what changed and what still needs fixing in `instruction`.",
      actions.RunWorkerShape,
      (args) => dispatch({ action: "run_worker", ...args }),
    ),
    tool(
      "run_tests",
      "Run `repo`'s test command. The exit code is the ONLY test truth — you cannot influence or " +
        "override this verdict by claiming otherwise.",
      actions.RunTestsShape,
      (args) => dispatch({ action: "run_tests", ...args }),
    ),
    tool(
      "review_diff",
      "Get an independent, read-only review of `repo`'s committed diff (baseSha..HEAD) against its " +
        "recorded plan (or the ticket instruction if no plan was recorded).",
      actions.ReviewDiffShape,
      (args) => dispatch({ action: "review_diff", ...args }),
    ),
    tool(
      "plan_repo",
      "Produce a read-only implementation plan for `repo`. Recorded for later review context and the " +
        "publish body; not required before run_worker, but request_publish requires one.",
      actions.PlanRepoShape,
      (args) => dispatch({ action: "plan_repo", ...args }),
    ),
    tool(
      "ask_human",
      "Ask the human `question` and block until they answer. Use this whenever you need a decision " +
        "only the human can make.",
      actions.AskHumanShape,
      (args) => dispatch({ action: "ask_human", ...args }),
    ),
    tool(
      "show_human",
      "Show the human `content` (status update, summary, explanation). No reply is collected — use " +
        "ask_human when you need one.",
      actions.ShowHumanShape,
      (args) => dispatch({ action: "show_human", ...args }),
    ),
    tool(
      "request_publish",
      "Ask to publish `repo`'s committed changes. Requires a green run_tests AND an approving " +
        "review_diff, BOTH recorded of the CURRENT head in this session, plus explicit human approval " +
        "at a gate you cannot see or answer yourself. A missing/stale requirement is returned as a " +
        "typed error naming exactly what to do next.",
      actions.RequestPublishShape,
      (args) => dispatch({ action: "request_publish", ...args }),
    ),
    tool(
      "done",
      "Declare the ticket complete and end this session, with a summary for the human.",
      actions.DoneShape,
      (args) => dispatch({ action: "done", ...args }),
    ),
    tool(
      "abort",
      "Abort this session (fail-closed stop) with a reason for the human.",
      actions.AbortShape,
      (args) => dispatch({ action: "abort", ...args }),
    ),
  ];
}

export function createSpineSession(args: CreateSpineSessionArgs): SpineSession {
  const { systemContext, executor, ticket } = args;
  const server = createSdkMcpServer({ name: "spine", version: "0.0.0", tools: buildTools(executor) });
  const { iterable, push, end } = createUserQueue();

  // No systemPrompt override is needed for this session — the orchestrator's
  // entire contract (who it is, what tools exist, what the invariants are) is
  // seeded as the FIRST user turn instead (M2 plan's explicit choice).
  push(systemContext);

  const options: Options = {
    model: MODEL,
    // :ro is fine (M2 plan) — this session only orients itself via
    // Read/Grep/Glob; every EFFECT goes through the spine MCP tools, which
    // reach into the writable worker-side worktree via exec.ts, not via this
    // session's own filesystem access.
    cwd: resolveWorkspaceRoot(),
    permissionMode: "bypassPermissions",
    // Required companion of bypassPermissions (sdk.ts's baseOptions() header,
    // SDK 0.3.205) — the real containment here is (a) the tool posture below
    // and (b) the container network boundary, not this permission-prompt gate.
    allowDangerouslySkipPermissions: true,
    // Never load a target repo's (or the workspace root's) CLAUDE.md into the
    // orchestrator's own session — same judge-independence rationale steps.ts
    // applies to PLAN/REVIEW, extended to the flow-control judge itself: a
    // malicious repo's CLAUDE.md must not be able to instruct the orchestrator.
    settingSources: [],
    // Confirmed live: restricts BUILT-IN tools only; MCP tools (mcp__spine__*)
    // remain callable regardless — see the header comment.
    tools: READ_ONLY_TOOLS,
    disallowedTools: DENY_MUTATION,
    mcpServers: { spine: server },
    // Lets spine/repl.ts render the assistant's text live via stream_event /
    // content_block_delta text_delta events (confirmed SDK fact).
    includePartialMessages: true,
    // Self-derived from the caller's own ticket value (never a forwarded
    // string) — see telemetry.ts's header.
    env: telemetryEnv(ticket, "spine"),
    stderr: (d: string) => process.stderr.write(d),
  };

  const q = query({ prompt: iterable, options });

  return {
    pushUser: push,
    end,
    messages: q as unknown as AsyncGenerator<SDKMessage>,
  };
}
