import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { ticketFromRepoDirLayout } from "../src/exec.js";
import { brokerRefusalError, buildRequest, type PublishContext } from "../src/publish.js";
import { resolveWorkspaceRoot } from "../src/multi/config.js";

const ctx: PublishContext = {
  plan: { summary: "Route publish", steps: [], risks: [], ready_to_implement: true },
  review: null,
  diff: "",
};

test("ticketFromRepoDirLayout recognizes only safe per-ticket layouts", () => {
  const root = resolveWorkspaceRoot();
  assert.equal(ticketFromRepoDirLayout(path.join(root, "tasks", "ABC-123", "repositories", "app")), "ABC-123");
  assert.equal(ticketFromRepoDirLayout(path.join(root, "repositories", "app")), null);
  assert.equal(ticketFromRepoDirLayout(path.join(root, "tasks", "ABC..123", "repositories", "app")), null);
  assert.equal(ticketFromRepoDirLayout(path.join(root, "tasks", "ABC-123", "repositories", "bad..repo")), null);
  assert.equal(ticketFromRepoDirLayout(path.join(root, "tasks", "ABC-123", "repositories", "app", "extra")), null);
  assert.equal(ticketFromRepoDirLayout(path.join(root, "tasks", "ABC-123", "repositories", "..", "outside")), null);
});

test("buildRequest carries a layout ticket and otherwise preserves the legacy shape", () => {
  const root = resolveWorkspaceRoot();
  const routed = buildRequest(ctx, path.join(root, "tasks", "ABC-123", "repositories", "app"));
  assert.equal(routed.ticket, "ABC-123");
  const legacy = buildRequest(ctx, path.join(root, "repositories", "app"));
  assert.equal("ticket" in legacy, false);
});

test("invalid_request on a ticket-carrying request surfaces the broker rebuild diagnostic", () => {
  const error = brokerRefusalError(
    { repo: "app", branch: "feat/ABC-123", title: "x", body: "x", ticket: "ABC-123" },
    { ok: false, code: "invalid_request", error: "unknown key: ticket" },
  );
  assert.match(error.message, /broker image predates ticket routing/);
  assert.match(error.message, /mrw infra-up --build/);
  assert.match(error.message, /unknown key: ticket/);

  const legacy = brokerRefusalError(
    { repo: "app", branch: "main", title: "x", body: "x" },
    { ok: false, code: "invalid_request", error: "bad title" },
  );
  assert.equal(legacy.message, "[publish] broker refused (invalid_request): bad title");
});
