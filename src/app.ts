// The request handler of the manager, built from a Config. No listening
// socket and no timers are created here — src/index.ts does that — so tests
// can run the complete router in-process.
//
// Routing is a table: every API route declares whether it is public or needs
// a session. The auth gate is applied from that declaration, so moving a line
// can no longer accidentally expose a route (see "Auth gate ordering" in
// CLAUDE.md).
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BACKEND_ID_RE,
  type Backend,
  backendCapabilities,
  createProbeAll,
  parseBackendRoute,
  upstreamPathFor,
} from "./backends";
import { type Catalogs, createCatalogs } from "./catalogs";
import type { Config } from "./config";
import {
  APP_CSP,
  DOCS_CSP,
  type FetchFn,
  jsonError,
  log,
  readBodyLimited,
  withSecurityHeaders,
} from "./http";
import { createLiteLLMSync, type LiteLLMSync, probeTypesafe, typesafeModelNames } from "./litellm";
import { buildOpenApiSpec, SWAGGER_HTML } from "./openapi";
import { forwardToBackend } from "./relay";
import { createSessions, isRequestSecure, sessionCookie, timingSafeCompare } from "./session";

/** The parts of Bun's Server the handler uses; optional so tests can omit it. */
export interface ServerLike {
  requestIP(req: Request): { address: string } | null;
  timeout(req: Request, seconds: number): void;
}

interface Ctx {
  req: Request;
  url: URL;
  server?: ServerLike;
  /** Regex capture groups of the matched route */
  params: string[];
}

interface Route {
  methods: string[];
  path: string | RegExp;
  access: "public" | "session";
  /**
   * Answers can take longer than Bun's 60 s idle timeout before the first
   * byte (model cold starts, a full LiteLLM sync): lift it for this request.
   */
  slow?: boolean;
  handler: (ctx: Ctx) => Response | Promise<Response>;
}

const MAX_AUTH_BODY_BYTES = 4096;

