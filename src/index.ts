import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { type LibraryModel, parseLibraryHtml } from "./library";

const MASTER_KEY = (process.env.MASTER_KEY || "").trim();
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_URL = new URL(OLLAMA_HOST);
const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours
// Only trust the X-Forwarded-For header (used for login rate limiting) when the
// manager genuinely sits behind a reverse proxy that overwrites it. Without this,
// any directly-connected client can spoof a fresh IP per request and bypass the
// login rate limit entirely.
const TRUST_PROXY = ["1", "true", "yes"].includes(
  (process.env.TRUST_PROXY || "").trim().toLowerCase(),
);

const LITELLM_URL = (process.env.LITELLM_URL || "").trim();
const LITELLM_KEY = (process.env.LITELLM_KEY || "").trim();
const LITELLM_SYNC_INTERVAL = parseInt(process.env.LITELLM_SYNC_INTERVAL || "30", 10);
const LITELLM_ENABLED = !!(LITELLM_URL && LITELLM_KEY);

const STATIC_HTML = readFileSync(path.join(import.meta.dir, "..", "public", "index.html"), "utf-8");

const VERSION =
  process.env.OLLAMA_MANAGER_VERSION ||
  (() => {
    try {
      const pkg = JSON.parse(
        readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8"),
      );
      return pkg.version || "dev";
    } catch {
      return "dev";
    }
  })();

const sessions = new Map<string, number>();
const authFailures = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup of expired sessions and rate-limit entries (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
  for (const [ip, entry] of authFailures) {
    if (now > entry.resetAt) authFailures.delete(ip);
  }
}, 3600_000);

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, meta }));
}

function jsonError(message: string, status = 502): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function generateToken(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

function isSessionValid(token: string): boolean {
  const expiry = sessions.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sessions.delete(token);
    return false;
  }
  return true;
}

function timingSafeCompare(a: string, b: string): boolean {
  // Compare byte length, not UTF-16 code-unit length: a multibyte string can have
  // equal .length to an ASCII one while differing in byte length, which would
  // otherwise make timingSafeEqual() throw (caught upstream as a 400, not a 401).
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) return false;
  return timingSafeEqual(aBuf, bBuf);
}

function isRateLimited(ip: string): boolean {
  const entry = authFailures.get(ip);
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    authFailures.delete(ip);
    return false;
  }
  return entry.count >= 5;
}

function recordAuthFailure(ip: string): void {
  const entry = authFailures.get(ip) ?? { count: 0, resetAt: Date.now() + 60_000 };
  entry.count++;
  authFailures.set(ip, entry);
}

const PROXY_CONNECT_TIMEOUT_MS = 600_000; // hard cap to receive the initial response (headers)
// Once a body is streaming (large model pulls, long chat/generate output), only
// abort if no new chunk arrives for this long — NOT after a fixed total duration.
// A single fixed 10-minute cap on the whole request/response would kill a large,
// slow-but-still-progressing pull well before it finishes.
const PROXY_IDLE_TIMEOUT_MS = 120_000;

