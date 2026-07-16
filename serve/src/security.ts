/**
 * security.ts — every primitive routes.ts's auth/CSRF/Host-allowlist gate
 * (§3.2) is built from. This file makes no HTTP decisions itself (no
 * status-code branching) so it can be unit-tested as plain functions; the
 * gate that WIRES these into "403 here, require CSRF there" lives in
 * routes.ts, where it can be read top-to-bottom as one ordered checklist.
 *
 * Threat model reminder (why each piece exists):
 *  - the bootstrap token / session cookie stop a random localhost process
 *    (or a page from another origin) from driving this one without having
 *    been handed the token out-of-band by `mrw serve`;
 *  - the Host-header allowlist stops DNS rebinding (a page served from a
 *    public DNS name that resolves to 127.0.0.1 at request time, aimed at
 *    this port by the attacker's own site);
 *  - Origin + CSRF header on POSTs stop a cross-site form/fetch from a
 *    DIFFERENT origin from riding the browser's cookie jar (SameSite=Strict
 *    already mostly covers this for top-level navigation, but a defense in
 *    depth layer costs little and stops the subdomain/cache edge cases
 *    SameSite alone does not).
 * None of this replaces the broker's own in-process sha re-verification —
 * see wire.ts's header comment — it only decides whether a request is even
 * allowed to REACH that relay in the first place.
 */
import * as crypto from "node:crypto";

export const SESSION_COOKIE_NAME = "mrw_serve";
export const CSRF_HEADER_NAME = "x-mrw-csrf";

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Constant-time string equality. Hashing BOTH sides to a fixed 32-byte
 * digest first means crypto.timingSafeEqual never throws on a length
 * mismatch (its own precondition) AND the comparison leaks no timing signal
 * about the length or content of `provided` — the two properties §3.2 calls
 * out explicitly ("timing-safe compare (sha256 both sides +
 * crypto.timingSafeEqual)").
 */
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ah = crypto.createHash("sha256").update(a, "utf8").digest();
  const bh = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ah, bh);
}

/** csrf = sha256hex("csrf:" + SERVE_SESSION_TOKEN) — §3.2, verbatim. Derived
 *  rather than random so no server-side session store is needed: any holder
 *  of the session token (i.e. anyone who already passed the cookie check)
 *  can recompute it, and the boot JSON is the ONLY place it is handed to the
 *  page. */
export function csrfTokenFor(sessionToken: string): string {
  return sha256Hex("csrf:" + sessionToken);
}

const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

export function isAllowedHostname(hostname: string | null): boolean {
  return hostname !== null && ALLOWED_HOSTNAMES.has(hostname.toLowerCase());
}

/**
 * Bare hostname from an HTTP Host header value: "host:port", a bracketed
 * IPv6 literal ("[::1]:port" or "[::1]"), or a bare hostname. Returns null
 * on anything unparseable — callers must treat null as "not allowed", never
 * as "skip the check".
 */
export function hostnameFromHostHeader(host: string | undefined): string | null {
  if (!host) return null;
  const h = host.trim();
  if (h.length === 0) return null;
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end > 0 ? h.slice(1, end).toLowerCase() : null;
  }
  const firstColon = h.indexOf(":");
  if (firstColon === -1) return h.toLowerCase();
  // More than one colon with no brackets is a bare (unbracketed) IPv6
  // literal, not "host:port" — treat the whole value as the hostname rather
  // than mis-splitting it at the first colon.
  if (h.indexOf(":", firstColon + 1) !== -1) return h.toLowerCase();
  return h.slice(0, firstColon).toLowerCase();
}

/** Bare hostname from an Origin header value (a full origin, e.g.
 *  "http://127.0.0.1:7787"). Returns null for a missing/unparseable Origin —
 *  callers must treat that as "not allowed" (§3.2 requires Origin be
 *  PRESENT on every POST). */
export function hostnameFromOrigin(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    const u = new URL(origin);
    let h = u.hostname.toLowerCase();
    if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
    return h;
  } catch {
    return null;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    const v = part.slice(eq + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v; // malformed percent-encoding — keep the raw value rather than dropping the cookie
    }
  }
  return out;
}

export function sessionCookieValue(cookieHeader: string | undefined): string | null {
  const cookies = parseCookies(cookieHeader);
  return Object.prototype.hasOwnProperty.call(cookies, SESSION_COOKIE_NAME) ? cookies[SESSION_COOKIE_NAME] : null;
}

/** §3.2's exact response header set, applied to EVERY response regardless
 *  of route or auth outcome (including 403/404/405 and /healthz). */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cache-Control": "no-store",
});
