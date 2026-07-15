/**
 * test/actions.test.ts — spine/actions.ts schema accept/reject, exercised
 * with NO SDK import (the exported Args are plain zod objects wrapping the
 * raw shapes tool() consumes — see actions.ts's header). Run: `npm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AbortArgs,
  AskHumanArgs,
  DoneArgs,
  PlanRepoArgs,
  RequestPublishArgs,
  ReviewDiffArgs,
  RunTestsArgs,
  RunWorkerArgs,
  ShowHumanArgs,
} from "../src/spine/actions.js";

// --- repo name (REPO) ---------------------------------------------------------

test("RunWorkerArgs accepts a plain repo name and instruction", () => {
  const parsed = RunWorkerArgs.safeParse({ repo: "my-repo_1.2", instruction: "add a flag" });
  assert.equal(parsed.success, true);
});

test("repo-carrying actions reject a path-shaped repo (slash)", () => {
  for (const schema of [RunWorkerArgs, RunTestsArgs, ReviewDiffArgs, PlanRepoArgs, RequestPublishArgs]) {
    const parsed = schema.safeParse({ repo: "a/b", instruction: "x" });
    assert.equal(parsed.success, false, `expected '${schema}' to reject a slash-containing repo name`);
  }
});

test("repo-carrying actions reject '..' traversal", () => {
  const parsed = RunTestsArgs.safeParse({ repo: ".." });
  assert.equal(parsed.success, false);
});

test("repo-carrying actions reject a repo name containing '..'", () => {
  const parsed = RunTestsArgs.safeParse({ repo: "a..b" });
  assert.equal(parsed.success, false);
});

test("repo-carrying actions reject an empty repo name", () => {
  const parsed = RunTestsArgs.safeParse({ repo: "" });
  assert.equal(parsed.success, false);
});

test("repo-carrying actions reject an oversize repo name (>200 chars)", () => {
  const parsed = RunTestsArgs.safeParse({ repo: "a".repeat(201) });
  assert.equal(parsed.success, false);
});

test("repo-carrying actions reject characters outside [A-Za-z0-9._-]", () => {
  for (const bad of ["repo name", "repo;rm -rf", "repo$(whoami)", "répo"]) {
    const parsed = RunTestsArgs.safeParse({ repo: bad });
    assert.equal(parsed.success, false, `expected '${bad}' to be rejected`);
  }
});

// --- free-text fields: required + bounded -------------------------------------

test("run_worker rejects a missing instruction", () => {
  const parsed = RunWorkerArgs.safeParse({ repo: "app" });
  assert.equal(parsed.success, false);
});

test("run_worker rejects an empty instruction", () => {
  const parsed = RunWorkerArgs.safeParse({ repo: "app", instruction: "" });
  assert.equal(parsed.success, false);
});

test("run_worker rejects an oversize instruction (>64KiB)", () => {
  const parsed = RunWorkerArgs.safeParse({ repo: "app", instruction: "x".repeat(64 * 1024 + 1) });
  assert.equal(parsed.success, false);
});

test("run_worker accepts an instruction right at the 64KiB bound", () => {
  const parsed = RunWorkerArgs.safeParse({ repo: "app", instruction: "x".repeat(64 * 1024) });
  assert.equal(parsed.success, true);
});

test("ask_human rejects an oversize question (>4KiB)", () => {
  const parsed = AskHumanArgs.safeParse({ question: "x".repeat(4 * 1024 + 1) });
  assert.equal(parsed.success, false);
});

test("ask_human accepts a normal question", () => {
  const parsed = AskHumanArgs.safeParse({ question: "should I proceed?" });
  assert.equal(parsed.success, true);
});

test("show_human rejects an oversize content field (>20KiB)", () => {
  const parsed = ShowHumanArgs.safeParse({ content: "x".repeat(20 * 1024 + 1) });
  assert.equal(parsed.success, false);
});

test("done rejects an empty summary", () => {
  const parsed = DoneArgs.safeParse({ summary: "" });
  assert.equal(parsed.success, false);
});

test("done accepts a normal summary", () => {
  const parsed = DoneArgs.safeParse({ summary: "shipped app and knowledge" });
  assert.equal(parsed.success, true);
});

test("abort rejects a missing reason", () => {
  const parsed = AbortArgs.safeParse({});
  assert.equal(parsed.success, false);
});

test("abort accepts a normal reason", () => {
  const parsed = AbortArgs.safeParse({ reason: "budget exhausted" });
  assert.equal(parsed.success, true);
});

// --- repo-only actions ignore unrelated fields correctly ----------------------

test("run_tests/review_diff/plan_repo/request_publish accept just {repo}", () => {
  for (const schema of [RunTestsArgs, ReviewDiffArgs, PlanRepoArgs, RequestPublishArgs]) {
    const parsed = schema.safeParse({ repo: "app" });
    assert.equal(parsed.success, true);
  }
});
