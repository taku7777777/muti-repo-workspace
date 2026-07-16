/**
 * api-state.test.ts — the full HTTP surface (§3.3 routes, §3.2 security
 * gate) driven over REAL HTTP against createServer(), with a REAL
 * unix-socket stub broker underneath (§3, "Tests": "/api/state against a
 * FAKE broker socket (spin a real unix-socket stub in the test)" + "auth
 * middleware (no/wrong token, missing CSRF, evil Origin, evil Host,
 * bootstrap flow sets cookie)").
 *
 * createServer() is constructible without listening (server.ts's doc
 * comment) — this file is the one place that actually calls .listen(), on
 * an ephemeral port (0) per test, so nothing here fights over a fixed port.
 */
import assert from "node:assert/strict";
import * as http from "node:http";
import { test } from "node:test";
import { BrokerClient } from "../src/broker-client.js";
import { DEFAULT_SERVE_CONFIG } from "../src/config.js";
import { csrfTokenFor } from "../src/security.js";
import { createServer } from "../src/server.js";
import { fakePending, startFakeBroker, type FakeBrokerHandler } from "./fake-broker.js";

const TOKEN = "t".repeat(32);
const CSRF = csrfTokenFor(TOKEN);

interface Res {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(
  port: number,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path, headers: opts.headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

async function setupServer(brokerHandler: FakeBrokerHandler) {
  const broker = await startFakeBroker(brokerHandler);
  const client = new BrokerClient(broker.socketPath);
  const httpServer = createServer({
    sessionToken: TOKEN,
    broker: client,
    config: DEFAULT_SERVE_CONFIG,
    configDir: null,
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await broker.close();
    },
  };
}

const cookieHeader = { Cookie: `mrw_serve=${TOKEN}` };

// --- /healthz --------------------------------------------------------------

test("GET /healthz: 200 'ok', no auth required", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/healthz" });
    assert.equal(res.status, 200);
    assert.equal(res.body, "ok");
  } finally {
    await s.close();
  }
});

// --- bootstrap / cookie auth ------------------------------------------------

test("GET / with no token and no cookie: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/" });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("GET /?token=<wrong>: 403, no cookie set", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/?token=" + "x".repeat(32) });
    assert.equal(res.status, 403);
    assert.equal(res.headers["set-cookie"], undefined);
  } finally {
    await s.close();
  }
});

test("GET /?token=<correct>: 303 redirect to / with Set-Cookie", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/?token=" + TOKEN });
    assert.equal(res.status, 303);
    assert.equal(res.headers.location, "/");
    const setCookie = res.headers["set-cookie"];
    assert.ok(setCookie && setCookie[0].includes(`mrw_serve=${TOKEN}`));
    assert.ok(setCookie && setCookie[0].includes("HttpOnly"));
    assert.ok(setCookie && setCookie[0].includes("SameSite=Strict"));
  } finally {
    await s.close();
  }
});

test("GET / with a valid cookie: 200, contains the boot script and app chrome", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/", headers: cookieHeader });
    assert.equal(res.status, 200);
    assert.match(res.body, /<script type="application\/json" id="boot">/);
    assert.match(res.body, /"csrf":"/);
  } finally {
    await s.close();
  }
});

test("GET / with a WRONG cookie value: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/", headers: { Cookie: "mrw_serve=" + "z".repeat(32) } });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

// --- Host allowlist (anti-DNS-rebinding) ------------------------------------

test("evil Host header: 403 even with a valid cookie", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/", headers: { ...cookieHeader, Host: "evil.example" } });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("Host: 127.0.0.1 with a port is allowed", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/healthz", headers: { Host: `127.0.0.1:${s.port}` } });
    assert.equal(res.status, 200);
  } finally {
    await s.close();
  }
});

// --- /assets/* ---------------------------------------------------------

test("GET /assets/app.js without a cookie: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/assets/app.js" });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("GET /assets/app.js with a cookie: 200, non-empty, JS content type", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/assets/app.js", headers: cookieHeader });
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /javascript/);
    assert.ok(res.body.length > 0);
  } finally {
    await s.close();
  }
});

test("GET /assets/custom.css when not configured: 404", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/assets/custom.css", headers: cookieHeader });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

// --- security headers --------------------------------------------------

test("every response carries the pinned security headers", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/healthz" });
    assert.match(String(res.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(res.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(res.headers["content-security-policy"]), /unsafe-inline/);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["cache-control"], "no-store");
  } finally {
    await s.close();
  }
});

// --- /api/state -----------------------------------------------------------

test("GET /api/state without a cookie: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/api/state" });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("GET /api/state: idle (no pending) reports connected:true, pending:null", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/api/state", headers: cookieHeader });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.connected, true);
    assert.equal(json.pending, null);
    assert.deepEqual(json.history, []);
  } finally {
    await s.close();
  }
});

