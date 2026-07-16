/**
 * test/spined-wire.test.ts — spined/index.ts's adaptExtra()/registerTools()
 * WIRE GLUE (independent review, SHOULD-FIX #3b), exercised against a REAL
 * @modelcontextprotocol/sdk McpServer + Client pair connected via
 * InMemoryTransport.createLinkedPair() — no stdio, no subprocess, but a
 * genuine client/server JSON-RPC round trip in-process. This is the layer
 * spined-tools.test.ts (which calls tool.handler() directly with a hand-built
 * SpinedToolExtra) does NOT cover: whether a real MCP client's `onprogress`
 * option actually causes `_meta.progressToken` to land on the request, and
 * whether our registerTool() wiring actually turns that into a delivered
 * `notifications/progress` — plus that the keep-alive timer is cleaned up
 * once the real call completes. Run: `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { adaptExtra, registerTools } from "../src/spined/index.js";
import { buildActionTools } from "../src/spined/tools.js";
import type { Executor } from "../src/spine/executor.js";
import type { ActionResult } from "../src/spine/actions.js";

function delayedExecutor(delayMs: number, result: ActionResult): Executor {
  return {
    dispatch: () => new Promise((resolve) => setTimeout(() => resolve(result), delayMs)),
    isEnded: () => false,
    endedInfo: () => null,
  };
}

// Tools MUST be registered BEFORE server.connect() — the SDK locks further
// capability registration once a transport is attached ("Cannot register
// capabilities after connecting to transport"), so `register` runs first.
async function connectedPair(register: (server: McpServer) => void): Promise<{ server: McpServer; client: Client }> {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const server = new McpServer({ name: "spine-test", version: "0.0.0" });
  register(server);
  const client = new Client({ name: "spine-test-client", version: "0.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return { server, client };
}

function textOf(result: { content?: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0].text);
}

// --- end-to-end: real client onprogress -> real _meta.progressToken -> real notification ---

test("a client-supplied onprogress causes real notifications/progress to arrive, then stops after completion", async () => {
  const executor = delayedExecutor(40, { ok: true, committed: false, headSha: "deadbeef" });
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 10 });
  const { server, client } = await connectedPair((s) => registerTools(s, tools));

  const events: Array<{ progress: number; total?: number; message?: string }> = [];
  const result = await client.callTool(
    { name: "run_worker", arguments: { repo: "app", instruction: "do it" } },
    undefined,
    { onprogress: (p) => events.push(p) },
  );

  assert.ok(events.length >= 1, `expected at least one real progress notification, got ${events.length}`);
  for (const e of events) {
    assert.match(String(e.message), /run_worker running — [\d.]+s elapsed/);
  }
  assert.deepEqual(textOf(result), { ok: true, committed: false, headSha: "deadbeef" });

  // Keep-alive timer cleanup: no further notifications arrive after the
  // dispatch (and the whole request) has already resolved.
  const countAtFinish = events.length;
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(events.length, countAtFinish, "a progress notification arrived after the request already completed");

  await client.close();
  await server.close();
});

test("without onprogress, the client never receives progress notifications and the call still succeeds", async () => {
  const executor = delayedExecutor(15, { ok: true, pass: true, status: 0, output: "all green" });
  const tools = buildActionTools(executor, { keepAliveIntervalMs: 5 });
  const { server, client } = await connectedPair((s) => registerTools(s, tools));

  // No onprogress option => the SDK never generates/attaches a
  // _meta.progressToken at all — adaptExtra()'s progressToken ends up
  // undefined, and withKeepAliveProgress() (tools.ts) never starts a timer.
  const result = await client.callTool({ name: "run_tests", arguments: { repo: "app" } });
  assert.deepEqual(textOf(result), { ok: true, pass: true, status: 0, output: "all green" });

  await client.close();
  await server.close();
});

test("status (the zero-arg tool) round-trips over the real wire", async () => {
  const executor: Executor = {
    dispatch: async () => {
      throw new Error("status must never call dispatch()");
    },
    isEnded: () => false,
    endedInfo: () => null,
  };
  // buildStatusTool needs a real-ish ledger; a minimal SpineLedger suffices.
  const { SpineLedger } = await import("../src/spine/ledger.js");
  const { buildStatusTool } = await import("../src/spined/tools.js");
  const ledger = new SpineLedger("T-1", { app: { repoDir: "/tmp/app", baseSha: "base000" } });
  const { server, client } = await connectedPair((s) => registerTools(s, [buildStatusTool(ledger, executor)]));

  const result = await client.callTool({ name: "status", arguments: {} });
  const parsed = textOf(result) as { ok: boolean; ticket: string };
  assert.equal(parsed.ok, true);
  assert.equal(parsed.ticket, "T-1");

  await client.close();
  await server.close();
});

// --- adaptExtra() as a small pure-adapter unit, isolated from any transport ---

function fakeRequestHandlerExtra(
  progressToken: string | number | undefined,
  onSend: (n: unknown) => void,
): RequestHandlerExtra<ServerRequest, ServerNotification> {
  return {
    signal: new AbortController().signal,
    requestId: 1,
    _meta: progressToken === undefined ? undefined : { progressToken },
    sendNotification: async (n: unknown) => {
      onSend(n);
    },
    sendRequest: async () => {
      throw new Error("not used by these tests");
    },
  } as unknown as RequestHandlerExtra<ServerRequest, ServerNotification>;
}

test("adaptExtra() plumbs _meta.progressToken through to SpinedToolExtra.progressToken", () => {
  const adapted = adaptExtra(fakeRequestHandlerExtra("tok-xyz", () => {}));
  assert.equal(adapted.progressToken, "tok-xyz");
});

test("adaptExtra() yields progressToken=undefined when _meta is absent", () => {
  const adapted = adaptExtra(fakeRequestHandlerExtra(undefined, () => {}));
  assert.equal(adapted.progressToken, undefined);
});

test("adaptExtra().sendNotification forwards the exact notification object to the real extra.sendNotification", async () => {
  const received: unknown[] = [];
  const adapted = adaptExtra(fakeRequestHandlerExtra("tok-1", (n) => received.push(n)));
  const notification = { method: "notifications/progress" as const, params: { progressToken: "tok-1", progress: 5 } };
  await adapted.sendNotification(notification);
  assert.deepEqual(received, [notification]);
});
