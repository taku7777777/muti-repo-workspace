/**
 * routes.ts — the request dispatcher (§3.3) and the security gate every
 * route (other than /healthz) passes through (§3.2), read top-to-bottom as
 * one ordered checklist. server.ts wires this to node:http; this file has
 * no listen()/port concerns of its own so it (and everything it calls) is
 * fully unit-testable by constructing a ServeContext and invoking
 * handleRequest directly against fake req/res objects, or by driving a real
 * server built from it (test/api-state.test.ts does the latter, against a
 * real unix-socket stub broker).
 *
 * GET / is APP CHROME ONLY (see html.ts's renderShell doc comment) — the
 * pending view arrives exclusively via GET /api/state, which is also the
 * ONLY place raw broker-sourced strings leave this process as JSON. Nothing
 * in this file turns broker-sourced content into HTML; that happens
 * exclusively in assets/app.js, at the point it touches the DOM.
 */
import * as fs from "node:fs";
import type * as http from "node:http";
import { z } from "zod";
import type { BrokerClient } from "./broker-client.js";
import type { ServeConfig } from "./config.js";
import { customCssPath } from "./config.js";
import { renderShell, type BootPayload } from "./html.js";
import {
  CSRF_HEADER_NAME,
  hostnameFromHostHeader,
  hostnameFromOrigin,
  isAllowedHostname,
  SECURITY_HEADERS,
  SESSION_COOKIE_NAME,
  sessionCookieValue,
  timingSafeEqualStr,
} from "./security.js";
import type { PendingWire } from "./wire.js";

export interface ServeContext {
  sessionToken: string;
  csrf: string;
  broker: BrokerClient;
  config: ServeConfig;
  configDir: string | null;
  appJs: string;
  appCss: string;
}

const MAX_BODY_BYTES = 16 * 1024; // §3.2 "Body limit 16 KB"

// --- small http helpers -----------------------------------------------

function sendText(res: http.ServerResponse, status: number, text: string, contentType = "text/plain; charset=utf-8"): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(text);
}

