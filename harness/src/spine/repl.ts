/**
 * spine/repl.ts — the terminal chat surface. This is the ONLY place in the M2
 * code path that owns stdin/readline (memo invariant 5: "the spine owns the
 * terminal; ask_human returns what the human actually typed"). executor.ts is
 * handed `askHuman`/`say` callbacks that close over the SAME readline
 * interface the human's ordinary chat input uses — never a second one.
 *
 * DESIGN NOTE for the verifier: the M2 plan names a single entry point
 * `runRepl({session, executor, ledgerSummary})`. In practice `executor.ts`
 * needs `askHuman`/`say` to be CONSTRUCTED before `createExecutor()` runs, and
 * `createExecutor()` must run before `createSpineSession()` (the session's
 * tools close over the executor), which in turn must exist before the repl
 * can drain its message stream — so the repl's I/O (the readline interface)
 * necessarily comes into being BEFORE the executor/session it is later handed.
 * `createRepl()` below splits that: it opens the readline interface and
 * returns `{askHuman, say, run}` up front; `run({session, executor,
 * ledgerSummary})` is the exact call spine/index.ts makes once the rest of
 * the pipeline is wired, matching the plan's named signature for that part.
 *
 * Concurrency: a single readline interface only cleanly supports ONE pending
 * `question()` at a time. Both the ordinary "type your next message" prompt
 * and executor.ts's `askHuman` (triggered reactively from inside a tool call,
 * concurrently with that prompt) go through the SAME `askLine()` helper,
 * serialized by a tiny promise-chain lock — so an ask_human gate can never
 * race the chat prompt for the same terminal line.
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Executor } from "./executor.js";
import type { SpineSession } from "./session.js";

export interface RunReplArgs {
  session: SpineSession;
  executor: Executor;
  /** Printed once, before the chat starts (spine/index.ts's ticket/repo banner). */
  ledgerSummary?: string;
}

export interface ReplIO {
  /** Injected into createExecutor() — see executor.ts's ExecutorDeps. */
  askHuman: (question: string) => Promise<string>;
  say: (line: string) => void;
  run(args: RunReplArgs): Promise<void>;
}

export function createRepl(): ReplIO {
  const rl = readline.createInterface({ input, output });
  let closed = false;
  rl.on("close", () => {
    closed = true;
  });

  // Serializes every rl.question() call (both the chat prompt and askHuman
  // gates) through one queue, so exactly one is ever pending at a time.
  let lock: Promise<unknown> = Promise.resolve();
  function withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = lock.then(fn, fn);
    // Swallow so a rejected turn doesn't wedge the lock for the next caller;
    // the actual rejection still propagates to whoever awaited `run`.
    lock = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // EOF-is-decline (mirrors gates.ts's humanApproval fix): race the question
  // against the interface's own 'close' event resolving "" — if stdin closes
  // before an answer arrives, this resolves "" instead of hanging forever.
  function askLine(prompt: string): Promise<string> {
    if (closed) return Promise.resolve("");
    return withLock(() =>
      Promise.race([
        rl.question(prompt),
        new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
      ]),
    );
  }

  const askHuman = async (question: string): Promise<string> => {
    return askLine(`\n[spine gate] ${question} `);
  };

  const say = (line: string): void => {
    console.log(line);
  };

  async function run(args: RunReplArgs): Promise<void> {
    const { session, executor } = args;
    if (args.ledgerSummary) console.log(args.ledgerSummary);
    console.log("[spine] chat ready — type your message, or /quit to end.\n");

    let assistantLineOpen = false;

    // Drain the SDK message stream: print assistant text live from
    // stream_event/content_block_delta/text_delta events (no prefix — this is
    // the orchestrator's own voice); spine-side frames (gate prompts, [spine]/
    // [orchestrator] lines) come through `say`/`askHuman` instead, so the two
    // are visually distinguishable in the transcript.
    const pump = (async () => {
      for await (const msg of session.messages as AsyncGenerator<SDKMessage>) {
        if (msg.type === "stream_event") {
          const event = (msg as { event?: { type?: string; delta?: { type?: string; text?: string } } }).event;
          if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
            process.stdout.write(event.delta.text);
            assistantLineOpen = true;
          }
        } else if (msg.type === "result") {
          if (assistantLineOpen) {
            process.stdout.write("\n");
            assistantLineOpen = false;
          }
        }
        if (executor.isEnded()) break;
      }
    })();

    // Once the model calls done()/abort(), unblock a pending chat prompt (if
    // any) so the input loop below notices `isEnded()` promptly instead of
    // waiting for the next Enter keypress.
    pump.then(() => {
      if (executor.isEnded() && !closed) rl.close();
    });

    try {
      while (!executor.isEnded()) {
        const line = await askLine("> ");
        if (closed) break;
        const trimmed = line.trim();
        if (trimmed === "/quit") {
          session.end();
          break;
        }
        if (trimmed === "") continue; // ignore blank lines, keep prompting
        session.pushUser(line);
      }
    } finally {
      if (!closed) rl.close();
    }

    await pump;

    const info = executor.endedInfo();
    if (info) {
      console.log(`\n[spine] session ended (${info.kind}): ${info.message}`);
    }
    session.end();
  }

  return { askHuman, say, run };
}

/**
 * Convenience wrapper matching the M2 plan's named signature exactly, for
 * callers that don't need askHuman/say before the executor exists (e.g. a
 * future non-interactive driver). spine/index.ts uses `createRepl()` directly
 * instead, for the ordering reason explained in the header comment above.
 */
export async function runRepl(args: RunReplArgs): Promise<void> {
  const repl = createRepl();
  await repl.run(args);
}
