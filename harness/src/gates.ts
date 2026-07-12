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
 */
export function testGate(repoDir: string): TestResult {
  console.log(`\n[test-gate] (cwd=${repoDir}) $ ${TEST_COMMAND}\n`);
  const r = spawnSync(TEST_COMMAND, {
    cwd: repoDir,
    shell: true,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  process.stdout.write(combined);
  return { pass: r.status === 0, output: tail(combined) };
}

/** Keep only the last N lines — test logs can be huge; the tail is what matters. */
function tail(text: string, lines = 200): string {
  const arr = text.split("\n");
  return arr.length <= lines ? text : arr.slice(-lines).join("\n");
}

/** Explicit human gate. Returns true only on an affirmative y/yes. */
export async function humanApproval(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  const answer = (await rl.question(`${question} [y/N] `)).trim();
  rl.close();
  return /^y(es)?$/i.test(answer);
}
