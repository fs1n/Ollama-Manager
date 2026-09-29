// Small HTTP helpers shared by every server module: structured logging, JSON
// errors, the streaming idle-timeout wrapper and the security headers.

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

type LogLevel = "info" | "warn" | "error";

export function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, meta }));
}

export function jsonError(message: string, status = 502, headers?: HeadersInit): Response {
  const h = new Headers(headers);
  h.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ error: message }), { status, headers: h });
}

/** Clips a value before it goes into a log line (user-controlled input). */
export function clip(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/**
 * Reads a request body as text, refusing more than `maxBytes`. Used on public
 * routes so an unauthenticated client can't make the server buffer a huge body.
 * Returns null when the body is too large.
 */
export async function readBodyLimited(req: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length") || "0");
  if (declared > maxBytes) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Wraps an upstream body so it self-terminates after `idleMs` with no new
// chunk, resetting the timer on every chunk received. onIdleTimeout() is used
// to also abort the underlying upstream fetch so the backend isn't left
// mid-request.
export function withIdleTimeout(
  body: ReadableStream<Uint8Array> | null,
  idleMs: number,
  onIdleTimeout: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fireIdle = () => {}; // bound to the real controller in start()

  const disarm = () => {
    if (timer) clearTimeout(timer);
  };
  const arm = () => {
    timer = setTimeout(fireIdle, idleMs);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      fireIdle = () => {
        onIdleTimeout();
        controller.error(new Error("Idle timeout — no data received from upstream"));
      };
      arm();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        disarm();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(value);
        arm();
      } catch (err) {
        disarm();
        controller.error(err);
      }
    },
    cancel(reason) {
      disarm();
      reader.cancel(reason).catch(() => {});
    },
  });
}

// Security headers applied to every outgoing response. Two separate policies:
// the app has no inline scripts or event-handler attributes (the frontend is
// real ES modules loaded via <script type="module" src=…>, see public/src/),
// so its script-src needs no 'unsafe-inline' and no CDN at all — unpkg.com is
// only used by Swagger UI's standalone HTML at /api/docs, which keeps its own,
// separately-scoped policy (including 'unsafe-inline' for the small inline
// SwaggerUIBundle(...) init script it renders). style-src still needs
// 'unsafe-inline' for the app: it has inline style="…" attributes left, which
// aren't script-executable, so that's a much smaller residual allowance.
export const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export const DOCS_CSP = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://unpkg.com",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

export function withSecurityHeaders(resp: Response, csp: string = APP_CSP): Response {
  resp.headers.set("Content-Security-Policy", csp);
  resp.headers.set("X-Content-Type-Options", "nosniff");
  resp.headers.set("X-Frame-Options", "DENY");
  resp.headers.set("Referrer-Policy", "no-referrer");
  return resp;
}
