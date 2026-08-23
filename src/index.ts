import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  createSessionToken,
  deriveSessionSecret,
  parseCookies,
  tokenExpiry,
  verifySessionToken,
} from "./auth";
import {
  dedupeByName,
  hasNextSearchPage,
  type LibraryModel,
  type LibraryModelDetail,
  parseLibraryDetailHtml,
  parseLibraryHtml,
} from "./library";

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

// Sessions are stateless HMAC-signed tokens (see src/auth.ts) — no session
// store to lose on restart. The only server-side state is the revocation list
// of logged-out tokens, kept until those tokens would have expired anyway.
const SESSION_SECRET = MASTER_KEY ? deriveSessionSecret(MASTER_KEY) : "";
const SESSION_COOKIE = "om_session";
const revokedTokens = new Map<string, number>(); // token -> its expiry
const authFailures = new Map<string, { count: number; resetAt: number }>();

// Periodic cleanup of stale revocations and rate-limit entries (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of revokedTokens) {
    if (now > expiry) revokedTokens.delete(token);
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

function isSessionValid(token: string): boolean {
  if (!token || revokedTokens.has(token)) return false;
  return verifySessionToken(SESSION_SECRET, token);
}

// The browser authenticates via an httpOnly cookie (token unreadable from JS);
// programmatic API clients can keep sending x-session-token instead.
function getRequestToken(req: Request): string {
  return (
    parseCookies(req.headers.get("cookie"))[SESSION_COOKIE] ||
    req.headers.get("x-session-token") ||
    ""
  );
}