export function createApp(
  config: Config,
  deps: { fetchFn?: FetchFn; catalogs?: Catalogs; litellm?: LiteLLMSync } = {},
) {
  const fetchFn = deps.fetchFn ?? (fetch as FetchFn);
  const backends = config.backends;
  const backendsById = new Map(backends.map((b) => [b.id, b]));
  const ollama: Backend | undefined = backends.find((b) => b.kind === "ollama");
  if (!ollama) throw new Error("the Ollama backend is always configured");

  const sessions = createSessions({ masterKey: config.masterKey, trustProxy: config.trustProxy });
  const probeAll = createProbeAll(backends, { fetchFn });
  const catalogs = deps.catalogs ?? createCatalogs({ fetchFn });
  const litellm =
    deps.litellm ??
    createLiteLLMSync({
      url: config.litellm.url,
      key: config.litellm.key,
      intervalMin: config.litellm.intervalMin,
      ollamaHost: ollama.baseUrl,
      fetchFn,
    });
  const openApiSpec = buildOpenApiSpec(config.version);
  const ollaya: Backend | undefined = backends.find((b) => b.kind === "ollaya");

  // The built SPA shell, read on first use: a missing build is a clear 503
  // on page load instead of a crash at startup (API routes keep working).
  let staticHtml: string | null = null;
  function spaShell(): Response {
    try {
      staticHtml ??= readFileSync(path.join(config.publicDir, "index.html"), "utf-8");
    } catch {
      return jsonError("Frontend not built — run `bun run build:web`", 503);
    }
    return new Response(staticHtml, {
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    });
  }

  async function serveStatic(url: URL): Promise<Response> {
    if (url.pathname === "/") return spaShell();
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname);
    } catch {
      return jsonError("Bad request path", 400);
    }
    // Serve real sub-resources (CSS/JS/images) as-is; anything else falls
    // through to the SPA shell (the frontend has hash-based routes).
    const filePath = path.join(config.publicDir, decoded);
    if (filePath.startsWith(`${config.publicDir}${path.sep}`)) {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, { headers: { "Cache-Control": "no-store" } });
      }
    }
    return spaShell();
  }

  function serveBackendRoute(req: Request, id: string, rest: string): Promise<Response> | Response {
    const backend = BACKEND_ID_RE.test(id) ? backendsById.get(id) : undefined;
    if (!backend) return jsonError("Unknown backend", 404);
    const upstreamPath = upstreamPathFor(backend.kind, rest);
    if (!upstreamPath) return jsonError(`Not available on ${backend.label}`, 404);
    return forwardToBackend(req, backend, upstreamPath, fetchFn);
  }

  async function login({ req, url, server }: Ctx): Promise<Response> {
    const ip = sessions.clientIp(req, server?.requestIP(req)?.address);
    // Checked before anything is read: a limited client costs nothing.
    if (ip !== "unknown" && sessions.isRateLimited(ip)) {
      return jsonError("Too many attempts, try again later", 429);
    }
    if (!sessions.authRequired) return jsonError("Unauthorized", 401);
    // Every failed attempt counts, whatever made it fail — otherwise a client
    // could send malformed bodies forever without ever hitting the limit.
    const fail = (message: string, status: number) => {
      sessions.recordFailure(ip);
      return jsonError(message, status);
    };
    const text = await readBodyLimited(req, MAX_AUTH_BODY_BYTES);
    if (text === null) return fail("Request body too large", 413);
    let key: unknown;
    try {
      key = (JSON.parse(text) as { key?: unknown } | null)?.key;
    } catch {
      return fail("Invalid request", 400);
    }
    if (!sessions.checkKey(key)) return fail("Unauthorized", 401);

    sessions.clearFailures(ip);
    const { token, expires } = sessions.create();
    // Browser clients get the token as an httpOnly cookie (unreadable from
    // JS); it's also returned in the body for programmatic API clients that
    // authenticate via the x-session-token header instead.
    return Response.json(
      { token, expires },
      {
        headers: {
          "Set-Cookie": sessionCookie(
            token,
            sessions.ttlSeconds,
            isRequestSecure(req, url, config.trustProxy),
          ),
        },
      },
    );
  }

  // The TypeSafe gateway: the only way into Ollaya that the manager offers to
  // machines (LiteLLM's /typesafe pass-through) instead of browsers. It has its
  // own key and exactly the three decision endpoints — never pull, delete or
  // create, which LiteLLM would otherwise relay to anyone with a LiteLLM key.
  function serveTypesafe({ req, server, params }: Ctx): Promise<Response> | Response {
    if (!config.typesafeKey || !ollaya) return jsonError("TypeSafe gateway not configured", 404);
    const ip = sessions.clientIp(req, server?.requestIP(req)?.address);
    if (ip !== "unknown" && sessions.isRateLimited(ip)) {
      return jsonError("Too many attempts, try again later", 429);
    }
    const auth = req.headers.get("authorization") || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!token || !timingSafeCompare(token, config.typesafeKey)) {
      sessions.recordFailure(ip);
      return jsonError("Unauthorized", 401, { "WWW-Authenticate": "Bearer" });
    }
    return forwardToBackend(req, ollaya, `/v1/${params[0]}`, fetchFn);
  }

  async function ollayaStatus(): Promise<Response> {
    if (!ollaya) return jsonError("No Ollaya backend configured", 404);
    let ollayaModels: string[] = [];
    try {
      const r = await fetchFn(`${ollaya.baseUrl}/v1/models`, {
        headers: ollaya.apiKey ? { Authorization: `Bearer ${ollaya.apiKey}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (r.ok) ollayaModels = typesafeModelNames(await r.json());
    } catch {
      // Ollaya down: LiteLLM can't be matched against it, reported as such below
    }
    const status = await probeTypesafe({
      litellmUrl: config.litellm.url,
      litellmKey: config.litellm.key,
      ollayaModels,
      fetchFn,
    });
    return Response.json(
      { ...status, gatewayEnabled: !!config.typesafeKey, gatewayPath: "/api/typesafe" },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const routes: Route[] = [
    {
      methods: ["GET"],
      path: "/api/session",
      access: "public",
      handler: ({ req }) =>
        Response.json(
          {
            authRequired: sessions.authRequired,
            authenticated: sessions.isAuthorized(req),
          },
          { headers: { "Cache-Control": "no-store" } },
        ),
    },
    { methods: ["POST"], path: "/api/auth", access: "public", handler: login },
    {
      methods: ["POST"],
      path: "/api/logout",
      access: "public",
      handler: ({ req, url }) => {
        sessions.revoke(sessions.getRequestToken(req));
        return Response.json(
          { ok: true },
          {
            headers: {
              "Set-Cookie": sessionCookie("", 0, isRequestSecure(req, url, config.trustProxy)),
            },
          },
        );
      },
    },
    {
      methods: ["GET"],
      path: "/api/app-version",
      access: "public",
      handler: () => Response.json({ version: config.version }),
    },
    {
      // Public for Docker HEALTHCHECK: always 200 while the manager runs.
      // Versions and the backend inventory are only shown with a session (or
      // when auth is off) — the same data /api/backends keeps behind the gate.
      methods: ["GET", "HEAD"],
      path: "/health",
      access: "public",
      handler: async ({ req }) => {
        const statuses = await probeAll();
        const ollamaStatus = statuses.find((s) => s.id === ollama.id);
        for (const s of statuses) {
          if (s.status !== "connected")
            log("warn", "Health check upstream probe failed", { id: s.id });
        }
        const body: Record<string, unknown> = {
          status: "ok",
          ollama: ollamaStatus?.status ?? "unreachable",
        };
        if (sessions.isAuthorized(req)) {
          body.ollamaVersion = ollamaStatus?.version ?? null;
          body.backends = statuses;
        }
        return Response.json(body, { headers: { "Cache-Control": "no-store" } });
      },
    },
    {
      methods: ["GET"],
      path: "/api/openapi.json",
      access: "public",
      handler: () => Response.json(openApiSpec),
    },
    {
      methods: ["GET"],
      path: "/api/docs",
      access: "public",
      handler: () =>
        new Response(SWAGGER_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
    },
    {
      methods: ["GET"],
      path: "/api/backends",
      access: "session",
      handler: async () => {
        const statuses = await probeAll();
        return Response.json(
          {
            backends: backends.map((b, i) => ({
              id: b.id,
              kind: b.kind,
              label: b.label,
              capabilities: backendCapabilities(b.kind),
              status: statuses[i]?.status ?? "unreachable",
              version: statuses[i]?.version ?? null,
            })),
          },
          { headers: { "Cache-Control": "no-store" } },
        );
      },
    },
    {
      methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      path: /^\/api\/backends\/([^/]+)\/(.+)$/,
      access: "session",
      slow: true,
      handler: ({ req, url }) => {
        const route = parseBackendRoute(url.pathname);
        if (!route) return jsonError("Not found", 404);
        return serveBackendRoute(req, route.id, route.rest);
      },
    },
    {
      methods: ["GET"],
      path: "/api/catalog/ollaya",
      access: "session",
      handler: () => catalogs.serveOllayaCatalog(),
    },
    {
      methods: ["GET"],
      path: "/api/catalog/library",
      access: "session",
      handler: () => catalogs.serveLibrary(),
    },
    {
      methods: ["GET"],
      path: /^\/api\/catalog\/library\/([^/]+)$/,
      access: "session",
      handler: ({ params }) => catalogs.serveLibraryDetail(params[0] ?? ""),
    },
    {
      // Own bearer auth (OLLAYA_TYPESAFE_KEY), not the manager session: the
      // caller is LiteLLM, not a browser.
      methods: ["GET", "POST"],
      path: /^\/api\/typesafe\/v1\/(systemone|decisions|models)$/,
      access: "public",
      slow: true,
      handler: serveTypesafe,
    },
    {
      methods: ["GET"],
      path: "/api/litellm/ollaya-status",
      access: "session",
      handler: ollayaStatus,
    },
    {
      methods: ["GET"],
      path: "/api/litellm/status",
      access: "session",
      handler: () => Response.json(litellm.status()),
    },
    {
      methods: ["POST"],
      path: "/api/litellm/sync",
      access: "session",
      slow: true,
      handler: async () => {
        if (!litellm.enabled) return jsonError("LiteLLM sync not configured", 400);
        // An honest 409 instead of handing back a stale result while one runs.
        if (litellm.inProgress) return jsonError("Sync already in progress", 409);
        await litellm.sync();
        return Response.json(litellm.status());
      },
    },
  ];

  function matchRoute(pathname: string): { route: Route; params: string[] }[] {
    const found: { route: Route; params: string[] }[] = [];
    for (const route of routes) {
      if (typeof route.path === "string") {
        if (route.path === pathname) found.push({ route, params: [] });
      } else {
        const m = pathname.match(route.path);
        if (m) found.push({ route, params: m.slice(1) });
      }
    }
    return found;
  }

  async function dispatch(req: Request, server?: ServerLike): Promise<Response> {
    // Bun hands us req.url with "." and ".." segments already resolved (as
    // browsers and curl do before sending), so /api/backends/x/../../tags *is*
    // /api/tags by the time it gets here — and is routed and gated as such.
    const url = new URL(req.url);

    const matches = matchRoute(url.pathname);
    if (matches.length > 0) {
      const needsSession = matches.some((m) => m.route.access === "session");
      if (needsSession && !sessions.isAuthorized(req)) return jsonError("Unauthorized", 401);
      const hit = matches.find((m) => m.route.methods.includes(req.method));
      if (!hit) {
        const allow = [...new Set(matches.flatMap((m) => m.route.methods))].join(", ");
        return jsonError("Method not allowed", 405, { Allow: allow });
      }
      if (hit.route.slow) server?.timeout(req, 0);
      return hit.route.handler({ req, url, server, params: hit.params });
    }

    // Static files and the SPA shell are public: the frontend shows the login.
    if (!url.pathname.startsWith("/api/")) return serveStatic(url);

    // Everything else under /api/ needs a session from here on.
    if (!sessions.isAuthorized(req)) return jsonError("Unauthorized", 401);

    // Unknown paths below the manager's own namespaces are not Ollama's.
    if (
      url.pathname.startsWith("/api/backends/") ||
      url.pathname.startsWith("/api/catalog/") ||
      url.pathname.startsWith("/api/typesafe/")
    ) {
      return jsonError("Not found", 404);
    }

    // Legacy alias: the original un-prefixed /api/* routes keep relaying to
    // Ollama for existing API clients (deprecated in favor of
    // /api/backends/ollama/*, which the web UI uses).
    server?.timeout(req, 0);
    return forwardToBackend(req, ollama as Backend, url.pathname, fetchFn);
  }

  return {
    /** Bun.serve fetch handler: routing plus security headers on every answer. */
    async fetch(req: Request, server?: ServerLike): Promise<Response> {
      let resp: Response;
      try {
        resp = await dispatch(req, server);
      } catch (err) {
        log("error", "Unhandled request error", { error: String(err) });
        resp = jsonError("Internal Server Error", 500);
      }
      const isDocs = new URL(req.url).pathname === "/api/docs";
      return withSecurityHeaders(resp, isDocs ? DOCS_CSP : APP_CSP);
    },

    /** Starts the periodic work: LiteLLM sync and the hourly memory sweep. */
    start(): () => void {
      litellm.start();
      const sweep = setInterval(() => {
        sessions.sweep();
        catalogs.sweep();
      }, 3600_000);
      return () => {
        litellm.stop();
        clearInterval(sweep);
      };
    },

    sessions,
    catalogs,
    litellm,
  };
}

export type App = ReturnType<typeof createApp>;