// Wraps an upstream body so it self-terminates after PROXY_IDLE_TIMEOUT_MS with no
// new chunk, resetting the timer on every chunk received. onIdleTimeout() is used
// to also abort the underlying upstream fetch so Ollama isn't left mid-request.
function withIdleTimeout(
  body: ReadableStream<Uint8Array> | null,
  idleMs: number,
  onIdleTimeout: () => void,
): ReadableStream<Uint8Array> | null {
  if (!body) return null;
  const reader = body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const disarm = () => {
    if (timer) clearTimeout(timer);
  };
  const arm = (fire: () => void) => {
    timer = setTimeout(fire, idleMs);
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      arm(() => {
        onIdleTimeout();
        controller.error(new Error("Idle timeout — no data received from Ollama"));
      });
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
        arm(() => {
          onIdleTimeout();
          controller.error(new Error("Idle timeout — no data received from Ollama"));
        });
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

async function forwardToOllama(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${OLLAMA_HOST}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.set("host", OLLAMA_URL.host);
  // Strip browser-originated headers — the manager is the HTTP client to Ollama,
  // and Ollama's OLLAMA_ORIGINS check would reject a non-localhost Origin.
  headers.delete("origin");
  headers.delete("referer");

  const upstreamAbort = new AbortController();
  let connectTimedOut = false;
  const connectDeadline = setTimeout(() => {
    connectTimedOut = true;
    upstreamAbort.abort();
  }, PROXY_CONNECT_TIMEOUT_MS);
  const signal = req.signal
    ? AbortSignal.any([req.signal, upstreamAbort.signal])
    : upstreamAbort.signal;

  try {
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      signal,
    });
    clearTimeout(connectDeadline);

    const proxyHeaders = new Headers(resp.headers);
    proxyHeaders.set("Cache-Control", "no-store");
    const body = withIdleTimeout(resp.body, PROXY_IDLE_TIMEOUT_MS, () => upstreamAbort.abort());
    return new Response(body, {
      status: resp.status,
      headers: proxyHeaders,
    });
  } catch (err: unknown) {
    clearTimeout(connectDeadline);
    if (connectTimedOut) return jsonError("Upstream request timed out", 504);
    const name = (err as { name?: string })?.name;
    if (name === "AbortError") return new Response(null, { status: 499 });
    return jsonError("Ollama unreachable");
  }
}

let libraryCache: LibraryModel[] | null = null;
let libraryCacheTime = 0;
const LIBRARY_TTL = 3600_000;
let libraryInflight: Promise<LibraryModel[]> | null = null;

async function _scrapeLibrary(): Promise<LibraryModel[]> {
  const maxRetries = 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (attempt > 0) {
      const delay = 1000 * 2 ** (attempt - 1);
      log("info", "Library scrape retry", { attempt: attempt + 1, delay });
      await new Promise((r) => setTimeout(r, delay));
    }

    try {
      const resp = await fetch("https://ollama.com/library", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        },
        credentials: "omit",
        signal: AbortSignal.timeout(10_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const html = await resp.text();
      const models = parseLibraryHtml(html);

      // A structurally successful fetch that parses to zero models means the
      // upstream markup moved out from under our selectors — that's a scrape
      // failure, not an empty catalog. Don't cache it; fall through to retry /
      // stale-cache fallback below instead of silently serving an empty list.
      if (models.length === 0) {
        throw new Error("Parsed 0 models from ollama.com/library — selectors may be stale");
      }

      libraryCache = models;
      libraryCacheTime = Date.now();
      log("info", "Library scraped", { count: models.length });
      return models;
    } catch (err) {
      lastErr = err;
      log("warn", "Library scrape attempt failed", { attempt: attempt + 1, error: String(err) });
    }
  }

  if (libraryCache) {
    log("warn", "Library scrape failed, returning stale cache", {
      ageMs: Date.now() - libraryCacheTime,
      error: String(lastErr),
    });
    return libraryCache;
  }

  throw lastErr;
}

async function fetchLibrary(): Promise<LibraryModel[]> {
  if (libraryCache && Date.now() - libraryCacheTime < LIBRARY_TTL) {
    return libraryCache;
  }
  if (libraryInflight) return libraryInflight;
  libraryInflight = _scrapeLibrary().finally(() => {
    libraryInflight = null;
  });
  return libraryInflight;
}

async function serveLibrary(): Promise<Response> {
  try {
    const models = await fetchLibrary();
    const isFresh = Date.now() - libraryCacheTime < 5000;
    const isStale = !isFresh && libraryCacheTime > 0 && Date.now() - libraryCacheTime > LIBRARY_TTL;
    return Response.json({ models, cached: isFresh, stale: isStale });
  } catch (err) {
    log("error", "Failed to serve library catalog", { error: String(err) });
    return jsonError("Failed to fetch library catalog");
  }
}

// =============================================================================
// LiteLLM Sync
// =============================================================================

interface SyncDetail {
  status: "success" | "skipped" | "failed" | "info";
  message: string;
}

interface SyncResult {
  time: number;
  success: number;
  failed: number;
  skipped: number;
  details: SyncDetail[];
}

