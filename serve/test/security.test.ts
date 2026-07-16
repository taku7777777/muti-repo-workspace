/**
 * security.test.ts — the primitives behind §3.2's auth/CSRF/Host-allowlist
 * gate. See test/api-state.test.ts for the end-to-end matrix over real HTTP
 * (bootstrap flow, missing/wrong token, missing CSRF, evil Origin, evil
 * Host) — this file exercises each primitive in isolation.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  csrfTokenFor,
  hostnameFromHostHeader,
  hostnameFromOrigin,
  isAllowedHostname,
  parseCookies,
  sessionCookieValue,
  sha256Hex,
  timingSafeEqualStr,
} from "../src/security.js";

test("sha256Hex is deterministic and matches a known vector", () => {
  // sha256("") — a stable, well-known test vector.
  assert.equal(sha256Hex(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
});

test("timingSafeEqualStr: equal strings compare true, different strings compare false", () => {
  assert.equal(timingSafeEqualStr("abc", "abc"), true);
  assert.equal(timingSafeEqualStr("abc", "abd"), false);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false); // different length never throws
  assert.equal(timingSafeEqualStr("", ""), true);
});

test("csrfTokenFor is sha256hex('csrf:' + token), stable and token-dependent", () => {
  const token = "x".repeat(32);
  assert.equal(csrfTokenFor(token), sha256Hex(`csrf:${token}`));
  assert.notEqual(csrfTokenFor(token), csrfTokenFor("y".repeat(32)));
});

// --- Host header allowlist parsing -----------------------------------------

test("hostnameFromHostHeader: bare hostname", () => {
  assert.equal(hostnameFromHostHeader("localhost"), "localhost");
});

test("hostnameFromHostHeader: hostname:port", () => {
  assert.equal(hostnameFromHostHeader("127.0.0.1:7787"), "127.0.0.1");
});

test("hostnameFromHostHeader: bracketed IPv6 with port", () => {
  assert.equal(hostnameFromHostHeader("[::1]:7787"), "::1");
});

test("hostnameFromHostHeader: bracketed IPv6 without port", () => {
  assert.equal(hostnameFromHostHeader("[::1]"), "::1");
});

test("hostnameFromHostHeader: is case-insensitive", () => {
  assert.equal(hostnameFromHostHeader("LOCALHOST:7787"), "localhost");
});

test("hostnameFromHostHeader: missing/empty header is null", () => {
  assert.equal(hostnameFromHostHeader(undefined), null);
  assert.equal(hostnameFromHostHeader(""), null);
});

test("hostnameFromHostHeader: a DNS-rebinding style hostname is parsed but NOT in the allowlist", () => {
  assert.equal(hostnameFromHostHeader("evil.example:7787"), "evil.example");
  assert.equal(isAllowedHostname("evil.example"), false);
});

// --- Origin header parsing ---------------------------------------------

test("hostnameFromOrigin: plain http origin", () => {
  assert.equal(hostnameFromOrigin("http://127.0.0.1:7787"), "127.0.0.1");
});

test("hostnameFromOrigin: bracketed IPv6 origin has brackets stripped", () => {
  assert.equal(hostnameFromOrigin("http://[::1]:7787"), "::1");
});

test("hostnameFromOrigin: malformed origin is null", () => {
  assert.equal(hostnameFromOrigin("not a url"), null);
  assert.equal(hostnameFromOrigin(undefined), null);
});

test("hostnameFromOrigin: an evil cross-origin Origin header is parsed but NOT in the allowlist", () => {
  assert.equal(hostnameFromOrigin("https://evil.example"), "evil.example");
  assert.equal(isAllowedHostname("evil.example"), false);
});

// --- allowlist membership ----------------------------------------------

test("isAllowedHostname: exactly localhost, 127.0.0.1, ::1 — nothing else", () => {
  assert.equal(isAllowedHostname("localhost"), true);
  assert.equal(isAllowedHostname("127.0.0.1"), true);
  assert.equal(isAllowedHostname("::1"), true);
  assert.equal(isAllowedHostname("0.0.0.0"), false);
  assert.equal(isAllowedHostname("localhost.evil.example"), false);
  assert.equal(isAllowedHostname(null), false);
});

// --- cookie parsing ------------------------------------------------------

test("parseCookies: single and multiple cookies", () => {
  assert.deepEqual(parseCookies("a=1"), { a: "1" });
  assert.deepEqual(parseCookies("a=1; b=2;c=3"), { a: "1", b: "2", c: "3" });
});

test("parseCookies: missing header yields an empty object", () => {
  assert.deepEqual(parseCookies(undefined), {});
});

test("sessionCookieValue extracts mrw_serve specifically", () => {
  assert.equal(sessionCookieValue("mrw_serve=abc123; other=xyz"), "abc123");
  assert.equal(sessionCookieValue("other=xyz"), null);
  assert.equal(sessionCookieValue(undefined), null);
});
