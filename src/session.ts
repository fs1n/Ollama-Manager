// Session handling around the stateless tokens of src/auth.ts: request token
// lookup, cookies, logout revocation and the login rate limiter. All state is
// per instance (createSessions), so tests can build as many as they need.
import { timingSafeEqual } from "node:crypto";
import {
  createSessionToken,
  deriveSessionSecret,
  parseCookies,
  tokenExpiry,
  verifySessionToken,
} from "./auth";

export const SESSION_COOKIE = "om_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// A real token is "<expiry>.<hex hmac>", well under 100 bytes. Anything much
// longer is not ours and is never looked at, let alone stored.
const MAX_TOKEN_LENGTH = 256;
// Upper bounds on in-memory state that unauthenticated clients can grow.
const MAX_REVOKED = 10_000;
const MAX_TRACKED_IPS = 10_000;
const MAX_FAILURES = 5;
const FAILURE_WINDOW_MS = 60_000;

export function timingSafeCompare(a: string, b: string): boolean {
  // Compare byte length, not UTF-16 code-unit length: a multibyte string can
  // have equal .length to an ASCII one while differing in byte length, which
  // would otherwise make timingSafeEqual() throw.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

/** Drops the oldest entries (Map keeps insertion order) until `max` remain. */
function capMap<K, V>(map: Map<K, V>, max: number): void {
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) return;
    map.delete(oldest.value);
  }
}

export function createSessions({
  masterKey,
  trustProxy,
  ttlMs = SESSION_TTL_MS,
}: {
  masterKey: string;
  trustProxy: boolean;
  ttlMs?: number;
}) {
  const secret = masterKey ? deriveSessionSecret(masterKey) : "";
  const revoked = new Map<string, number>(); // token -> its expiry
  const failures = new Map<string, { count: number; resetAt: number }>();

  function getRequestToken(req: Request): string {
    // The browser authenticates via an httpOnly cookie (unreadable from JS);
    // programmatic API clients can send x-session-token instead.
    const token =
      parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ||
      req.headers.get("x-session-token") ||
      "";
    return token.length > MAX_TOKEN_LENGTH ? "" : token;
  }

  function isValid(token: string): boolean {
    if (!token || revoked.has(token)) return false;
    return verifySessionToken(secret, token);
  }

  return {
    authRequired: !!masterKey,
    getRequestToken,
    isValid,

    /** True when the request may pass the auth gate. */
    isAuthorized(req: Request): boolean {
      return !masterKey || isValid(getRequestToken(req));
    },

    /** Checks a submitted master key. Non-strings never match. */
    checkKey(key: unknown): boolean {
      return !!masterKey && typeof key === "string" && timingSafeCompare(key, masterKey);
    },

    create(): { token: string; expires: number } {
      return createSessionToken(secret, ttlMs);
    },

    ttlSeconds: Math.floor(ttlMs / 1000),

    /**
     * Tokens are stateless, so logout has to actively revoke: remember the
     * token until its natural expiry. Only genuine, still-valid tokens are
     * stored — anything else can't be used anyway, and storing it would let
     * unauthenticated clients grow this map without bound.
     */
    revoke(token: string): void {
      if (!isValid(token)) return;
      revoked.set(token, tokenExpiry(token) || Date.now());
      capMap(revoked, MAX_REVOKED);
    },

    /** Client IP for rate limiting; X-Forwarded-For only behind a trusted proxy. */
    clientIp(req: Request, socketIp: string | undefined): string {
      const forwarded = trustProxy ? req.headers.get("x-forwarded-for") : null;
      return forwarded?.split(",")[0]?.trim() || socketIp || "unknown";
    },

    isRateLimited(ip: string): boolean {
      const entry = failures.get(ip);
      if (!entry) return false;
      if (Date.now() > entry.resetAt) {
        failures.delete(ip);
        return false;
      }
      return entry.count >= MAX_FAILURES;
    },

    recordFailure(ip: string): void {
      const entry = failures.get(ip) ?? { count: 0, resetAt: Date.now() + FAILURE_WINDOW_MS };
      entry.count++;
      failures.delete(ip); // re-insert so the most recent IPs survive capping
      failures.set(ip, entry);
      capMap(failures, MAX_TRACKED_IPS);
    },

    clearFailures(ip: string): void {
      failures.delete(ip);
    },

    /** Drops expired revocations and rate-limit windows (run periodically). */
    sweep(now = Date.now()): void {
      for (const [token, expiry] of revoked) if (now > expiry) revoked.delete(token);
      for (const [ip, entry] of failures) if (now > entry.resetAt) failures.delete(ip);
    },

    /** Sizes of the in-memory maps, for tests and diagnostics. */
    stats(): { revoked: number; trackedIps: number } {
      return { revoked: revoked.size, trackedIps: failures.size };
    },
  };
}

export type Sessions = ReturnType<typeof createSessions>;

// Secure can only be set when the browser talks HTTPS to us (directly, or via
// a trusted reverse proxy) — setting it on plain-HTTP LAN deployments would
// make the browser drop the cookie entirely.
export function isRequestSecure(req: Request, url: URL, trustProxy: boolean): boolean {
  if (url.protocol === "https:") return true;
  return trustProxy && req.headers.get("x-forwarded-proto") === "https";
}

export function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
}
