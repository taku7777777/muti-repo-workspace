/**
 * spined/stdio-guard.ts — protects the MCP JSON-RPC wire from stray writes.
 *
 * A stdio MCP server (@modelcontextprotocol/sdk's StdioServerTransport) MUST
 * treat stdout as EXCLUSIVELY the framed JSON-RPC channel — any stray text
 * written there corrupts what the client is parsing. But the engine code
 * this daemon dispatches into was written for a terminal/socket process and
 * writes straight to stdout on its own: publish.ts's `console.log` lines run
 * on EVERY successful request_publish (not just a fallback edge case), and
 * gates.ts's testGate() additionally does a raw `process.stdout.write()` of
 * the test command's own output in the WORKERD_SOCKET-unset (single-
 * container/dev) fallback. None of those files are in this phase's scope to
 * change (docs/mrw-chat.md Phase C2: they are shared with the legacy REPL/
 * CLI/daemon entrypoints, where stdout IS the right place for them) — so
 * spined protects itself locally instead.
 *
 * Mechanism: open a SEPARATE Writable on fd 1 (`fs.createWriteStream`) and
 * hand THAT (not the global `process.stdout`) to the MCP transport, then
 * redirect every OTHER writer in this process — `console.log` and any direct
 * `process.stdout.write` call — to stderr. Because the transport's stream is
 * a genuinely distinct object opened on the same fd, nothing done to
 * `process.stdout` afterwards can affect it; from this point on exactly one
 * writer ever touches fd 1 (the transport) and everything else lands on fd 2.
 */
import * as fs from "node:fs";
import * as util from "node:util";

type ConsoleLog = typeof console.log;
type StdoutWrite = typeof process.stdout.write;

export interface StdioGuardHandle {
  /** Restores console.log/process.stdout.write to their original functions.
   *  Does NOT close the separate fd-1 stream returned by guardStdoutForMcp()
   *  — that stream is independent and outlives this call either way. */
  restore(): void;
}

/**
 * Redirect every `console.log`/`process.stdout.write` call in this process
 * through `sink` instead of the real stdout. Factored out from
 * `guardStdoutForMcp()` below so it is unit-testable without touching a real
 * file descriptor (tests inject a sink that appends to an array).
 */
export function redirectStdoutWrites(sink: (chunk: string) => void): StdioGuardHandle {
  const originalConsoleLog: ConsoleLog = console.log;
  // Captured WITHOUT .bind() — this reference is only ever reassigned back
  // onto process.stdout.write in restore() below, never called directly by
  // this module, so it must stay the exact original function object.
  const originalStdoutWrite: StdoutWrite = process.stdout.write;

  console.log = (...args: unknown[]): void => {
    // util.format (the SAME formatter console.log itself uses internally) —
    // NOT JSON.stringify: a circular object or a BigInt argument would make
    // JSON.stringify throw, and that throw would happen INSIDE whatever
    // dispatch triggered the stray console.log call (e.g. publish.ts's),
    // turning a harmless log line into a crashed action. util.format never
    // throws — circular refs render as "<ref *1> ... [Circular *1]", BigInts
    // render as "1n", exactly like a real console.log would show them.
    sink(util.format(...args) + "\n");
  };

  process.stdout.write = ((chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
    sink(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    const cb = rest.find((a): a is (err?: Error) => void => typeof a === "function");
    cb?.();
    return true;
  }) as StdoutWrite;

  return {
    restore(): void {
      console.log = originalConsoleLog;
      process.stdout.write = originalStdoutWrite;
    },
  };
}

/**
 * Open the dedicated fd-1 stream for the MCP transport and redirect every
 * other stdout writer in this process to stderr. Call this ONCE, after
 * startup diagnostics are done and right before `server.connect()` — nothing
 * in startSpined() itself writes to stdout, so the ordinary fail-closed
 * startup errors (console.error, already stderr) are unaffected either way.
 */
export function guardStdoutForMcp(): fs.WriteStream {
  // autoClose:false — this stream must never close the real fd 1 out from
  // under the process on its own; only process exit ends it.
  const mcpStdout = fs.createWriteStream("", { fd: 1, autoClose: false });
  redirectStdoutWrites((chunk) => process.stderr.write(chunk));
  return mcpStdout;
}
