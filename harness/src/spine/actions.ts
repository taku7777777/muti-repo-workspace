/**
 * spine/actions.ts — the typed action surface between the orchestrator LLM and
 * the coded spine (docs/agent-orchestration.md, "Architecture: propose →
 * validate → execute"). This is the ENTIRE effect boundary: the model can only
 * ever cause something to happen by calling one of these tools, and every
 * result it sees back is one of the typed `ActionResult` variants below —
 * never free-form prose the state machine has to interpret.
 *
 * Three things live here on purpose, kept together so they can never drift:
 *   1. One ZOD RAW SHAPE per action — the exact shape `tool()` needs (a plain
 *      object of zod types, NOT z.object(...); confirmed live against
 *      @anthropic-ai/claude-agent-sdk@0.3.205 — see spine/session.ts).
 *   2. `SpineAction` — the discriminated union spine/executor.ts switches on.
 *      Built by spine/session.ts's tool handlers from the validated args plus
 *      the literal `action` tag; never constructed from unvalidated input.
 *   3. `ActionResult` — what a tool handler JSON.stringify()s into the text
 *      block the model reads. Always `{ok:true, ...}` or `{ok:false, code,
 *      error}` with a CLOSED set of stable codes (mirrors the taxonomy shape
 *      of workerd/protocol.ts's WorkerErrorCode / publish.ts's PublishResponse
 *      — "every failure is a named, fail-closed reason", never a bare throw
 *      the model has to guess at).
 *
 * Bounds: a REPO name is a bare name (mirrors workerd/protocol.ts's BARE_NAME
 * — deliberately NOT imported from there: that file's exports are scoped to
 * the worker wire contract, and this milestone's allowed no-behavior-change
 * exports are limited to gates.ts/orchestrator.ts/steps.ts; a few lines of
 * regex duplication is cheaper than widening that file's surface). Free-text
 * fields are bounded generously but finitely — an orchestrator LLM is
 * reading worker/human output, i.e. attacker-influenceable content (memo:
 * "an orchestrator LLM ... must be treated as injectable"), so no field here
 * is unbounded.
 */
import { z } from "zod";
import type { Plan, Review, ReviewFinding } from "../types.js";

// --- shared field schemas ----------------------------------------------------

// A bare repo name — must match a name in config/repos.json (checked at
// dispatch time by ledger.hasRepo, not here: this schema only bounds SHAPE,
// never resolves a path). Never a path: no '/', no '..'.
const REPO = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, "must be a bare repo name (letters, digits, . _ -)")
  .refine((s) => s !== "." && s !== ".." && !s.includes(".."), {
    message: "must not be '.', '..', or contain '..'",
  });

// Free-text fields the model supplies. Bounded so a single action can never
// smuggle an unbounded payload through the spine (defense in depth — the SDK
// itself already bounds tool-call payloads, but this is OUR contract, checked
// regardless of what the transport allows).
const INSTRUCTION = z.string().min(1).max(64 * 1024);
const QUESTION = z.string().min(1).max(4 * 1024);
const CONTENT = z.string().min(1).max(20 * 1024);
const SUMMARY = z.string().min(1).max(4 * 1024);
const REASON = z.string().min(1).max(4 * 1024);

// --- one zod RAW SHAPE per action tool (tool()'s 3rd arg) --------------------
// Each is a plain object of zod types — NOT z.object(...) — per the confirmed
// SDK fact in the M2 plan. Exported so spine/session.ts can pass them straight
// to tool() and so actions.test.ts can wrap them in z.object(...) to unit-test
// accept/reject without touching the SDK at all.

export const RunWorkerShape = { repo: REPO, instruction: INSTRUCTION };
export const RunTestsShape = { repo: REPO };
export const ReviewDiffShape = { repo: REPO };
export const PlanRepoShape = { repo: REPO };
export const AskHumanShape = { question: QUESTION };
export const ShowHumanShape = { content: CONTENT };
export const RequestPublishShape = { repo: REPO };
export const DoneShape = { summary: SUMMARY };
export const AbortShape = { reason: REASON };

