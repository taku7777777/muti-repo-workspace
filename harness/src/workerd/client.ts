/**
 * workerd/client.ts — the orchestrator-side RPC client, modeled directly on
 * publish.ts's sendToBroker: connect, write ONE newline-terminated JSON
 * request, read ONE newline-terminated JSON response, done.
 *
 * The typed rpc* helpers below additionally validate the OUTGOING request
 * against WorkerRequestSchema (a client-side bug should fail loudly here, not
 * arrive at the daemon as a confusing "invalid_request") and throw on an
 * `ok:false` response so exec.ts's callers can treat every RPC call the same
 * way they already treat the fallback in-process calls: a throw is a hard,
 * fail-closed stop.
 */
import * as net from "node:net";
import { WorkerRequestSchema } from "./protocol.js";
import type { WorkerRequest, WorkerResponse } from "./protocol.js";
import type { CommitResult } from "../gitops.js";
import type { TestResult } from "../gates.js";
import type { RepoConfig } from "../multi/types.js";

// Must exceed the daemon's own per-op budget (WORKERD_STEP_TIMEOUT_MS,
// default 45 min — see workerd/index.ts) by a comfortable margin: the same
// pattern as publish.ts's CONNECT_TIMEOUT_MS vs the broker's approval budget.
// The daemon replies `{ok:false, code:"timeout"}` itself when ITS budget
// expires; this client timeout only needs to cover the case where that reply
// never arrives at all (a wedged daemon / dropped socket), so it must be
// strictly larger.
const _rawStepBudget = Number(process.env.WORKERD_STEP_TIMEOUT_MS ?? "");
const STEP_BUDGET_MS =
  Number.isFinite(_rawStepBudget) && _rawStepBudget >= 0 ? _rawStepBudget : 45 * 60 * 1000;
const CLIENT_TIMEOUT_MS = STEP_BUDGET_MS + 5 * 60 * 1000;

function socketPath(): string {
  const p = process.env.WORKERD_SOCKET;
  if (!p) {
    throw new Error("WORKERD_SOCKET is unset — callers must check this before using the RPC client");
  }
  return p;
}

/** Send one request, read one response. Rejects on TRANSPORT failure only; a
 *  parsed `{ok:false,...}` response resolves normally (the caller decides). */
export function sendWorkerRequest(
  path: string,
  req: WorkerRequest,
  timeoutMs: number,
): Promise<WorkerResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path });
    let buf = "";
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };

    sock.setEncoding("utf8");
    sock.setTimeout(timeoutMs, () =>
      done(() => reject(new Error("workerd did not respond before timeout"))),
    );
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        resolve(JSON.parse(line) as WorkerResponse);
        settled = true;
        sock.destroy();
      } catch (e) {
        done(() => reject(new Error(`malformed workerd response: ${(e as Error).message}`)));
      }
    });
    sock.on("error", (err) => done(() => reject(err)));
    sock.on("end", () => {
      if (!settled) done(() => reject(new Error("workerd closed the connection without a response")));
    });
  });
}

/** Validate the outgoing request against the wire schema, send it, and return
 *  the raw response (still possibly `ok:false`) for the op-specific helper to
 *  unwrap. */
async function call(req: WorkerRequest): Promise<WorkerResponse> {
  const parsed = WorkerRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new Error(`internal: outgoing workerd request failed its own schema: ${parsed.error.message}`);
  }
  return sendWorkerRequest(socketPath(), parsed.data, CLIENT_TIMEOUT_MS);
}

export async function rpcSetupWorktree(args: {
  ticket: string;
  branch: string;
  purpose: string;
  repo: RepoConfig;
}): Promise<{ repoDir: string; baseSha: string }> {
  const res = await call({ op: "setup_worktree", ...args });
  if (!res.ok) throw new Error(`workerd refused (${res.code}): ${res.error}`);
  if (res.op !== "setup_worktree") {
    throw new Error(`workerd returned unexpected op '${res.op}' for a setup_worktree request`);
  }
  return { repoDir: res.repoDir, baseSha: res.baseSha };
}

async function rpcEditStep(
  op: "run_implement" | "run_fix",
  args: { ticket: string; repo: string; prompt: string; commitMessage: string },
): Promise<CommitResult> {
  const res = await call({ op, ...args });
  if (!res.ok) throw new Error(`workerd refused (${res.code}): ${res.error}`);
  if (res.op !== "run_implement" && res.op !== "run_fix") {
    throw new Error(`workerd returned unexpected op '${res.op}' for a ${op} request`);
  }
  return { committed: res.committed, headSha: res.headSha };
}

export function rpcRunImplement(args: {
  ticket: string;
  repo: string;
  prompt: string;
  commitMessage: string;
}): Promise<CommitResult> {
  return rpcEditStep("run_implement", args);
}

export function rpcRunFix(args: {
  ticket: string;
  repo: string;
  prompt: string;
  commitMessage: string;
}): Promise<CommitResult> {
  return rpcEditStep("run_fix", args);
}

export async function rpcRunTests(args: { ticket: string; repo: string }): Promise<TestResult> {
  const res = await call({ op: "run_tests", ...args });
  if (!res.ok) throw new Error(`workerd refused (${res.code}): ${res.error}`);
  if (res.op !== "run_tests") {
    throw new Error(`workerd returned unexpected op '${res.op}' for a run_tests request`);
  }
  return { pass: res.pass, status: res.status, output: res.output };
}
