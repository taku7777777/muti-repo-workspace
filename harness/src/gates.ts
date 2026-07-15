/**
 * gates.ts — the NON-model deciders.
 *
 *   testGate()      — runs the repo's TEST_COMMAND via spawnSync and branches on
 *                     status === 0 ONLY. The model never decides pass/fail.
 *   humanApproval() — an explicit readline y/N gate (approve-plan / approve-publish).
 *
 * These are the hard boundaries of the state machine: a green exit code and a
 * human 'yes'. Everything the model returns is advisory until it clears these.
 */
import { spawnSync } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TEST_COMMAND } from "./sdk.js";

export interface TestResult {
  pass: boolean;
  /** Raw spawnSync exit status. Carried through to the workerd wire response
   *  (protocol.ts's run_tests op) as-is; null means the process never exited
   *  normally (killed by `timeout`, or spawn failed outright). */
  status: number | null;
  /** Tail of combined stdout+stderr, fed to the fix step when tests are red. */
  output: string;
}

/**
 * Harness-run test gate. Runs OUTSIDE the SDK so the model cannot influence the
 * verdict. We capture output (to feed a failing fix pass) and also echo it.
 * Branch on status === 0 ONLY — a null status (killed/timeout) is a failure.
 *
 * `repoDir` is passed explicitly by the orchestrator so a multi-repo driver can
 * run the gate against each per-repo worktree in the same process (module-level
 * CWD would pin every repo to the same directory).
 *
 * `timeoutMs` is optional: the CLI/fallback path leaves the test command
 * unbounded (Phase-1 behavior), while the worker daemon (workerd/handlers.ts)
 * always supplies its own budget so a hung `TEST_COMMAND` cannot wedge the
 * serial daemon past its per-op timeout.
 */
export function testGate(repoDir: string, timeoutMs?: number): TestResult {
  console.log(`\n[test-gate] (cwd=${repoDir}) $ ${TEST_COMMAND}\n`);
  const r = spawnSync(TEST_COMMAND, {
    cwd: repoDir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
  });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(combined);
  // spawnSync reports status=null when the process was killed (e.g. our own
  // `timeout` above) or never spawned — never trust a null status as a pass.
  return { pass: r.status === 0, status: r.status, output: tail(combined) };
}

/** Keep only the last N lines — test logs can be huge; the tail is what matters. */
function tail(text: string, lines = 200): string {
  const arr = text.split("\n");
  return arr.length <= lines ? text : arr.slice(-lines).join("\n");
}

/**
 * Explicit human gate. Returns true only on an affirmative y/yes.
 *
 * EOF is a DECLINE, not a hang: if stdin closes before an answer arrives
 * (piped input exhausted, terminal gone), rl.question's promise would never
 * settle — and with nothing else on the event loop, node would exit silently
 * mid-await, skipping the caller's decline/record path entirely (observed
 * live in the M1 smoke run: the driver died at the last gate without writing
 * its ledger). Racing against the interface's 'close' resolves "" → false,
 * so a vanished human is a recorded, fail-closed decline.
 */
export async function humanApproval(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await Promise.race([
      rl.question(`${question} [y/N] `),
      new Promise<string>((resolve) => rl.once("close", () => resolve(""))),
    ]);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
