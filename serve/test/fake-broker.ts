/**
 * fake-broker.ts — a REAL unix-socket stub standing in for the broker's
 * approval-server (§1 framing: one newline-terminated JSON request per
 * connection, one newline-terminated JSON response, then close). Used by
 * broker-client.test.ts and api-state.test.ts so those tests exercise
 * BrokerClient/routes.ts against actual socket I/O rather than a mocked
 * transport.
 *
 * NOT a *.test.ts file itself — `node --import tsx --test test/*.test.ts`
 * only picks up files matching that glob, so this helper is safe to import
 * without being run as its own (empty) test suite.
 */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

export type FakeBrokerHandler = (req: unknown) => unknown | Promise<unknown>;

export interface FakeBroker {
  socketPath: string;
  server: net.Server;
  requests: unknown[];
  close(): Promise<void>;
}

export async function startFakeBroker(handler: FakeBrokerHandler): Promise<FakeBroker> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mrw-serve-test-"));
  const socketPath = path.join(dir, "approve.sock");
  const requests: unknown[] = [];

  const server = net.createServer((sock) => {
    let buf = "";
    let dispatched = false;
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      if (dispatched) return;
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl < 0) return;
      dispatched = true;
      const line = buf.slice(0, nl);
      void (async () => {
        let req: unknown;
        try {
          req = JSON.parse(line);
        } catch (e) {
          sock.end(JSON.stringify({ ok: false, code: "invalid_request", error: `bad json: ${(e as Error).message}` }) + "\n");
          return;
        }
        requests.push(req);
        try {
          const res = await handler(req);
          sock.end(JSON.stringify(res) + "\n");
        } catch (e) {
          sock.end(JSON.stringify({ ok: false, code: "invalid_request", error: String(e) }) + "\n");
        }
      })();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    server,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          try {
            fs.rmSync(dir, { recursive: true, force: true });
          } catch {
            /* best effort */
          }
          resolve();
        });
      }),
  };
}

/** A minimal, valid ViewWire — tests override individual fields as needed. */
export function fakeView(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repo: "demo-repo",
    branch: "feat/DEMO-1",
    headSha: "a".repeat(40),
    title: "Add the demo feature",
    body: "This PR adds a demo.",
    host: "github.com",
    org: "acme",
    targetRepo: "demo-repo",
    url: "https://github.com/acme/demo-repo",
    commitCount: 1,
    commitList: `${"a".repeat(7)} Add the demo feature`,
    diffStat: " 1 file changed, 1 insertion(+)",
    diff: [
      "diff --git a/README.md b/README.md",
      "index 1111111..2222222 100644",
      "--- a/README.md",
      "+++ b/README.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    reviewerVerdict: null,
    // Explicit (not relying on the schema's default) so deep-equality
    // assertions against parsed views stay byte-for-byte predictable.
    testCaveat: false,
    shortSha: "a".repeat(12),
    ticket: "DEMO-1",
    ...overrides,
  };
}

export function fakePending(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "f".repeat(32),
    startedAt: Date.now(),
    attemptsLeft: 3,
    view: fakeView(),
    ...overrides,
  };
}
