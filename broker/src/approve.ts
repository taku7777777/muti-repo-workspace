/**
 * approve.ts — the AUTHORITATIVE human gate, at the broker, OUTSIDE the container.
 *
 * The coder never reaches this prompt. The human sees the ground-truth summary the
 * broker rendered from git objects (never the coder's words), INCLUDING the
 * resolved push target (host / org / repo / URL) and the exact sha that will be
 * pushed (F4), and confirms on the broker's own stdin.
 *
 * Two properties matter here:
 *  - NO SILENT TRUNCATION. The full diff is paged to the human (the earlier draft
 *    capped it at 200 lines — a malicious change past line 200 would be approved
 *    unseen). The human pages through all of it, or explicitly stops.
 *  - APPROVAL IS SHA-BOUND. Confirming requires TYPING the exact short sha the
 *    broker rendered (not a reflexive 'y'), so approval is bound to the specific
 *    object the human saw and about to be pushed.
 *
 * The gate is CANCELLABLE (F5): an AbortSignal (from the approval budget or a
 * dropped client) rejects the prompt, so the handler returns fail-closed and never
 * proceeds to push.
 *
 * Thread C / Phase C2 (docs/mrw-chat.md "Gate policy"): the header also
 * renders a broker-computed test-independence caveat (caveat.ts) next to the
 * M3 advisory-reviewer line, ADVISORY ONLY like that line — it never gates
 * the sha-typed confirmation below. This is the one place that caveat used
 * to render for the spined path too (the in-container y/N ack), before
 * approvalPolicy 'broker-only' removed that in-chat prompt.
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ReviewerVerdict } from "./reviewer.js";

export interface ApprovalView {
  repo: string; // the worktree directory name (request.repo)
  ticket: string | null; // registered request ticket; null for legacy routing
  branch: string;
  headSha: string;
  title: string;
  body: string;
  // Resolved push target (F4) — rebuilt from validated components, not the raw origin.
  host: string;
  org: string;
  targetRepo: string;
  url: string;
  commitCount: number;
  commitList: string;
  diffStat: string;
  diff: string;
  // M3: the OPTIONAL advisory reviewer's verdict, or null when the feature is
  // off / the consult failed / timed out / came back malformed (see
  // broker/src/reviewer.ts — maybeConsultReviewer() collapses every failure
  // mode to "unavailable", never a throw). ADVISORY ONLY: this field is
  // rendered for the human below but never changes the sha-typed gate's
  // semantics. TRI-STATE: null = feature OFF (render nothing — the pre-M3
  // header stays byte-identical); "unavailable" = feature ON but the consult
  // failed (render an explicit no-verdict line so an outage is never
  // mistaken for an approval); a verdict = render it.
  reviewerVerdict: ReviewerVerdict | "unavailable" | null;
  // Thread C / Phase C2 (docs/mrw-chat.md "Gate policy", "Deliberate engine
  // adaptations" #4): true when caveat.ts's diffTouchesTests() matches this
  // SAME ground-truth `diff` — i.e. the change touches test files/config, so
  // the green test gate may not be independent of the coder's edits. Always
  // a plain boolean (not tri-state like reviewerVerdict — there is no
  // "feature off" state; this is a pure function of the diff, always
  // computed). Advisory only, exactly like reviewerVerdict: rendered next to
  // it, never changes the sha-typed gate below.
  testCaveat: boolean;
}

const PAGE_LINES = 400;

// Cap so a malicious or merely verbose reviewer note cannot bury the header
// under itself. Newlines are folded to " / " first so multi-line notes still
// render on ONE line — the whole point of this line is to be impossible to
// miss above the diff.
const MAX_NOTES_CHARS = 500;

function foldNotes(notes: string, max = MAX_NOTES_CHARS): string {
  // Strip stray model-output tag fragments (</invoke>, </summary>, ...) — the
  // known cosmetic issue recorded in devcontainer-status.md ("REVIEW step's
  // structured summary occasionally carries trailing tag fragments") shows up
  // in reviewer notes too. This line must stay legible above the diff.
  const cleaned = notes.replace(/<\/?(invoke|summary|parameter|antml[^>]*)>/g, " ");
  const folded = cleaned.replace(/\r\n|\r|\n/g, " / ").trim();
  if (folded.length <= max) return folded;
  return folded.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

/** The summary shown before the diff — everything except the (paged) diff
 *  body. Exported (independent review, SHOULD-FIX #3a) so the caveat/
 *  reviewer-verdict rendering is directly unit-testable without driving the
 *  real readline-backed approveAtBroker() (which needs live stdin — see
 *  gate.test.ts's header on why this codebase deliberately never does
 *  that). renderHeader() is a PURE string formatter — it takes no signal,
 *  resolves no promise, and is never awaited — so testing it directly also
 *  demonstrates structurally that testCaveat/reviewerVerdict can only ever
 *  change what is RENDERED here, never the sha-typed confirmation below
 *  (approveAtBroker's `answer.trim() === short` gate), which this function
 *  has no way to reach or influence. */
