/**
 * test/telemetry.test.ts — telemetry.ts's ticketFromRepoDir()/telemetryEnv(),
 * exercised with NO SDK import at all (both are plain path/string functions
 * — see telemetry.ts's header on why the module is dependency-free). Run:
 * `npm test` (node:test).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as path from "node:path";
import { telemetryEnv, ticketFromRepoDir } from "../src/telemetry.js";

// --- ticketFromRepoDir ---------------------------------------------------

test("accepts a repoDir exactly at tasks/<ticket>/repositories/<repo>", () => {
  const repoDir = path.resolve("/workspace/tasks/ABC-1/repositories/app");
  assert.equal(ticketFromRepoDir(repoDir), "ABC-1");
});

test("accepts a repoDir with a deeper subpath under the repo", () => {
  const repoDir = path.resolve("/workspace/tasks/ABC-1/repositories/app/src/lib");
  assert.equal(ticketFromRepoDir(repoDir), "ABC-1");
});

test("rejects a ticket segment containing '..' (traversal)", () => {
  // A literal '..' path component never survives path.resolve() as a
  // distinct "tasks/../repositories" segment — it collapses upward — so the
  // traversal case that matters here is a ticket VALUE that itself contains
  // '..' as characters (would not match SAFE_ATTR_VALUE) or a raw path
  // whose resolution no longer has a tasks/<x>/repositories shape at all.
  const repoDir = "/workspace/tasks/../repositories/app";
  assert.equal(ticketFromRepoDir(repoDir), null);
});

test("rejects a repoDir outside the tasks/<ticket>/repositories layout", () => {
  assert.equal(ticketFromRepoDir("/workspace/repositories/app"), null);
  assert.equal(ticketFromRepoDir("/some/random/path"), null);
  assert.equal(ticketFromRepoDir(""), null);
});

test("rejects a ticket segment with unsafe characters", () => {
  const repoDir = path.resolve("/workspace/tasks/A,B/repositories/app");
  assert.equal(ticketFromRepoDir(repoDir), null);
});

// --- telemetryEnv ----------------------------------------------------------

function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  try {
    for (const [key, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("composes workspace/work_type/role exactly for a valid ticket", () => {
  withEnv({ MRW_WORK_TYPE: undefined }, () => {
    const env = telemetryEnv("ABC-1", "worker");
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, "workspace=ABC-1,work_type=feature,role=worker");
  });
});

test("falls back to 'unlabeled' for a null ticket", () => {
  withEnv({ MRW_WORK_TYPE: undefined }, () => {
    const env = telemetryEnv(null, "plan");
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, "workspace=unlabeled,work_type=feature,role=plan");
  });
});

test("falls back to 'unlabeled' when the ticket contains a comma, equals, or space", () => {
  withEnv({ MRW_WORK_TYPE: undefined }, () => {
    assert.equal(
      telemetryEnv("A,B", "review").OTEL_RESOURCE_ATTRIBUTES,
      "workspace=unlabeled,work_type=feature,role=review",
    );
    assert.equal(
      telemetryEnv("A=B", "review").OTEL_RESOURCE_ATTRIBUTES,
      "workspace=unlabeled,work_type=feature,role=review",
    );
    assert.equal(
      telemetryEnv("A B", "review").OTEL_RESOURCE_ATTRIBUTES,
      "workspace=unlabeled,work_type=feature,role=review",
    );
  });
});

test("embeds the given role verbatim", () => {
  withEnv({ MRW_WORK_TYPE: undefined }, () => {
    for (const role of ["worker", "plan", "review", "spine", "reviewer"]) {
      const env = telemetryEnv("T-1", role);
      assert.match(env.OTEL_RESOURCE_ATTRIBUTES as string, new RegExp(`role=${role}$`));
    }
  });
});

test("honors MRW_WORK_TYPE override", () => {
  withEnv({ MRW_WORK_TYPE: "bugfix" }, () => {
    const env = telemetryEnv("T-1", "worker");
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, "workspace=T-1,work_type=bugfix,role=worker");
  });
});

test("falls back to 'feature' when MRW_WORK_TYPE override is invalid", () => {
  withEnv({ MRW_WORK_TYPE: "bug fix!" }, () => {
    const env = telemetryEnv("T-1", "worker");
    assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, "workspace=T-1,work_type=feature,role=worker");
  });
});

test("preserves the rest of process.env", () => {
  withEnv({ MRW_TELEMETRY_TEST_MARKER: "present" }, () => {
    const env = telemetryEnv("T-1", "worker");
    assert.equal(env.MRW_TELEMETRY_TEST_MARKER, "present");
  });
});
