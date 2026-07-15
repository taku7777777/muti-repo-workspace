/**
 * reviewer.ts — the broker's OPTIONAL, OUTBOUND consult of the M3 advisory
 * reviewer (see docs/agent-orchestration.md "Broker-side reviewer" and the
 * plan's M3 section). This is the ONE typed socket call the broker makes
 * that isn't git/gh: diff in, verdict out, with a timeout.
 *
 * The broker STAYS LLM-free: this file contains no model call, only a
 * socket client for a verdict rendered by a SEPARATE process/image
 * (reviewer/, its own container). ANY failure path — REVIEWER_SOCKET unset,
 * a diff-file write failure, a connect failure, a timeout, an `ok:false`
 * response, or a malformed response — is caught HERE, logged as one
 * `[broker] reviewer: ...` line, and turned into the sentinel "unavailable".
 * This function NEVER throws: handler.ts calls it unconditionally between
 * rendering ground truth and the human gate, and a thrown exception here
 * would otherwise abort a publish that has nothing to do with the
 * reviewer's availability.
 *
 * TRI-STATE return (verifier fix over the first draft): `null` means the
 * feature is OFF (REVIEWER_SOCKET unset — the operator's deliberate choice;
 * approve.ts renders NOTHING, keeping the pre-M3 header byte-identical),
 * while "unavailable" means the feature was ON but the consult failed —
 * approve.ts renders an explicit "no verdict" line so a human never
 * mistakes an outage for an approval. Collapsing both to null would either
 * spam the off-mode header or hide on-mode failures; the sentinel keeps the
 * two honest.
 *
 * The verdict is ADVISORY ONLY (approve.ts renders it, including an
 * explicit "no verdict" line) — it never changes the sha-typed human gate's
 * semantics or the push path in handler.ts/git.ts.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { z } from "zod";

export interface ReviewerVerdict {
  verdict: "approve" | "concerns";
  notes: string;
}

// Mirrors reviewer/src/types.ts's ReviewerResponse shape. Kept as a local
// zod schema (not imported — the reviewer is a separate package/image, same
// reasoning as harness/broker not sharing source) so a malformed or
// unexpected reply from the reviewer is validated, not blindly cast.
const ReviewerWireResponseSchema = z.union([
  z.object({ ok: z.literal(true), verdict: z.enum(["approve", "concerns"]), notes: z.string() }),
  z.object({ ok: z.literal(false), code: z.string(), error: z.string() }),
]);

// Small diffs go inline and skip the file round-trip entirely; larger ones
// are written to REVIEWER_DIFF_DIR and referenced by path (well under
// reviewer/src/types.ts's diffInline cap of 256 KiB, leaving headroom for
// JSON/UTF-8 overhead).
const INLINE_THRESHOLD_BYTES = 64 * 1024;

const REVIEWER_TIMEOUT_MS = (() => {
  const raw = process.env.REVIEWER_TIMEOUT_MS;
  const n = Number(raw);
  return raw !== undefined && Number.isFinite(n) && n >= 0 ? n : 120 * 1000;
})();

function reviewerDiffDir(): string {
  return path.resolve(process.env.REVIEWER_DIFF_DIR ?? "/var/mrw/review-diffs");
}

/** Send one newline-terminated JSON request, read one newline-terminated
 *  JSON response, racing `signal` (the handler's abort — approval-budget
 *  expiry or a dropped publish client). Rejects on any transport failure or
 *  abort; the caller (maybeConsultReviewer) converts every rejection to
 *  `null` and never lets it propagate further. Shape mirrors
 *  harness/src/publish.ts's sendToBroker(), reimplemented here (broker
 *  style, no shared import) plus the abort race. */
function sendToReviewer(
  socketPath: string,
  req: unknown,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted before connecting"));
      return;
    }

    let settled = false;
    const sock = net.createConnection({ path: socketPath });

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      sock.destroy();
      fn();
    };

    const onAbort = () => finish(() => reject(new Error("aborted")));
    signal.addEventListener("abort", onAbort);

    let buf = "";
    sock.setEncoding("utf8");
    sock.setTimeout(timeoutMs, () =>
      finish(() => reject(new Error("reviewer did not respond before timeout"))),
    );
    sock.on("connect", () => sock.write(JSON.stringify(req) + "\n"));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      try {
        const parsed = JSON.parse(line);
        finish(() => resolve(parsed));
      } catch (e) {
        finish(() => reject(new Error(`malformed reviewer response: ${(e as Error).message}`)));
      }
    });
    sock.on("error", (err) => finish(() => reject(err)));
    sock.on("end", () => {
      if (!settled) finish(() => reject(new Error("reviewer closed the connection without a response")));
    });
  });
}

/**
 * Consult the advisory reviewer for ONE publish request. `diff` is the
 * broker-rendered GROUND TRUTH (render.diff from renderGroundTruth() —
 * never anything coder-supplied); `title`/`body` are the coder's own text,
 * forwarded so the reviewer can label them UNTRUSTED in its own prompt.
 *
 * Returns a verdict or `null`; NEVER throws. `signal` is the SAME
 * AbortSignal the handler's human gate races (approval-budget expiry / a
 * dropped publish client) — if it fires mid-consult, this call gives up and
 * returns `null` rather than delaying or blocking the rest of the publish
 * flow.
 */
export async function maybeConsultReviewer(
  diff: string,
  title: string,
  body: string,
  signal?: AbortSignal,
): Promise<ReviewerVerdict | "unavailable" | null> {
  const socketPath = process.env.REVIEWER_SOCKET;
  if (!socketPath) return null; // feature OFF — unset on the host by default

  const sig = signal ?? new AbortController().signal;
  const diffBytes = Buffer.byteLength(diff, "utf8");
  let diffFile: string | null = null;

  try {
    let req: unknown;
    if (diffBytes <= INLINE_THRESHOLD_BYTES) {
      req = { diffInline: diff, title, untrustedBody: body };
    } else {
      const dir = reviewerDiffDir();
      diffFile = path.join(dir, `${crypto.randomUUID()}.diff`);
      fs.writeFileSync(diffFile, diff, "utf8");
      req = { diffPath: diffFile, title, untrustedBody: body };
    }

    const raw = await sendToReviewer(socketPath, req, REVIEWER_TIMEOUT_MS, sig);
    const parsed = ReviewerWireResponseSchema.safeParse(raw);
    if (!parsed.success) {
      console.log(`[broker] reviewer: malformed response — treating as no verdict: ${parsed.error.message}`);
      return "unavailable";
    }
    if (!parsed.data.ok) {
      console.log(`[broker] reviewer: refused (${parsed.data.code}): ${parsed.data.error} — treating as no verdict`);
      return "unavailable";
    }
    return { verdict: parsed.data.verdict, notes: parsed.data.notes };
  } catch (e) {
    console.log(`[broker] reviewer: consult failed — treating as no verdict: ${(e as Error).message}`);
    return "unavailable";
  } finally {
    if (diffFile) {
      try {
        fs.unlinkSync(diffFile);
      } catch {
        /* best effort */
      }
    }
  }
}
