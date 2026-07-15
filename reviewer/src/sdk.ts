/**
 * sdk.ts — minimal structured-query helper for the advisory reviewer.
 *
 * The reviewer is its OWN npm package and its OWN container image (see
 * reviewer/package.json + .devcontainer/reviewer.Dockerfile) — it cannot
 * import harness/src/sdk.ts (a different package, baked into a different
 * image). This file re-derives the ESSENTIAL shape of harness/src/sdk.ts's
 * runStructuredQuery(): a single query() call that MUST return typed
 * structured_output, validated with zod before anything else trusts it.
 *
 * Lesson (harness/src/sdk.ts, cited here because it bit us once and would
 * bite us again silently): the bundled Claude Code CLI validates the
 * `outputFormat` JSON Schema with ajv in DRAFT-07 mode. Zod v4's default
 * z.toJSONSchema() emits a 2020-12 meta-schema $ref that ajv (draft-07)
 * cannot resolve ("no schema with key or ref .../draft/2020-12/schema") — so
 * `target: "draft-7"` below is NOT optional.
 *
 * Lesson (SDK issue #277, also cited in harness/src/sdk.ts): a `result`
 * message with `subtype === 'success'` does NOT guarantee `structured_output`
 * is present or well-shaped. Always safeParse it and treat absence/mismatch
 * as a hard failure — never trust prose as if it were the structured field.
 */
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";

export const REVIEWER_MODEL = process.env.REVIEWER_MODEL ?? "sonnet";

// Same bare-name shape as harness/src/telemetry.ts's SAFE_ATTR_VALUE and
// broker/src/config.ts's SAFE_TICKET — safe to embed in an
// OTEL_RESOURCE_ATTRIBUTES `k=v,k=v` string. Reimplemented locally (not
// imported — the reviewer is its own package/image, same reasoning as
// harness/src/sdk.ts's header) rather than pulled from harness/.
const SAFE_ATTR_VALUE = /^[A-Za-z0-9._-]{1,100}$/;

function sanitizeAttrValue(value: string | null | undefined): string | null {
  if (!value) return null;
  return SAFE_ATTR_VALUE.test(value) ? value : null;
}

/**
 * Self-composed OTEL_RESOURCE_ATTRIBUTES for this process's ONE session
 * type, mirroring harness/src/telemetry.ts's telemetryEnv() but local to
 * this package: `ticket` is the broker-derived value threaded through
 * ReviewerRequest (never anything the coder's own title/body carried —
 * those stay in the prompt only), `role` is always "reviewer" here.
 * `work_type` follows the same MRW_WORK_TYPE-override-with-fallback
 * contract as the harness/broker sides.
 */
export function reviewerTelemetryEnv(ticket: string | null | undefined): NodeJS.ProcessEnv {
  const workspace = sanitizeAttrValue(ticket) ?? "unlabeled";
  const workType = sanitizeAttrValue(process.env.MRW_WORK_TYPE) ?? "feature";
  return {
    ...process.env,
    OTEL_RESOURCE_ATTRIBUTES: `workspace=${workspace},work_type=${workType},role=reviewer`,
  };
}

// The diff/title/body are entirely IN-PROMPT — there is no repo mounted here
// and nothing this session should ever read or write. `tools: []` clears the
// base tool set; `disallowedTools` denies every built-in defensively on top
// of that (belt-and-suspenders — same DENY_* split reasoning as
// harness/src/sdk.ts, except here NOTHING is allowed, not even Read/Grep/
// Glob, because there is no filesystem this session is meant to see).
const NO_TOOLS: string[] = [];
const DENY_ALL_BUILTINS = [
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Read",
  "Grep",
  "Glob",
];

/** Options for the ONE session type this process ever runs. Built inline
 *  (no shared baseOptions() — there is only one caller, handler.ts). */
function buildOptions(extra: Partial<Options>): Options {
  return {
    model: REVIEWER_MODEL,
    // Inert scratch dir — no repo is ever mounted here, and this session has
    // no tools that could touch it anyway.
    cwd: "/tmp",
    // Convenience lever, NOT the containment boundary (same reasoning as
    // harness/src/sdk.ts's baseOptions()): the boundary is `tools: []` +
    // the container/caged network, not the permission prompt. Requires the
    // companion flag below in SDK 0.3.205 (sdk.d.ts:1708), or every query()
    // is rejected at runtime.
    permissionMode: "bypassPermissions",
    allowDangerouslySkipPermissions: true,
    // No project CLAUDE.md/.claude to load — there is no project mounted
    // here, and even if there were, this session must never take
    // instructions from repo-controlled settings (it already treats the
    // coder's title/body as untrusted DATA; settings would be worse).
    settingSources: [],
    tools: NO_TOOLS,
    disallowedTools: DENY_ALL_BUILTINS,
    maxTurns: 8,
    // Headless auth: the bundled CLI subprocess reads CLAUDE_CODE_OAUTH_TOKEN
    // (subscription) or ANTHROPIC_API_KEY from the inherited env.
    env: process.env as Record<string, string | undefined>,
    stderr: (d: string) => process.stderr.write(d),
    ...extra,
  };
}

/**
 * Run a query() that MUST return structured output matching `schema`.
 * `abortController` is threaded from the caller (handler.ts, itself chained
 * from server.ts's per-request budget / dropped-client signal) so a timeout
 * or a gone peer actually cancels the running session instead of merely
 * abandoning it in the background.
 */
export async function runStructuredQuery<T>(
  schema: z.ZodType<T>,
  prompt: string,
  opts: { abortController?: AbortController; env?: NodeJS.ProcessEnv } = {},
): Promise<T> {
  const q = query({
    prompt,
    options: buildOptions({
      // The one and only channel this process reads back from the model.
      outputFormat: {
        type: "json_schema",
        schema: z.toJSONSchema(schema, { target: "draft-7" }),
      },
      ...(opts.abortController ? { abortController: opts.abortController } : {}),
      // Overrides buildOptions()'s plain `env: process.env` default with the
      // caller's self-composed telemetry env (reviewerTelemetryEnv()) when
      // given — same `...extra` override contract as harness/src/sdk.ts's
      // baseOptions().
      ...(opts.env ? { env: opts.env as Record<string, string | undefined> } : {}),
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
