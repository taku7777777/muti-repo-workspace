/**
 * publish.ts — the harness's PUBLISH client, run INSIDE the caged coder container.
 *
 * The coder cannot push: it has no GitHub egress and no git credential. To publish
 * it connects to the bind-mounted unix socket (BROKER_SOCKET) and sends ONE typed
 * PublishRequest — an INTENT, not a diff to be trusted. The broker, on the trusted
 * side, renders the ground-truth diff itself, gates on a human OUTSIDE the
 * container, and only then pushes. This file therefore holds NO token, NO push,
 * and NO git-write capability; it only asks.
 *
 * Fallback: if BROKER_SOCKET is unset, keep the Phase-1 stub behavior (no push).
 */
import * as net from "node:net";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import type { Plan, Review } from "./types.js";
import { ticketFromRepoDirLayout } from "./exec.js";

// --- wire contract (kept in sync with broker/src/types.ts) -------------------
export interface PublishRequest {
  repo: string;
  branch: string;
  title: string;
  body: string;
  ticket?: string;
}

export type PublishResponse =
  | { ok: true; sha: string; branch: string; prUrl: string | null }
  | { ok: false; code: string; error: string; sha?: string };

export interface PublishContext {
  plan: Plan;
  review: Review | null;
  /** The harness-computed working diff (already shown to the human in-container);
   *  NOT sent to the broker, which computes its own ground truth. */
  diff: string;
}

/**
 * The outcome of a publish attempt, returned so the orchestrator can build a
 * typed result (and a multi-repo driver can record the pushed sha for
 * resumability). A broker REFUSAL is never represented here — it throws, so the
 * caller fails closed.
 */
export type PublishResult =
  | { published: true; sha: string; branch: string; prUrl: string | null }
  | { published: false; reason: "stub" };

// The coder may read git locally (the worktree is bind-mounted read/write); it
// just cannot push. We resolve repo/branch to fill the INTENT; the broker
// re-derives and re-validates both from git before trusting them. `repoDir` is
// passed by the orchestrator so a multi-repo driver resolves each worktree.
function gitLine(repoDir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", repoDir, ...args], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return r.stdout.trim() || null;
}

function firstLine(s: string, max = 200): string {
  const line = s.split("\n")[0]?.trim() ?? "";
  return line.length > max ? line.slice(0, max) : line;
}

/** Build the PR body from the trusted, typed plan/review — never from the diff or
 *  free-form model prose. The broker still shows the human the ground-truth diff. */
function buildBody(plan: Plan, review: Review | null): string {
  const parts: string[] = [];
  parts.push("## Summary", plan.summary, "");
  if (plan.steps.length) {
    parts.push("## Plan", ...plan.steps.map((s) => `- ${s}`), "");
  }
  if (plan.risks.length) {
    parts.push("## Risks", ...plan.risks.map((r) => `- ${r}`), "");
  }
  if (review) {
    parts.push("## Review", `verdict: ${review.verdict}`, review.summary, "");
  }
  parts.push("---", "_Published via the Phase 2 broker (human-approved, git-verified)._");
  return parts.join("\n");
}

export function buildRequest(ctx: PublishContext, repoDir: string): PublishRequest {
  // The single-repo CLI may pin PUBLISH_REPO/PUBLISH_BRANCH via env. The
  // multi-repo driver leaves them unset so each repo resolves from its own
  // worktree (a single env value would be wrong across N repos). The broker
  // re-derives and re-validates both from git regardless.
  const repo = process.env.PUBLISH_REPO ?? path.basename(path.resolve(repoDir));
  const branch =
    process.env.PUBLISH_BRANCH ??
    gitLine(repoDir, ["rev-parse", "--abbrev-ref", "HEAD"]) ??
    "HEAD";
  const title = firstLine(ctx.plan.summary) || "Automated change";
  const request: PublishRequest = { repo, branch, title, body: buildBody(ctx.plan, ctx.review) };
  const ticket = ticketFromRepoDirLayout(repoDir);
  if (ticket !== null) request.ticket = ticket;
  return request;
}

export function brokerRefusalError(req: PublishRequest, res: Extract<PublishResponse, { ok: false }>): Error {
  const original = `[publish] broker refused (${res.code}): ${res.error}`;
  if (req.ticket !== undefined && res.code === "invalid_request") {
    return new Error(
      "broker image predates ticket routing — run `mrw infra-up --build` " +
        `(or \`docker compose build broker\`); ${original}`,
    );
  }
  return new Error(original);
}

// The broker blocks on an out-of-container human gate whose default budget is 30
// min (BROKER_APPROVAL_TIMEOUT_MS). Keep this comfortably LARGER so the coder does
// not give up mid-deliberation; if it ever does, the broker sees the dropped
// connection and ABORTS (never pushes). Fail-closed either way.
const CONNECT_TIMEOUT_MS = 35 * 60 * 1000;

/** Send the request over the unix socket and read the single-line response. */
export function sendToBroker(socketPath: string, req: PublishRequest): Promise<PublishResponse> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    let buf = "";
    let settled = false;

    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      fn();
    };

    sock.setEncoding("utf8");
    sock.setTimeout(CONNECT_TIMEOUT_MS, () =>
      done(() => reject(new Error("broker did not respond before timeout"))),
    );
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        resolve(JSON.parse(line) as PublishResponse);
        settled = true;
        sock.destroy();
      } catch (e) {
        done(() => reject(new Error(`malformed broker response: ${(e as Error).message}`)));
      }
    });
    sock.on("error", (err) => done(() => reject(err)));
    sock.on("end", () => {
      if (!settled) done(() => reject(new Error("broker closed the connection without a response")));
    });
  });
}

/**
 * PUBLISH entrypoint called by the orchestrator after its in-container gates.
 * - BROKER_SOCKET unset  => Phase-1 stub (no push), preserved verbatim.
 * - BROKER_SOCKET set    => send the typed intent; the broker's human gate is the
 *   authoritative one. A non-ok response is a HARD failure (throws → fail-closed).
 */
export async function publish(ctx: PublishContext, repoDir: string): Promise<PublishResult> {
  const socketPath = process.env.BROKER_SOCKET;
  if (!socketPath) {
    console.log(
      "[publish] stub — BROKER_SOCKET unset, Phase-1 behavior: not pushing. Start the " +
        "Phase 2 broker and bind-mount its socket to enable publishing.",
    );
    return { published: false, reason: "stub" };
  }

  const req = buildRequest(ctx, repoDir);
  console.log(
    `[publish] handing intent to broker at ${socketPath}: repo='${req.repo}' branch='${req.branch}'.\n` +
      "[publish] the AUTHORITATIVE human approval happens at the broker (outside this container).",
  );

  const res = await sendToBroker(socketPath, req);
  if (!res.ok) {
    throw brokerRefusalError(req, res);
  }
  console.log(
    `[publish] published ${req.repo}@${res.branch} (${res.sha}). ` +
      (res.prUrl ? `PR: ${res.prUrl}` : "PR created (URL not reported by gh)."),
  );
  return { published: true, sha: res.sha, branch: res.branch, prUrl: res.prUrl };
}