// Secure can only be set when the browser talks HTTPS to us (directly, or via
// a trusted reverse proxy) — setting it on plain-HTTP LAN deployments would
// make the browser drop the cookie entirely.
function isRequestSecure(req: Request, url: URL): boolean {
  if (url.protocol === "https:") return true;
  return TRUST_PROXY && req.headers.get("x-forwarded-proto") === "https";
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return (
    `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}` +
    (secure ? "; Secure" : "")
  );
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

// Ollama endpoints whose responses stream long-lived NDJSON bodies. Only these
// get the idle-timeout body wrapper below — everything else returns a small
// JSON body right after the headers, and wrapping it would put a JS-land
// stream pump (reader, closures, timer churn) on the dashboard's hot polling
// path (/api/tags, /api/ps) for no benefit.
const STREAMING_API_PATHS = new Set([
  "/api/pull",
  "/api/push",
  "/api/chat",
  "/api/generate",
  "/api/create",
]);

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
        controller.error(new Error("Idle timeout — no data received from Ollama"));
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
    const body = STREAMING_API_PATHS.has(url.pathname)
      ? withIdleTimeout(resp.body, PROXY_IDLE_TIMEOUT_MS, () => upstreamAbort.abort())
      : resp.body;
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

const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

/** Dedupes consecutive pages only — returns false as soon as a page repeats cards. */
async function scrapeSearchFallback(fetchFn: FetchFn): Promise<LibraryModel[]> {
  const all: LibraryModel[] = [];
  let lastCount = 0;

  // /search serves 20 cards per page and signals the next page via an HTMX
  // hx-get="?page=N+1" marker; a missing marker means we've reached the end.
  for (let page = 1; page <= 50; page++) {
    const resp = await fetchFn(`https://ollama.com/search?page=${page}`, {
      headers: { ...SCRAPE_HEADERS, "HX-Request": "true" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`search page ${page}: HTTP ${resp.status}`);

    const html = await resp.text();
    all.push(...parseLibraryHtml(html));

    const deduped = dedupeByName(all);
    if (deduped.length <= lastCount) break; // page repeated cards — done
    lastCount = deduped.length;
    if (!hasNextSearchPage(html, page)) break;
  }

  return dedupeByName(all);
}

export async function scrapeLibraryWithFallback(fetchFn: FetchFn = fetch): Promise<LibraryModel[]> {
  const resp = await fetchFn("https://ollama.com/library", {
    headers: SCRAPE_HEADERS,
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const models = parseLibraryHtml(await resp.text());
  if (models.length > 0) return models;

  // /library parsed to zero — the page markup moved. Fall back to the second
  // template (/search, HTMX-paginated) before treating this as a scrape failure.
  log("warn", "/library parsed 0 models, falling back to /search pagination");
  const fallback = await scrapeSearchFallback(fetchFn);
  if (fallback.length === 0) {
    throw new Error("Parsed 0 models from both /library and /search — selectors are stale");
  }
  return fallback;
}

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
      const models = await scrapeLibraryWithFallback();

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

// Per-model detail pages (real tag list with size/context/input) are scraped
// on demand — they change far less often than the index, so a longer TTL and
// one cached entry per model name keeps ollama.com load trivial.
const detailCache = new Map<string, { data: LibraryModelDetail; time: number }>();
const DETAIL_TTL = 6 * 3600_000; // 6 hours
const detailInflight = new Map<string, Promise<LibraryModelDetail>>();

async function _scrapeDetail(name: string): Promise<LibraryModelDetail> {
  const resp = await fetch(`https://ollama.com/library/${name}`, {
    headers: SCRAPE_HEADERS,
    credentials: "omit",
    signal: AbortSignal.timeout(10_000),
  });
  if (resp.status === 404) throw new Error("Model not found in registry");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const detail = parseLibraryDetailHtml(await resp.text(), name);
  if (detail.tags.length === 0 && !detail.pulls) {
    throw new Error("Detail page parsed empty — selectors may be stale");
  }
  detailCache.set(name, { data: detail, time: Date.now() });
  return detail;
}

export async function fetchLibraryDetail(name: string): Promise<LibraryModelDetail> {
  const cached = detailCache.get(name);
  if (cached && Date.now() - cached.time < DETAIL_TTL) return cached.data;

  let inflight = detailInflight.get(name);
  if (!inflight) {
    inflight = _scrapeDetail(name).finally(() => detailInflight.delete(name));
    detailInflight.set(name, inflight);
  }
  return inflight;
}

async function serveLibraryDetail(name: string): Promise<Response> {
  try {
    const detail = await fetchLibraryDetail(name);
    const cached = detailCache.get(name);
    const fresh = cached ? Date.now() - cached.time < 5000 : false;
    return Response.json({ ...detail, cached: fresh });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("warn", "Library detail scrape failed", { name, error: msg });
    if (msg === "Model not found in registry") return jsonError(msg, 404);
    // Serve a stale cache entry if we have one before giving up entirely.
    const stale = detailCache.get(name);
    if (stale) return Response.json({ ...stale.data, stale: true });
    return jsonError("Failed to fetch model details");
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
        description: "Session token returned by POST /api/auth (for programmatic API clients)",
      },
      sessionCookie: {
        type: "apiKey",
        in: "cookie",
        name: "om_session",
        description:
          "httpOnly session cookie set automatically by POST /api/auth (used by the web UI)",
      },
    },
  },
  security: [{ sessionToken: [] }, { sessionCookie: [] }],
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
            description:
              "Authentication token. Also sets the httpOnly `om_session` cookie for browser clients; API clients can send the returned token via the x-session-token header instead.",
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
          429: { description: "Too many failed attempts" },
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
                          sizes: {
                            type: "array",
                            items: { type: "string" },
                            description: 'Parameter-size badges, e.g. "7b", "8x22b"',
                          },
                          variants: {
                            type: "array",
                            items: { type: "string" },
                            description:
                              'Non-param size-slot badges, e.g. Gemma\'s "e2b"/"e4b" — kept separate from sizes so size filters stay correct',
                          },
                          isCloud: { type: "boolean" },
                          pulls: { type: "string", example: "649.2K" },
                          tagCount: { type: "number" },
                          updatedText: { type: "string", example: "1 week ago" },
                          updatedAt: {
                            type: "string",
                            nullable: true,
                            format: "date-time",
                            description: 'Parsed from the updated span title="… UTC"',
                          },
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
    "/api/catalog/library/{name}": {
      get: {
        summary: "Registry model detail",
        description:
          "On-demand scrape of ollama.com/library/<name>: the real tag list with per-tag download size, context window and input type. Cached in memory for 6h per model name.",
        tags: ["Catalog"],
        parameters: [
          {
            name: "name",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
          },
        ],
        responses: {
          200: {
            description: "Model detail",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    name: { type: "string" },
                    tags: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          name: { type: "string", example: "8b" },
                          size: { type: "string", example: "4.9GB" },
                          context: { type: "string", example: "128K" },
                          input: { type: "string", example: "Text" },
                        },
                      },
                    },
                    pulls: { type: "string", example: "118.7M" },
                    updatedText: { type: "string" },
                    updatedAt: { type: "string", nullable: true, format: "date-time" },
                    cached: { type: "boolean" },
                    stale: { type: "boolean" },
                  },
                },
              },
            },
          },
          404: { description: "Model not found in registry" },
          502: { description: "Detail scrape failed" },
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
    const token = getRequestToken(req);
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
        const { token, expires } = createSessionToken(SESSION_SECRET, SESSION_TTL);
        // Browser clients get the token as an httpOnly cookie (unreadable from
        // JS); it's also returned in the body for programmatic API clients
        // that authenticate via the x-session-token header instead.
        return Response.json(
          { token, expires },
          {
            headers: {
              "Set-Cookie": sessionCookie(
                token,
                Math.floor(SESSION_TTL / 1000),
                isRequestSecure(req, url),
              ),
            },
          },
        );
      } catch {
        return jsonError("Invalid request", 400);
      }
    })();
  }

  // Logout
  if (url.pathname === "/api/logout" && req.method === "POST") {
    const token = getRequestToken(req);
    // Tokens are stateless, so logout has to actively revoke: remember the
    // token until its natural expiry, and clear the browser cookie.
    if (token) revokedTokens.set(token, tokenExpiry(token) || Date.now());
    return Response.json(
      { ok: true },
      { headers: { "Set-Cookie": sessionCookie("", 0, isRequestSecure(req, url)) } },
    );
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
    if (!isSessionValid(getRequestToken(req))) {
      return jsonError("Unauthorized", 401);
    }
  }

  // API routes
  if (url.pathname === "/api/catalog/library") {
    return serveLibrary();
  }

  // On-demand per-model registry detail (tag table with size/context/input)
  const detailMatch = url.pathname.match(/^\/api\/catalog\/library\/([a-z0-9][a-z0-9._-]*)$/);
  if (detailMatch?.[1] && req.method === "GET") {
    return serveLibraryDetail(detailMatch[1]);
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
