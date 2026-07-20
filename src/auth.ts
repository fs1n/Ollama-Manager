import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Stateless, HMAC-signed session tokens: `<expiresMs>.<nonce>.<signature>`.
//
// The signing secret is derived from MASTER_KEY, which buys three properties
// without any session store or database:
//   - sessions survive server restarts (nothing to lose from memory),
//   - every instance sharing the same MASTER_KEY accepts the same tokens,
//   - rotating MASTER_KEY invalidates all outstanding sessions at once.
// The random nonce makes each token unique, so individual tokens can be
// revoked on logout (the server keeps a small in-memory revocation list of
// logged-out tokens until they expire on their own).

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

export function deriveSessionSecret(masterKey: string): string {
  // Namespaces the key to this purpose instead of using the raw master key
  // as an HMAC key directly.
  return createHmac("sha256", masterKey).update("ollama-manager.session.v1").digest("hex");
}

export function createSessionToken(
  secret: string,
  ttlMs: number,
  now = Date.now(),
): { token: string; expires: number } {
  const expires = now + ttlMs;
  const nonce = randomBytes(16).toString("hex");
  const payload = `${expires}.${nonce}`;
  return { token: `${payload}.${sign(secret, payload)}`, expires };
}

export function verifySessionToken(secret: string, token: string, now = Date.now()): boolean {
  const parts = token.split(".");
  if (parts.length !== 3) return false;
  const [expiresStr, nonce, sig] = parts;
  const expires = Number(expiresStr);
  if (!Number.isFinite(expires) || now > expires) return false;
  const expected = sign(secret, `${expiresStr}.${nonce}`);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(sigBuf, expectedBuf);
}

// Returns the token's expiry timestamp (ms) without verifying the signature.
// Used to know how long a revoked token needs to stay on the revocation list.
export function tokenExpiry(token: string): number {
  const expires = Number(token.split(".")[0]);
  return Number.isFinite(expires) ? expires : 0;
}

export function parseCookies(header: string | null): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    cookies[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
  }
  return cookies;
}