// z.object() wrappers of the shapes above, for validation outside the SDK
// (unit tests, and any internal defense-in-depth parse before dispatch).
export const RunWorkerArgs = z.object(RunWorkerShape);
export const RunTestsArgs = z.object(RunTestsShape);
export const ReviewDiffArgs = z.object(ReviewDiffShape);
export const PlanRepoArgs = z.object(PlanRepoShape);
export const AskHumanArgs = z.object(AskHumanShape);
export const ShowHumanArgs = z.object(ShowHumanShape);
export const RequestPublishArgs = z.object(RequestPublishShape);
export const DoneArgs = z.object(DoneShape);
export const AbortArgs = z.object(AbortShape);

// --- the internal discriminated union the executor dispatches on ------------
// `action` (not `op`, unlike workerd/protocol.ts's `op`) — deliberately
// distinct field name so a SpineAction and a WorkerRequest can never be
// confused if either is ever logged/serialized side by side.
export type SpineAction =
  | { action: "run_worker"; repo: string; instruction: string }
  | { action: "run_tests"; repo: string }
  | { action: "review_diff"; repo: string }
  | { action: "plan_repo"; repo: string }
  | { action: "ask_human"; question: string }
  | { action: "show_human"; content: string }
  | { action: "request_publish"; repo: string }
  | { action: "done"; summary: string }
  | { action: "abort"; reason: string };

export const ACTION_NAMES = [
  "run_worker",
  "run_tests",
  "review_diff",
  "plan_repo",
  "ask_human",
  "show_human",
  "request_publish",
  "done",
  "abort",
] as const;

// --- typed results ------------------------------------------------------------
// Every failure the spine can hand back. Fail-CLOSED taxonomy (same posture as
// workerd/protocol.ts's WorkerErrorCode): a non-ok result always means "the
// action did not happen (or did not happen safely)" — never partial trust.
export type ActionErrorCode =
  | "invalid_action" // action tag did not match any known action (should be unreachable — defense in depth)
  | "budget_exhausted" // MRW_SPINE_MAX_ACTIONS or MRW_SPINE_MAX_WORKER_RUNS hit
  | "busy" // a dispatch is already in flight (serial-by-construction executor)
  | "invariants_not_met" // request_publish before green test + approving review of HEAD
  | "repo_unknown" // repo not in this ticket's ledger
  | "step_failed" // the underlying harness step (worker/test/review/plan) threw or was incomplete
  | "publish_declined" // a human said no at a publish gate
  | "publish_failed" // publish() threw (broker refusal / transport error)
  | "session_ended"; // Engine adaptation B (docs/mrw-chat.md #2): dispatch() called after done()/abort() already recorded a terminal outcome. A real behavior change, not just a spined-only concern — spine/session.ts's tool handlers call dispatch() straight from the model's tool-call turn, independent of repl.ts's own prompt loop, so a same-turn extra tool call that used to EXECUTE is now refused here (see executor.ts's dispatch() for the full explanation).

export interface ActionFailure {
  ok: false;
  code: ActionErrorCode;
  error: string;
}

export interface RunWorkerOk {
  ok: true;
  committed: boolean;
  headSha: string;
}

export interface RunTestsOk {
  ok: true;
  pass: boolean;
  status: number | null;
  /** Tail of combined stdout+stderr (gates.ts's testGate already truncates it). */
  output: string;
}

export interface ReviewDiffOk {
  ok: true;
  verdict: Review["verdict"];
  findings: ReviewFinding[];
  summary: string;
}

export interface PlanRepoOk {
  ok: true;
  plan: Plan;
}

export interface AskHumanOk {
  ok: true;
  answer: string;
}

export interface ShowHumanOk {
  ok: true;
}

export interface RequestPublishOk {
  ok: true;
  published: boolean;
  sha?: string;
  prUrl?: string | null;
  /** Set when BROKER_SOCKET is unset — publish.ts's Phase-1 stub path. */
  note?: string;
}

export interface DoneOk {
  ok: true;
}

export interface AbortOk {
  ok: true;
}

export type ActionResult =
  | RunWorkerOk
  | RunTestsOk
  | ReviewDiffOk
  | PlanRepoOk
  | AskHumanOk
  | ShowHumanOk
  | RequestPublishOk
  | DoneOk
  | AbortOk
  | ActionFailure;