test("GET /api/state: broker unreachable reports connected:false (never an HTTP error)", async () => {
  // Build (and immediately tear down) a fake broker just to mint a socket
  // path that is guaranteed to have nothing listening on it.
  const broker = await startFakeBroker(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  await broker.close(); // socket file gone, nothing listening
  const client = new BrokerClient(broker.socketPath);
  const httpServer = createServer({ sessionToken: TOKEN, broker: client, config: DEFAULT_SERVE_CONFIG, configDir: null });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve()));
  const address = httpServer.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    const res = await request(port, { path: "/api/state", headers: cookieHeader });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.connected, false);
    assert.equal(json.pending, null);
  } finally {
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  }
});

test("GET /api/state: a pending publish is returned in full", async () => {
  const pending = fakePending();
  const s = await setupServer((req) => {
    const r = req as { op: string };
    if (r.op === "status") return { ok: true, protocol: 1, pending, last: null };
    throw new Error("unexpected op");
  });
  try {
    const res = await request(s.port, { path: "/api/state", headers: cookieHeader });
    const json = JSON.parse(res.body);
    assert.equal(json.connected, true);
    assert.equal(json.pending.id, pending.id);
    assert.equal(json.pending.view.title, (pending.view as Record<string, unknown>).title);
  } finally {
    await s.close();
  }
});

test("GET /api/state?known=<current id>: relayed to the browser as 'unchanged'", async () => {
  const pending = fakePending();
  const s = await setupServer((req) => {
    const r = req as { op: string; known?: string };
    if (r.op === "status") {
      if (r.known === pending.id) return { ok: true, protocol: 1, pending: "unchanged", last: null };
      return { ok: true, protocol: 1, pending, last: null };
    }
    throw new Error("unexpected op");
  });
  try {
    const res = await request(s.port, { path: `/api/state?known=${pending.id}`, headers: cookieHeader });
    const json = JSON.parse(res.body);
    assert.equal(json.pending, "unchanged");
  } finally {
    await s.close();
  }
});

// --- /api/approve & /api/decline (POST auth: cookie + Origin + CSRF) -------

const validOrigin = (port: number) => ({ Origin: `http://127.0.0.1:${port}` });

test("POST /api/approve without a cookie: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...validOrigin(s.port), "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", sha: "y" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("POST /api/approve with a cookie but WITHOUT the CSRF header: 403", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...cookieHeader, ...validOrigin(s.port), "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", sha: "y" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("POST /api/approve with an evil Origin: 403 even with a correct CSRF header", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...cookieHeader, Origin: "https://evil.example", "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", sha: "y" }),
    });
    assert.equal(res.status, 403);
  } finally {
    await s.close();
  }
});

test("POST /api/approve with cookie + valid Origin + valid CSRF: forwarded to the broker verbatim", async () => {
  const s = await setupServer((req) => {
    const r = req as { op: string; id: string; sha: string };
    if (r.op === "approve") {
      assert.equal(r.id, "pending-1");
      assert.equal(r.sha, "abc");
      return { ok: true, result: "approved" };
    }
    throw new Error("unexpected op");
  });
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...cookieHeader, ...validOrigin(s.port), "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pending-1", sha: "abc" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, result: "approved" });
  } finally {
    await s.close();
  }
});

test("POST /api/approve with a malformed JSON body: 200 with ok:false/invalid_request (never forwarded)", async () => {
  const s = await setupServer(() => {
    throw new Error("must not reach the broker");
  });
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...cookieHeader, ...validOrigin(s.port), "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: "{ not json",
    });
    assert.equal(res.status, 200);
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
    assert.equal(json.code, "invalid_request");
  } finally {
    await s.close();
  }
});

test("POST /api/approve with an oversized body (>16KB): rejected before reaching the broker", async () => {
  const s = await setupServer(() => {
    throw new Error("must not reach the broker");
  });
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/approve",
      headers: { ...cookieHeader, ...validOrigin(s.port), "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "x", sha: "y".repeat(20 * 1024) }),
    });
    const json = JSON.parse(res.body);
    assert.equal(json.ok, false);
  } finally {
    await s.close();
  }
});

test("POST /api/decline: forwarded to the broker verbatim", async () => {
  const s = await setupServer((req) => {
    const r = req as { op: string; id: string };
    if (r.op === "decline") {
      assert.equal(r.id, "pending-9");
      return { ok: true, result: "declined" };
    }
    throw new Error("unexpected op");
  });
  try {
    const res = await request(s.port, {
      method: "POST",
      path: "/api/decline",
      headers: { ...cookieHeader, ...validOrigin(s.port), "x-mrw-csrf": CSRF, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "pending-9" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), { ok: true, result: "declined" });
  } finally {
    await s.close();
  }
});

// --- method / path fallbacks -------------------------------------------

test("unknown path: 404", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/nope", headers: cookieHeader });
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test("DELETE method anywhere: 405", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { method: "DELETE", path: "/", headers: cookieHeader });
    assert.equal(res.status, 405);
  } finally {
    await s.close();
  }
});

test("GET on a POST-only route: 405", async () => {
  const s = await setupServer(() => ({ ok: true, protocol: 1, pending: null, last: null }));
  try {
    const res = await request(s.port, { path: "/api/approve", headers: cookieHeader });
    assert.equal(res.status, 405);
  } finally {
    await s.close();
  }
});