export function renderHeader(v: ApprovalView): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("================ PUBLISH REQUEST (ground truth from git) ================");
  lines.push(`worktree:  ${v.repo}`);
  if (v.ticket) lines.push(`ticket:  ${v.ticket}`);
  lines.push(`branch:    ${v.branch}`);
  lines.push(`sha:       ${v.headSha}`);
  lines.push("");
  lines.push("push target (constructed + allowlist-validated by the broker):");
  lines.push(`  host:    ${v.host}`);
  lines.push(`  org:     ${v.org}`);
  lines.push(`  repo:    ${v.targetRepo}`);
  lines.push(`  url:     ${v.url}`);
  lines.push(`  will push: ${v.headSha} -> refs/heads/${v.branch}`);
  lines.push("");
  lines.push(`title:   ${v.title}`);
  lines.push(`commits to publish: ${v.commitCount}`);
  if (v.commitList) lines.push(v.commitList);
  lines.push("");
  lines.push("PR body (as sent by the coder — inspect it, it goes into a public PR):");
  lines.push(v.body.trim().length ? v.body.trim() : "(empty)");
  lines.push("");
  if (v.diffStat) {
    lines.push("diffstat:");
    lines.push(v.diffStat);
    lines.push("");
  }
  // M3 advisory reviewer verdict — FAIL-VISIBLE by construction: every path
  // With the feature ON, a failed consult renders an EXPLICIT no-verdict
  // line rather than silently omitting one, so a human never mistakes
  // "reviewer said nothing" for "reviewer said approve". With the feature
  // OFF (null), nothing is rendered at all — the operator turned it off,
  // and the pre-M3 header stays byte-identical. Advisory only: this line
  // never gates anything below it — the sha-typed prompt is unchanged.
  if (v.reviewerVerdict === "unavailable") {
    lines.push("advisory reviewer: no verdict (reviewer failed/timed out — decide from the diff alone)");
    lines.push("");
  } else if (v.reviewerVerdict) {
    const notes = foldNotes(v.reviewerVerdict.notes);
    lines.push(
      v.reviewerVerdict.verdict === "approve"
        ? `advisory reviewer: approve — ${notes}`
        : `advisory reviewer: CONCERNS — ${notes}`,
    );
    lines.push("");
  }
  // Broker-computed test-independence caveat (Thread C, caveat.ts) — next to
  // the reviewer line above, same advisory posture: rendered, never gates.
  if (v.testCaveat) {
    lines.push("caveat: diff touches test files/config — the green-tests gate may not be independent");
    lines.push("");
  }
  lines.push("========================================================================");
  return lines.join("\n");
}

function ask(
  rl: readline.Interface,
  q: string,
  signal?: AbortSignal,
): Promise<string> {
  return signal ? rl.question(q, { signal }) : rl.question(q);
}

/**
 * Approves only when the human TYPES the exact short sha, after paging the FULL
 * diff. Rejects (throws) if `signal` aborts at any prompt.
 */
export async function approveAtBroker(v: ApprovalView, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) throw new Error("approval aborted before prompt");
  output.write(renderHeader(v) + "\n");
  const rl = readline.createInterface({ input, output });
  try {
    const diffLines = v.diff.split("\n");
    let viewedAll = true;

    if (diffLines.length <= PAGE_LINES) {
      output.write("\ndiff (full — this is exactly what will be pushed):\n");
      output.write(v.diff + "\n");
    } else {
      output.write(
        `\ndiff is ${diffLines.length} lines — paging ${PAGE_LINES} at a time ` +
          "(this is exactly what will be pushed):\n\n",
      );
      for (let i = 0; i < diffLines.length; i += PAGE_LINES) {
        output.write(diffLines.slice(i, i + PAGE_LINES).join("\n") + "\n");
        const shown = Math.min(i + PAGE_LINES, diffLines.length);
        if (shown < diffLines.length) {
          const a = await ask(
            rl,
            `-- ${shown}/${diffLines.length} lines shown; Enter = more, q = stop paging -- `,
            signal,
          );
          if (/^q/i.test(a.trim())) {
            viewedAll = false;
            break;
          }
        }
      }
    }

    // Sha-bound confirmation. Typing 'y' is deliberately NOT enough.
    const short = v.headSha.slice(0, 12);
    const caveat = viewedAll ? "" : " (you stopped paging BEFORE the end of the diff)";
    const answer = await ask(
      rl,
      `\nTo APPROVE publishing ${v.org}/${v.targetRepo}@${v.branch}${caveat},\n` +
        `type the commit sha exactly: '${short}'  (anything else declines): `,
      signal,
    );
    return answer.trim() === short;
  } finally {
    rl.close();
  }
}
