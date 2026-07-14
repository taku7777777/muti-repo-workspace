/**
 * sdk.ts — the thin, SDK-facing layer.
 *
 * Two responsibilities:
 *   1. baseOptions()          — the Options shared by every pipeline step.
 *   2. runStructuredQuery<T>() — a #277-safe structured-output read+validate.
 *      runAgentQuery()        — drain a side-effecting step, throw on error.
 *
 * Every step is a SEPARATE top-level query() with NONE of
 * continue/resume/forkSession set, so each gets FRESH context by construction.
 * That freshness is the determinism lever; the coded state machine (orchestrator)
 * is what actually decides anything.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

// --- Config (env-overridable) ------------------------------------------------
// Model alias; the CLI resolves 'sonnet' to the current default Sonnet.
export const MODEL = process.env.HARNESS_MODEL ?? "sonnet";
// The repo the agent operates on. Defaults to cwd; point REPO_DIR at a worktree.
export const CWD = process.env.REPO_DIR ?? process.cwd();
// The harness-run test gate command. The state machine branches on its exit code.
// NOTE: this is OPERATOR-pinned (env / default), never read from the mutable repo
// — but it still executes the repo's own scripts/tests, which the coder can edit.
// The test-touch guard in the orchestrator handles that (see diffTouchesTests).
export const TEST_COMMAND = process.env.TEST_COMMAND ?? "npm test";
// Bound on the fix ⇄ review/test loop. Fail-closed once exhausted. Parse
// DEFENSIVELY: a non-numeric env value must not yield NaN, which would make
// `attempt >= NaN` always false and the "bounded" loop never fail-close.
const _rawMax = Number(process.env.MAX_FIX_ATTEMPTS ?? "3");
export const MAX_FIX_ATTEMPTS =
  Number.isInteger(_rawMax) && _rawMax >= 0 ? _rawMax : 3;

// --- Tool sets ---------------------------------------------------------------
// CRITICAL (SDK 0.3.205, sdk.d.ts:1331): `allowedTools` only AUTO-APPROVES; it
// does NOT remove tools. Under permissionMode 'bypassPermissions' every built-in
// is auto-approved, so a "read-only" step declared via allowedTools would still
// be able to Edit/Write/Bash (issue #115). To actually restrict, we set the base
// tool set via `tools` AND deny the dangerous ones via `disallowedTools` (deny
// wins even under bypass). Read-only steps get no mutation/network tools at all.
export const READ_ONLY_TOOLS = ["Read", "Grep", "Glob"];
export const EDIT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
// Never wanted by any step (no network egress is allowlisted for the coder, and
// notebook edits are out of scope). Denied everywhere as defense in depth.
export const DENY_ALWAYS = ["WebFetch", "WebSearch", "NotebookEdit"];
export const DENY_MUTATION = ["Edit", "Write", "Bash", "NotebookEdit", "WebFetch", "WebSearch"];

/**
 * Options shared by every step.
 *
 * - permissionMode 'bypassPermissions' is the CONVENIENCE lever (no per-tool
 *   prompts); CONTAINMENT is the NETWORK boundary (the egress sidecar), NOT the
 *   permission prompt. It REQUIRES allowDangerouslySkipPermissions:true in SDK
 *   0.3.205 (sdk.d.ts:1708) — without it every query() is rejected at runtime.
 * - bypassPermissions SHADOWS canUseTool, so per-step tool scoping is done with
 *   `tools`/`disallowedTools` (set by each step), NOT allowedTools/canUseTool.
 *   For a Phase 3 audit trail use a PreToolUse HOOK.
 * - settingSources defaults to ['project'] here (load the repo's CLAUDE.md/.claude
 *   conventions) but the READ-ONLY judge steps override it to [] so a malicious
 *   target-repo CLAUDE.md cannot instruct the reviewer.
 */
export function baseOptions(extra: Partial<Options>): Options {
  return {
    model: MODEL,
    cwd: CWD,
    permissionMode: "bypassPermissions",
    // Required companion of bypassPermissions (SDK 0.3.205). Safe here ONLY
    // because the real boundary is the container network namespace.
    allowDangerouslySkipPermissions: true,
    // Load the repo's CLAUDE.md / .claude settings, but nothing user-global.
    settingSources: ["project"],
    // Headless auth: the bundled CLI subprocess reads CLAUDE_CODE_OAUTH_TOKEN
    // (subscription) or ANTHROPIC_API_KEY from the inherited env.
    env: process.env as Record<string, string | undefined>,
    stderr: (d: string) => process.stderr.write(d),
    ...extra,
  };
}

/**
 * Run a query() that MUST return structured output matching `schema`.
 *
 * Issue #277: result.subtype === 'success' does NOT guarantee structured_output
 * exists. We read msg.structured_output EXPLICITLY and validate with Zod
 * safeParse; absence or a shape mismatch is a hard failure (never trust prose).
 */
export async function runStructuredQuery<T>(
  schema: z.ZodType<T>,
  prompt: string,
  extraOptions: Partial<Options>,
): Promise<T> {
  const q = query({
    prompt,
    options: baseOptions({
      // The one and only channel the state machine reads back from the model.
      // target: draft-7 — the bundled Claude Code CLI validates the schema with
      // ajv (draft-07); Zod v4's default 2020-12 meta-schema ref is unresolvable
      // there ("no schema with key or ref …/draft/2020-12/schema").
      outputFormat: {
        type: "json_schema",
        schema: z.toJSONSchema(schema, { target: "draft-7" }),
      },
      ...extraOptions,
    }),
  });

  let structured: unknown;
  let sawSuccess = false;
  for await (const msg of q as AsyncGenerator<SDKMessage>) {
    if (msg.type === "result") {
      if (msg.subtype !== "success") {
        throw new Error(`Structured step failed: result subtype '${msg.subtype}'.`);
      }
      sawSuccess = true;
      structured = (msg as { structured_output?: unknown }).structured_output;
    }
  }

  if (!sawSuccess) {
    throw new Error("Structured step ended without a success result message.");
  }
  const parsed = schema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      "Structured step returned no valid structured_output (SDK issue #277): " +
        parsed.error.message,
    );
  }
  return parsed.data;
}

/**
 * Run a side-effecting query() (implement / fix) that edits the repo but returns
 * no structured verdict. We drain the stream and throw on a non-success result so
 * an errored step never silently flows into the test gate.
 */
export async function runAgentQuery(
  prompt: string,
  extraOptions: Partial<Options>,
): Promise<void> {
  const q = query({ prompt, options: baseOptions(extraOptions) });
  for await (const msg of q as AsyncGenerator<SDKMessage>) {
    if (msg.type === "result" && msg.subtype !== "success") {
      throw new Error(`Agent step failed: result subtype '${msg.subtype}'.`);
    }
  }
}