let lastSync: SyncResult | null = null;
let syncInProgress = false;

async function syncOllamaToLiteLLM(): Promise<SyncResult> {
  if (syncInProgress)
    return (
      lastSync || {
        time: Date.now(),
        success: 0,
        failed: 0,
        skipped: 0,
        details: [{ status: "info", message: "Sync already in progress" }],
      }
    );
  syncInProgress = true;

  const result: SyncResult = { time: 0, success: 0, failed: 0, skipped: 0, details: [] };

  try {
    const [ollamaData, llmData, llmInfoData] = await Promise.all([
      fetch(`${OLLAMA_HOST}/api/tags`).then(async (r) => {
        if (!r.ok) throw new Error(`Ollama unreachable: HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${LITELLM_URL}/models`, {
        headers: { Authorization: `Bearer ${LITELLM_KEY}` },
      })
        .then(async (r) => (r.ok ? r.json() : null))
        .catch(() => null),
      // Used only for de-registration below (needs each model's internal id,
      // which /models doesn't expose). Best-effort: a failure here just means
      // orphan cleanup is skipped for this run, not that the sync fails.
      fetch(`${LITELLM_URL}/model/info`, {
        headers: { Authorization: `Bearer ${LITELLM_KEY}` },
      })
        .then(async (r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const ollamaModels: string[] = (ollamaData.models || [])
      .map((m: { name?: string }) => m.name || "")
      .filter(Boolean);

    if (ollamaModels.length === 0) {
      result.details.push({ status: "info", message: "No models found in Ollama" });
    }

    const existingModels = new Set<string>(
      (llmData?.data || []).map((m: { id?: string }) => m.id).filter(Boolean),
    );

    for (const name of ollamaModels) {
      const fullName = `ollama/${name}`;
      if (existingModels.has(fullName)) {
        result.skipped++;
        result.details.push({ status: "skipped", message: `${name} — already registered` });
        continue;
      }

      try {
        const resp = await fetch(`${LITELLM_URL}/model/new`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LITELLM_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model_name: fullName,
            litellm_params: {
              model: fullName,
              api_base: OLLAMA_HOST,
            },
          }),
        });
        if (resp.ok) {
          result.success++;
          result.details.push({ status: "success", message: `Registered ${name}` });
        } else {
          const err = await resp.text();
          result.failed++;
          result.details.push({
            status: "failed",
            message: `${name}: HTTP ${resp.status} — ${err.slice(0, 100)}`,
          });
        }
      } catch (e: unknown) {
        result.failed++;
        result.details.push({
          status: "failed",
          message: `${name}: ${e instanceof Error ? e.message : "Network error"}`,
        });
      }
    }

    // De-registration: remove LiteLLM entries this tool created (the "ollama/"
    // prefix is our marker — never touch anything else) for models that no
    // longer exist in Ollama, so deleted models don't leave dead routes behind.
    // Requires /model/info to resolve model_name -> internal id; if that call
    // failed above, llmInfoData is null and this is simply a no-op.
    const ollamaFullNames = new Set(ollamaModels.map((n) => `ollama/${n}`));
    const infoList: Array<{ model_name?: string; model_info?: { id?: string } }> =
      llmInfoData?.data ?? llmInfoData ?? [];

    for (const entry of infoList) {
      const modelName = entry.model_name;
      const id = entry.model_info?.id;
      if (!modelName || !id) continue;
      if (!modelName.startsWith("ollama/")) continue;
      if (ollamaFullNames.has(modelName)) continue;

      try {
        const resp = await fetch(`${LITELLM_URL}/model/delete`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LITELLM_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ id }),
        });
        if (resp.ok) {
          result.details.push({
            status: "info",
            message: `Removed ${modelName} — no longer in Ollama`,
          });
        } else {
          result.failed++;
          result.details.push({
            status: "failed",
            message: `Failed to remove ${modelName}: HTTP ${resp.status}`,
          });
        }
      } catch (e: unknown) {
        result.failed++;
        result.details.push({
          status: "failed",
          message: `Failed to remove ${modelName}: ${e instanceof Error ? e.message : "Network error"}`,
        });
      }
    }
  } catch (e: unknown) {
    result.details.push({
      status: "failed",
      message: `Sync error: ${e instanceof Error ? e.message : "Unknown error"}`,
    });
  } finally {
    syncInProgress = false;
    result.time = Date.now();
    lastSync = result;
  }

  return result;
}