function sendHtml(res: http.ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

type ReadBodyResult = { ok: true; body: Buffer } | { ok: false; reason: "too_large" | "error" };

function readBody(req: http.IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    let oversized = false;
    const finish = (result: ReadBodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on("data", (chunk: Buffer) => {
      if (oversized) return; // already decided; drain and discard the rest below
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        oversized = true;
        // Deliberately NOT req.destroy() here: that would tear down the
        // socket's WRITE side too, and the caller still needs to send a
        // real (200, ok:false) response over this same connection (§3.3's
        // approve/decline routes always reply, never just hang up). Simply
        // stop accumulating; the 'data'/'end' listeners stay attached so
        // the rest of the request drains normally instead of leaving the
        // socket in a stuck, half-read state.
        finish({ ok: false, reason: "too_large" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => finish({ ok: true, body: Buffer.concat(chunks) }));
    req.on("error", () => finish({ ok: false, reason: "error" }));
  });
}

// --- §3.2 auth/CSRF checks, composed from security.ts primitives -------

function isAuthedByCookie(req: http.IncomingMessage, ctx: ServeContext): boolean {
  const cookieVal = sessionCookieValue(req.headers.cookie);
  return cookieVal !== null && timingSafeEqualStr(cookieVal, ctx.sessionToken);
}

function hasAllowedOrigin(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (typeof origin !== "string") return false;
  return isAllowedHostname(hostnameFromOrigin(origin));
}

function hasValidCsrfHeader(req: http.IncomingMessage, ctx: ServeContext): boolean {
  const header = req.headers[CSRF_HEADER_NAME];
  const value = Array.isArray(header) ? header[0] : header;
  return typeof value === "string" && timingSafeEqualStr(value, ctx.csrf);
}

// --- route bodies -----------------------------------------------------

function handleBootstrapOrRoot(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServeContext, url: URL): void {
  const token = url.searchParams.get("token");
  if (token !== null) {
    if (timingSafeEqualStr(token, ctx.sessionToken)) {
      res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${ctx.sessionToken}; HttpOnly; SameSite=Strict; Path=/`);
      res.writeHead(303, { Location: "/" });
      res.end();
      return;
    }
    sendText(res, 403, "forbidden: bad bootstrap token");
    return;
  }

  if (!isAuthedByCookie(req, ctx)) {
    sendText(res, 403, "forbidden");
    return;
  }

  const customCssAvailable = ctx.config.customCss && customCssPath(ctx.configDir) !== null;
  const boot: BootPayload = {
    csrf: ctx.csrf,
    title: ctx.config.title,
    theme: ctx.config.theme,
    accentColor: ctx.config.accentColor,
    pollIntervalMs: ctx.config.pollIntervalMs,
    diff: ctx.config.diff,
    sections: ctx.config.sections,
  };
  sendHtml(res, 200, renderShell(boot, customCssAvailable));
}

async function handleApiState(res: http.ServerResponse, ctx: ServeContext, url: URL): Promise<void> {
  const knownParam = url.searchParams.get("known");
  const known = knownParam === null ? undefined : knownParam;

  const result = await ctx.broker.status(known);
  if (!result.connected) {
    sendJson(res, 200, { connected: false, pending: null, last: null, history: [] });
    return;
  }

  // Relay "unchanged" to the BROWSER only when ITS OWN known id already
  // matches — the browser is the one holding the cache that makes
  // "unchanged" meaningful to it (see broker-client.ts's header comment for
  // why the serve<->broker leg of this same compression is handled a layer
  // down, transparently, before this function ever sees it).
  const pendingOut: PendingWire | "unchanged" | null =
    result.pending && known !== undefined && result.pending.id === known ? "unchanged" : result.pending;

  sendJson(res, 200, {
    connected: true,
    pending: pendingOut,
    last: result.last,
    history: result.history,
  });
}

const ApproveBodySchema = z.object({ id: z.string().min(1).max(200), sha: z.string().min(1).max(200) }).strict();
const DeclineBodySchema = z.object({ id: z.string().min(1).max(200) }).strict();

async function handleApprovalPost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  ctx: ServeContext,
  kind: "approve" | "decline",
): Promise<void> {
  const bodyResult = await readBody(req);
  if (!bodyResult.ok) {
    sendJson(res, 200, {
      ok: false,
      code: "invalid_request",
      error: bodyResult.reason === "too_large" ? "request body exceeds the 16 KB limit" : "error reading request body",
    });
    return;
  }

  let parsedJson: unknown;
  try {
    parsedJson = bodyResult.body.length > 0 ? JSON.parse(bodyResult.body.toString("utf8")) : {};
  } catch (e) {
    sendJson(res, 200, { ok: false, code: "invalid_request", error: `malformed JSON: ${(e as Error).message}` });
    return;
  }

  if (kind === "approve") {
    const parsed = ApproveBodySchema.safeParse(parsedJson);
    if (!parsed.success) {
      sendJson(res, 200, { ok: false, code: "invalid_request", error: parsed.error.message });
      return;
    }
    sendJson(res, 200, await ctx.broker.approve(parsed.data.id, parsed.data.sha));
    return;
  }

  const parsed = DeclineBodySchema.safeParse(parsedJson);
  if (!parsed.success) {
    sendJson(res, 200, { ok: false, code: "invalid_request", error: parsed.error.message });
    return;
  }
  sendJson(res, 200, await ctx.broker.decline(parsed.data.id));
}

function serveAsset(res: http.ServerResponse, content: string, contentType: string): void {
  sendText(res, 200, content, contentType);
}

// --- the dispatcher ------------------------------------------------------

export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: ServeContext): Promise<void> {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);

  const method = req.method ?? "";
  if (method !== "GET" && method !== "POST") {
    sendText(res, 405, "method not allowed");
    return;
  }

  let url: URL;
  try {
    // Base is a placeholder — only req.url's path+query are ever used;
    // req.headers.host is validated separately (below) against the
    // allowlist, never trusted as a same-origin signal on its own.
    url = new URL(req.url ?? "/", "http://internal.invalid");
  } catch {
    sendText(res, 400, "bad request");
    return;
  }

  const hostname = hostnameFromHostHeader(req.headers.host);
  if (!isAllowedHostname(hostname)) {
    sendText(res, 403, "forbidden: host not allowed");
    return;
  }

  const pathname = url.pathname;

  if (pathname === "/healthz") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    sendText(res, 200, "ok");
    return;
  }

  if (pathname === "/") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    handleBootstrapOrRoot(req, res, ctx, url);
    return;
  }

  if (pathname === "/api/state") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    if (!isAuthedByCookie(req, ctx)) return sendText(res, 403, "forbidden");
    await handleApiState(res, ctx, url);
    return;
  }

  if (pathname === "/api/approve" || pathname === "/api/decline") {
    if (method !== "POST") return sendText(res, 405, "method not allowed");
    if (!isAuthedByCookie(req, ctx)) return sendText(res, 403, "forbidden");
    if (!hasAllowedOrigin(req) || !hasValidCsrfHeader(req, ctx)) return sendText(res, 403, "forbidden: bad origin/csrf");
    await handleApprovalPost(req, res, ctx, pathname === "/api/approve" ? "approve" : "decline");
    return;
  }

  if (pathname === "/assets/app.js") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    if (!isAuthedByCookie(req, ctx)) return sendText(res, 403, "forbidden");
    serveAsset(res, ctx.appJs, "text/javascript; charset=utf-8");
    return;
  }

  if (pathname === "/assets/app.css") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    if (!isAuthedByCookie(req, ctx)) return sendText(res, 403, "forbidden");
    serveAsset(res, ctx.appCss, "text/css; charset=utf-8");
    return;
  }

  if (pathname === "/assets/custom.css") {
    if (method !== "GET") return sendText(res, 405, "method not allowed");
    if (!isAuthedByCookie(req, ctx)) return sendText(res, 403, "forbidden");
    const file = ctx.config.customCss ? customCssPath(ctx.configDir) : null;
    if (!file) return sendText(res, 404, "not found");
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      sendText(res, 404, "not found");
      return;
    }
    serveAsset(res, content, "text/css; charset=utf-8");
    return;
  }

  sendText(res, 404, "not found");
}
