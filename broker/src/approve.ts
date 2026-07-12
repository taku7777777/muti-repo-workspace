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
 */
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface ApprovalView {
  repo: string; // the worktree directory name (request.repo)
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
}

const PAGE_LINES = 400;

/** The summary shown before the diff — everything except the (paged) diff body. */
function renderHeader(v: ApprovalView): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("================ PUBLISH REQUEST (ground truth from git) ================");
  lines.push(`worktree:  ${v.repo}`);
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