function getLiteLLMStatus() {
  return {
    enabled: LITELLM_ENABLED,
    url: LITELLM_URL,
    interval: LITELLM_SYNC_INTERVAL,
    inProgress: syncInProgress,
    lastSync: lastSync
      ? {
          ...lastSync,
          details: lastSync.details.slice(-50),
        }
      : null,
  };
}

// Scheduler
if (LITELLM_ENABLED && LITELLM_SYNC_INTERVAL > 0) {
  setInterval(() => {
    syncOllamaToLiteLLM().catch((e: Error) =>
      log("error", "LiteLLM scheduled sync failed", { error: e.message }),
    );
  }, LITELLM_SYNC_INTERVAL * 60_000);
}

const OPENAPI_SPEC = {
  openapi: "3.0.3",
  info: {
    title: "Ollama Manager API",
    description:
      "Lightweight web UI for managing Ollama. All `/api/*` paths not listed below are transparently proxied to the configured Ollama instance.",
    version: VERSION,
  },
  components: {
    securitySchemes: {
      sessionToken: {
        type: "apiKey",
        in: "header",
        name: "x-session-token",
        description: "Session token returned by POST /api/auth",
      },
    },
  },
  security: [{ sessionToken: [] }],
  paths: {
    "/api/session": {
      get: {
        summary: "Session status",
        tags: ["Auth"],
        security: [],
        responses: {
          200: {
            description: "Auth configuration and current session state",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    authRequired: { type: "boolean" },
                    authenticated: { type: "boolean" },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/auth": {
      post: {
        summary: "Authenticate",
        tags: ["Auth"],
        security: [],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { key: { type: "string" } },
                required: ["key"],
              },
            },
          },
        },
        responses: {
          200: {
            description: "Authentication token",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    token: { type: "string" },
                    expires: { type: "number" },
                  },
                },
              },
            },
          },
          401: { description: "Invalid master key" },
        },
      },
    },
    "/api/logout": {
      post: {
        summary: "Invalidate session token",
        tags: ["Auth"],
        security: [],
        responses: {
          200: {
            description: "Logged out",
            content: {
              "application/json": {
                schema: { type: "object", properties: { ok: { type: "boolean" } } },
              },
            },
          },
        },
      },
    },
    "/api/app-version": {
      get: {
        summary: "App version",
        tags: ["Meta"],
        security: [],
        responses: {
          200: {
            description: "Version string",
            content: {
              "application/json": {
                schema: { type: "object", properties: { version: { type: "string" } } },
              },
            },
          },
        },
      },
    },
    "/api/catalog/library": {
      get: {
        summary: "Registry catalog",
        description: "Scraped list of models from ollama.com/library.",
        tags: ["Catalog"],
        responses: {
          200: {
            description: "Model list",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    models: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string" },
                          description: { type: "string" },
                          capabilities: { type: "array", items: { type: "string" } },
                          sizes: { type: "array", items: { type: "string" } },
                          isCloud: { type: "boolean" },
                        },
                      },
                    },
                    cached: {
                      type: "boolean",
                      description: "True if this response was scraped within the last 5 seconds.",
                    },
                    stale: {
                      type: "boolean",
                      description:
                        "True if a fresh scrape failed and this is a cache older than the normal 1h TTL, kept as a last-resort fallback.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/litellm/status": {
      get: {
        summary: "LiteLLM sync status",
        tags: ["LiteLLM"],
        responses: {
          200: {
            description: "Sync configuration and last run",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    enabled: { type: "boolean" },
                    url: { type: "string" },
                    interval: { type: "number" },
                    inProgress: { type: "boolean" },
                    lastSync: {
                      type: "object",
                      nullable: true,
                      properties: {
                        time: { type: "number" },
                        success: { type: "number" },
                        failed: { type: "number" },
                        skipped: { type: "number" },
                        details: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              status: {
                                type: "string",
                                enum: ["success", "skipped", "failed", "info"],
                              },
                              message: { type: "string" },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/api/litellm/sync": {
      post: {
        summary: "Trigger LiteLLM sync",
        description: "Registers all Ollama models with the configured LiteLLM proxy.",
        tags: ["LiteLLM"],
        responses: {
          200: {
            description: "Full status after sync",
            content: { "application/json": { schema: { type: "object" } } },
          },
          400: { description: "LiteLLM sync not configured" },
        },
      },
    },
    "/health": {
      get: {
        summary: "Health check",
        tags: ["Meta"],
        security: [],
        responses: {
          200: {
            description: "Service health",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    status: { type: "string", example: "ok" },
                    ollama: { type: "string", enum: ["connected", "unreachable"] },
                    ollamaVersion: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
};

const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ollama Manager API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui.css" integrity="sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT" crossorigin="anonymous">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f0f0f'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23c8f060' stroke-width='2.5'/%3E%3Crect x='14.5' y='10' width='3' height='12' fill='%23c8f060' transform='rotate(25 16 16)'/%3E%3C/svg%3E">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui-bundle.js" integrity="sha384-EYdOaiRwn44zNjrw+Tfs06qYz9BGQVo2f4/pLY5i7VorbjnZNhdplAbTBk8FXHUJ" crossorigin="anonymous"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis]
    });
  </script>
</body>
</html>`;

// Security headers applied to every outgoing response.
//
// script-src/style-src still need 'unsafe-inline': the frontend is a single
// static HTML file that relies on inline onclick="…" handlers and inline
// style="…" attributes throughout, so this CSP does not by itself stop
// inline-handler execution — that's handled by escaping model output before
// it reaches innerHTML (see renderMarkdown() in public/index.html). What it
// does provide: no script/style/font/connect can load from an origin outside
// this explicit allowlist, and the page can't be framed — both real
// mitigations against exfiltration and clickjacking, on top of that fix.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' https://unpkg.com 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net https://unpkg.com",
  "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net data:",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

function withSecurityHeaders(resp: Response): Response {
  resp.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  resp.headers.set("X-Content-Type-Options", "nosniff");
  resp.headers.set("X-Frame-Options", "DENY");
  resp.headers.set("Referrer-Policy", "no-referrer");
  return resp;
}

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  // Bun's default is 10s. The catalog scrape retries up to 3x with backoff
  // (see _scrapeLibrary) before it has anything to send back, which can
  // legitimately take longer than that when ollama.com is slow rather than
  // fully down — at the default, Bun silently drops the client connection
  // mid-request even though the server would have answered a few seconds
  // later. This does not affect the streaming proxy routes (forwardToOllama
  // has its own connect/idle timeouts and starts sending bytes immediately).
  idleTimeout: 60,
  async fetch(req, server) {
    return withSecurityHeaders(await handleRequest(req, server));
  },
  error(err) {
    log("error", "Unhandled server error", { error: String(err) });
    return withSecurityHeaders(jsonError("Internal Server Error", 500));
  },
});

async function handleRequest(req: Request, server: Bun.Server<undefined>): Promise<Response> {
  const url = new URL(req.url);

  // Session status (public)
  if (url.pathname === "/api/session" && req.method === "GET") {
    const token = req.headers.get("x-session-token") || "";
    return Response.json(
      {
        authRequired: !!MASTER_KEY,
        authenticated: MASTER_KEY ? isSessionValid(token) : true,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  // Login (public)
  if (url.pathname === "/api/auth" && req.method === "POST") {
    return (async () => {
      // Only honor X-Forwarded-For when explicitly told this instance sits
      // behind a proxy that overwrites it — otherwise any direct client can
      // spoof a fresh IP per request and bypass the rate limit below.
      const forwarded = TRUST_PROXY ? req.headers.get("x-forwarded-for") : null;
      const clientIp =
        forwarded?.split(",")[0]?.trim() ?? server.requestIP(req)?.address ?? "unknown";
      if (clientIp !== "unknown" && isRateLimited(clientIp))
        return jsonError("Too many attempts, try again later", 429);
      try {
        const { key } = await req.json();
        if (!key || !MASTER_KEY) return jsonError("Unauthorized", 401);
        if (!timingSafeCompare(key, MASTER_KEY)) {
          recordAuthFailure(clientIp);
          return jsonError("Unauthorized", 401);
        }
        authFailures.delete(clientIp);
        const token = generateToken();
        sessions.set(token, Date.now() + SESSION_TTL);
        return Response.json({ token, expires: sessions.get(token) });
      } catch {
        return jsonError("Invalid request", 400);
      }
    })();
  }

  // Logout
  if (url.pathname === "/api/logout" && req.method === "POST") {
    const token = req.headers.get("x-session-token") || "";
    if (token) sessions.delete(token);
    return Response.json({ ok: true });
  }

  // App version (public)
  if (url.pathname === "/api/app-version") {
    return Response.json({ version: VERSION });
  }

  // Health (public — needed for Docker HEALTHCHECK)
  // Manager always returns 200 (it's running); ollama field shows upstream state.
  if (url.pathname === "/health") {
    let ollamaStatus = "unreachable";
    let ollamaVersion: string | null = null;
    try {
      const r = await fetch(`${OLLAMA_HOST}/api/version`, { signal: AbortSignal.timeout(2_000) });
      if (r.ok) {
        const d = (await r.json()) as { version?: string };
        ollamaStatus = "connected";
        ollamaVersion = d.version ?? null;
      }
    } catch (e: unknown) {
      const reason = e instanceof Error ? e.message : String(e);
      log("warn", "Health check upstream probe failed", { error: reason });
    }
    return Response.json({ status: "ok", ollama: ollamaStatus, ollamaVersion });
  }

  // OpenAPI spec (public)
  if (url.pathname === "/api/openapi.json") {
    return Response.json(OPENAPI_SPEC);
  }

  // Swagger UI (public)
  if (url.pathname === "/api/docs") {
    return new Response(SWAGGER_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }

  // Static files (public — frontend handles login UI)
  if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
    return new Response(STATIC_HTML, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  // Auth gate (API only)
  if (MASTER_KEY) {
    const token = req.headers.get("x-session-token") || "";
    if (!isSessionValid(token)) {
      return jsonError("Unauthorized", 401);
    }
  }

  // API routes
  if (url.pathname === "/api/catalog/library") {
    return serveLibrary();
  }

  // LiteLLM sync status
  if (url.pathname === "/api/litellm/status" && req.method === "GET") {
    return Response.json(getLiteLLMStatus());
  }

  // LiteLLM manual sync trigger
  if (url.pathname === "/api/litellm/sync" && req.method === "POST") {
    if (!LITELLM_ENABLED) return jsonError("LiteLLM sync not configured", 400);
    // Report an honest 409 instead of silently handing back whatever the
    // previous (possibly stale) sync result was while one is already running.
    if (syncInProgress) return jsonError("Sync already in progress", 409);
    await syncOllamaToLiteLLM();
    return Response.json(getLiteLLMStatus());
  }

  return forwardToOllama(req);
}

log("info", "Ollama Manager started", {
  port: PORT,
  ollama: OLLAMA_HOST,
  auth: !!MASTER_KEY,
  litellm: LITELLM_ENABLED,
});
if (!MASTER_KEY) {
  log(
    "warn",
    "MASTER_KEY is not set — the manager is an open, unauthenticated proxy to the full Ollama API " +
      "(pull/delete/create/inference) for anyone who can reach this port. Set MASTER_KEY unless this " +
      "instance is on a fully trusted, non-internet-facing network.",
  );
}
if (LITELLM_ENABLED) {
  log("info", "LiteLLM sync enabled", { url: LITELLM_URL, intervalMin: LITELLM_SYNC_INTERVAL });
}
