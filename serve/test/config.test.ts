/**
 * config.test.ts — §3.1 env contract (fail-closed) and §3.5 serve.json
 * loader (never fatal; bad values warn + default at the smallest possible
 * granularity).
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { customCssPath, DEFAULT_SERVE_CONFIG, loadEnv, loadServeConfig } from "../src/config.js";

const VALID_TOKEN = "a".repeat(32);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mrw-serve-config-test-"));
}

// --- §3.1 env contract ---------------------------------------------------

test("loadEnv: happy path with all fields set", () => {
  const env = loadEnv({
    SERVE_APPROVAL_SOCKET: "/tmp/approve.sock",
    SERVE_SESSION_TOKEN: VALID_TOKEN,
    SERVE_PORT: "9999",
    SERVE_BIND: "0.0.0.0",
    SERVE_CONFIG_DIR: "/etc/mrw-serve",
  } as NodeJS.ProcessEnv);
  assert.equal(env.approvalSocket, "/tmp/approve.sock");
  assert.equal(env.sessionToken, VALID_TOKEN);
  assert.equal(env.port, 9999);
  assert.equal(env.bind, "0.0.0.0");
  assert.equal(env.configDir, "/etc/mrw-serve");
});

test("loadEnv: defaults for port/bind/configDir when unset", () => {
  const env = loadEnv({
    SERVE_APPROVAL_SOCKET: "/tmp/approve.sock",
    SERVE_SESSION_TOKEN: VALID_TOKEN,
  } as NodeJS.ProcessEnv);
  assert.equal(env.port, 7787);
  assert.equal(env.bind, "127.0.0.1");
  assert.equal(env.configDir, null);
});

test("loadEnv: fail-closed when SERVE_SESSION_TOKEN is missing", () => {
  assert.throws(() => loadEnv({ SERVE_APPROVAL_SOCKET: "/tmp/approve.sock" } as NodeJS.ProcessEnv), /SERVE_SESSION_TOKEN/);
});

test("loadEnv: fail-closed when SERVE_SESSION_TOKEN is shorter than 32 chars", () => {
  assert.throws(
    () =>
      loadEnv({
        SERVE_APPROVAL_SOCKET: "/tmp/approve.sock",
        SERVE_SESSION_TOKEN: "short",
      } as NodeJS.ProcessEnv),
    /SERVE_SESSION_TOKEN/,
  );
});

test("loadEnv: fail-closed when SERVE_APPROVAL_SOCKET is missing", () => {
  assert.throws(() => loadEnv({ SERVE_SESSION_TOKEN: VALID_TOKEN } as NodeJS.ProcessEnv), /SERVE_APPROVAL_SOCKET/);
});

test("loadEnv: invalid SERVE_PORT warns and falls back to the default rather than throwing", () => {
  const env = loadEnv({
    SERVE_APPROVAL_SOCKET: "/tmp/approve.sock",
    SERVE_SESSION_TOKEN: VALID_TOKEN,
    SERVE_PORT: "not-a-number",
  } as NodeJS.ProcessEnv);
  assert.equal(env.port, 7787);
});

// --- §3.5 serve.json loader -----------------------------------------------

test("loadServeConfig: no configDir returns built-in defaults", () => {
  const cfg = loadServeConfig(null, () => {});
  assert.deepEqual(cfg, DEFAULT_SERVE_CONFIG);
});

test("loadServeConfig: no serve.json file present returns defaults, no warning", () => {
  const dir = tmpDir();
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.deepEqual(cfg, DEFAULT_SERVE_CONFIG);
  assert.equal(warnings.length, 0);
});

test("loadServeConfig: malformed JSON degrades to defaults with a warning, never throws", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), "{ not json", "utf8");
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.deepEqual(cfg, DEFAULT_SERVE_CONFIG);
  assert.ok(warnings.length >= 1);
});

test("loadServeConfig: non-object JSON (array) degrades to defaults with a warning", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), "[1,2,3]", "utf8");
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.deepEqual(cfg, DEFAULT_SERVE_CONFIG);
  assert.ok(warnings.length >= 1);
});

test("loadServeConfig: valid full config is honored exactly", () => {
  const dir = tmpDir();
  const full = {
    theme: "dark",
    title: "custom title",
    accentColor: "#ff0000",
    pollIntervalMs: 5000,
    diff: { view: "split", wrap: true, tabSize: 4, collapseThresholdLines: 200, intralineHighlight: false },
    sections: { body: false, commits: true, reviewer: false, fileTree: true },
    customCss: false,
  };
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify(full), "utf8");
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.deepEqual(cfg, full);
  assert.equal(warnings.length, 0);
});

test("loadServeConfig: one invalid top-level field falls back ALONE — siblings keep their configured values", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "serve.json"),
    JSON.stringify({ theme: "not-a-theme", title: "kept title", pollIntervalMs: 9999 }),
    "utf8",
  );
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.equal(cfg.theme, DEFAULT_SERVE_CONFIG.theme); // fell back
  assert.equal(cfg.title, "kept title"); // untouched
  assert.equal(cfg.pollIntervalMs, 9999); // untouched
  assert.ok(warnings.some((w) => w.includes("theme")));
});

test("loadServeConfig: unknown top-level key warns and is ignored, valid keys still applied", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify({ title: "ok", somethingWeird: 123 }), "utf8");
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.equal(cfg.title, "ok");
  assert.ok(warnings.some((w) => w.includes("somethingWeird")));
});

test("loadServeConfig: 'port' key is accepted without an unknown-key warning (CLI-only field)", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify({ port: 8080 }), "utf8");
  const warnings: string[] = [];
  loadServeConfig(dir, (m) => warnings.push(m));
  assert.ok(!warnings.some((w) => w.includes("port")));
});

test("loadServeConfig: invalid nested diff field falls back alone, sibling diff fields kept", () => {
  const dir = tmpDir();
  fs.writeFileSync(
    path.join(dir, "serve.json"),
    JSON.stringify({ diff: { view: "sideways", tabSize: 2 } }),
    "utf8",
  );
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.equal(cfg.diff.view, DEFAULT_SERVE_CONFIG.diff.view); // fell back
  assert.equal(cfg.diff.tabSize, 2); // kept
  assert.ok(warnings.some((w) => w.includes("diff.view")));
});

test("loadServeConfig: 'diff' as a non-object falls back for the WHOLE section only", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify({ diff: "nope", title: "kept" }), "utf8");
  const warnings: string[] = [];
  const cfg = loadServeConfig(dir, (m) => warnings.push(m));
  assert.deepEqual(cfg.diff, DEFAULT_SERVE_CONFIG.diff);
  assert.equal(cfg.title, "kept");
});

test("loadServeConfig: accentColor must be a hex color; invalid falls back", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.json"), JSON.stringify({ accentColor: "blue" }), "utf8");
  const cfg = loadServeConfig(dir, () => {});
  assert.equal(cfg.accentColor, DEFAULT_SERVE_CONFIG.accentColor);
});

// --- serve.css passthrough --------------------------------------------

test("customCssPath: null configDir -> null", () => {
  assert.equal(customCssPath(null), null);
});

test("customCssPath: no serve.css present -> null", () => {
  const dir = tmpDir();
  assert.equal(customCssPath(dir), null);
});

test("customCssPath: serve.css present -> its path", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "serve.css"), "body { color: red; }", "utf8");
  assert.equal(customCssPath(dir), path.join(dir, "serve.css"));
});
