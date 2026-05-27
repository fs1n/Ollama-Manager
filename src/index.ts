import { timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

const MASTER_KEY = (process.env.MASTER_KEY || "").trim();
const OLLAMA_HOST = (process.env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, "");
const OLLAMA_URL = new URL(OLLAMA_HOST);
const PORT = parseInt(process.env.PORT || "3000", 10);
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24 hours

const LITELLM_URL = (process.env.LITELLM_URL || "").trim();
const LITELLM_KEY = (process.env.LITELLM_KEY || "").trim();
const LITELLM_SYNC_INTERVAL = parseInt(process.env.LITELLM_SYNC_INTERVAL || "30", 10);
const LITELLM_ENABLED = !!(LITELLM_URL && LITELLM_KEY);

const VERSION =
  process.env.OLLAMA_MANAGER_VERSION ||
  (() => {
    try {
      const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));
      return pkg.version || "dev";
    } catch {
      return "dev";
    }
  })();

const sessions = new Map<string, number>();

// Periodic cleanup of expired sessions (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 3600_000);

type LogLevel = "info" | "warn" | "error";

function log(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta }));
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
  if (a.length !== b.length) return false;
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return timingSafeEqual(aBuf, bBuf);
}

async function forwardToOllama(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `${OLLAMA_HOST}${url.pathname}${url.search}`;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.set("host", OLLAMA_URL.host);
  // Strip browser-originated headers — the manager is the HTTP client to Ollama,
  // and Ollama's OLLAMA_ORIGINS check would reject a non-localhost Origin.
  headers.delete("origin");
  headers.delete("referer");

  try {
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body: req.body,
      signal: req.signal,
    });

    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch (err: any) {
    if (err?.name === "AbortError") throw err;
    return jsonError("Ollama unreachable");
  }
}

interface LibraryModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
}

let libraryCache: LibraryModel[] | null = null;
let libraryCacheTime = 0;
const LIBRARY_TTL = 3600_000;

async function fetchLibrary(): Promise<LibraryModel[]> {
  if (libraryCache && Date.now() - libraryCacheTime < LIBRARY_TTL) {
    return libraryCache;
  }

  const resp = await fetch("https://ollama.com/library", {
    headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const html = await resp.text();
  const models: LibraryModel[] = [];
  const cards = html.split("<li x-test-model");

  for (let i = 1; i < cards.length; i++) {
    const card = cards[i];
    const nameMatch = card.match(/href="\/library\/([^"]+)"/);
    const descMatch = card.match(/<p[^>]*class="[^"]*text-neutral-800[^"]*"[^>]*>([^<]+)<\/p>/);
    const caps: string[] = [];
    const sizes: string[] = [];

    for (const m of card.matchAll(/x-test-capability[^>]*>([^<]+)<\//g)) caps.push(m[1].trim());
    for (const m of card.matchAll(/x-test-size[^>]*>([^<]+)<\//g)) sizes.push(m[1].trim());

    if (nameMatch) {
      models.push({
        name: nameMatch[1],
        description: descMatch?.[1] || "",
        capabilities: caps,
        sizes,
      });
    }
  }

  libraryCache = models;
  libraryCacheTime = Date.now();
  return models;
}

async function serveLibrary(): Promise<Response> {
  try {
    const models = await fetchLibrary();
    return Response.json({ models, cached: Date.now() - libraryCacheTime < 5000 });
  } catch {
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
    const [ollamaData, llmData] = await Promise.all([
      fetch(`${OLLAMA_HOST}/api/tags`).then(async (r) => {
        if (!r.ok) throw new Error(`Ollama unreachable: HTTP ${r.status}`);
        return r.json();
      }),
      fetch(`${LITELLM_URL}/models`, {
        headers: { Authorization: `Bearer ${LITELLM_KEY}` },
      })
        .then(async (r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const ollamaModels: string[] = (ollamaData.models || []).map((m: any) => m.name as string);

    if (ollamaModels.length === 0) {
      result.details.push({ status: "info", message: "No models found in Ollama" });
      return result;
    }

    const existingModels = new Set<string>(
      (llmData?.data || []).map((m: any) => m.id).filter(Boolean),
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
      } catch (e: any) {
        result.failed++;
        result.details.push({
          status: "failed",
          message: `${name}: ${e.message || "Network error"}`,
        });
      }
    }
  } catch (e: any) {
    result.details.push({
      status: "failed",
      message: `Sync error: ${e.message || "Unknown error"}`,
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
    syncOllamaToLiteLLM().catch(() => {});
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
                        },
                      },
                    },
                    cached: { type: "boolean" },
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
                  properties: { status: { type: "string", example: "ok" } },
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
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui.css">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f0f0f'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23c8f060' stroke-width='2.5'/%3E%3Crect x='14.5' y='10' width='3' height='12' fill='%23c8f060' transform='rotate(25 16 16)'/%3E%3C/svg%3E">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui-bundle.js"></script>
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

Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);

    // Session status (public)
    if (url.pathname === "/api/session" && req.method === "GET") {
      const token = req.headers.get("x-session-token") || "";
      return Response.json({
        authRequired: !!MASTER_KEY,
        authenticated: MASTER_KEY ? isSessionValid(token) : true,
      });
    }

    // Login (public)
    if (url.pathname === "/api/auth" && req.method === "POST") {
      return (async () => {
        try {
          const { key } = await req.json();
          if (!key || !MASTER_KEY) return jsonError("Unauthorized", 401);
          if (!timingSafeCompare(key, MASTER_KEY)) return jsonError("Unauthorized", 401);
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
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
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
      return new Response(Bun.file("./public/index.html"));
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
      await syncOllamaToLiteLLM();
      return Response.json(getLiteLLMStatus());
    }

    return forwardToOllama(req);
  },
  error() {
    return new Response("Internal Server Error", { status: 500 });
  },
});

log("info", "Ollama Manager started", {
  port: PORT,
  ollama: OLLAMA_HOST,
  auth: !!MASTER_KEY,
  litellm: LITELLM_ENABLED,
});
if (LITELLM_ENABLED) {
  log("info", "LiteLLM sync enabled", { url: LITELLM_URL, intervalMin: LITELLM_SYNC_INTERVAL });
}
