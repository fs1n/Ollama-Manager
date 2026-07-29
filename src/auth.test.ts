import { describe, expect, test } from "bun:test";
import {
  createSessionToken,
  deriveSessionSecret,
  parseCookies,
  tokenExpiry,
  verifySessionToken,
} from "./auth";

const SECRET = deriveSessionSecret("test-master-key");

describe("session tokens", () => {
  test("round-trip: a freshly created token verifies", () => {
    const { token, expires } = createSessionToken(SECRET, 60_000);
    expect(verifySessionToken(SECRET, token)).toBe(true);
    expect(expires).toBeGreaterThan(Date.now());
  });

  test("tokens are unique even at the same timestamp", () => {
    const now = Date.now();
    const a = createSessionToken(SECRET, 60_000, now);
    const b = createSessionToken(SECRET, 60_000, now);
    expect(a.token).not.toBe(b.token);
  });

  test("expired token is rejected", () => {
    const { token } = createSessionToken(SECRET, 1_000, Date.now() - 10_000);
    expect(verifySessionToken(SECRET, token)).toBe(false);
  });

  test("tampered expiry is rejected (signature no longer matches)", () => {
    const { token } = createSessionToken(SECRET, 1_000, Date.now() - 10_000);
    const [, nonce, sig] = token.split(".");
    const forged = `${Date.now() + 60_000}.${nonce}.${sig}`;
    expect(verifySessionToken(SECRET, forged)).toBe(false);
  });

  test("tampered signature is rejected", () => {
    const { token } = createSessionToken(SECRET, 60_000);
    const flipped = token.slice(0, -1) + (token.endsWith("0") ? "1" : "0");
    expect(verifySessionToken(SECRET, flipped)).toBe(false);
  });

  test("token signed with a different secret is rejected", () => {
    const other = deriveSessionSecret("other-master-key");
    const { token } = createSessionToken(other, 60_000);
    expect(verifySessionToken(SECRET, token)).toBe(false);
  });

  test("malformed tokens are rejected without throwing", () => {
    for (const bad of ["", "abc", "1.2", "1.2.3.4", "x.y.z", "9".repeat(400)]) {
      expect(verifySessionToken(SECRET, bad)).toBe(false);
    }
  });

  test("tokenExpiry reads the expiry, or 0 for garbage", () => {
    const now = Date.now();
    const { token } = createSessionToken(SECRET, 60_000, now);
    expect(tokenExpiry(token)).toBe(now + 60_000);
    expect(tokenExpiry("garbage")).toBe(0);
  });

  test("deriveSessionSecret is deterministic and key-dependent", () => {
    expect(deriveSessionSecret("k1")).toBe(deriveSessionSecret("k1"));
    expect(deriveSessionSecret("k1")).not.toBe(deriveSessionSecret("k2"));
  });
});

describe("parseCookies", () => {
  test("parses a typical cookie header", () => {
    expect(parseCookies("om_session=abc.def.123; theme=dark")).toEqual({
      om_session: "abc.def.123",
      theme: "dark",
    });
  });

  test("handles null, empty, and malformed input", () => {
    expect(parseCookies(null)).toEqual({});
    expect(parseCookies("")).toEqual({});
    expect(parseCookies("=nokey; justtext; a=1")).toEqual({ a: "1" });
  });
});
