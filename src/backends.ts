// Backend registry: every model server the manager talks to (Ollama, Ollaya, …)
// is one entry here, and the web UI addresses each of them the same way:
//
//   /api/backends/{id}/{path}     → {baseUrl}/api/{path}
//   /api/backends/{id}/v1/{path}  → {baseUrl}/v1/{path}   (only where allowed)
//
// The manager has to relay these requests because the browser cannot reach the
// backends itself: they usually listen on the server's localhost, reject foreign
// Origins, and their credentials (OLLAYA_API_KEY) must stay server-side.

export type BackendKind = "ollama" | "ollaya";

export type BackendCapability =
  | "chat"
  | "generate"
  | "embed"
  | "create-modelfile"
  | "decide"
  | "create-questions";

export interface Backend {
  /** Stable, URL-safe id used in /api/backends/{id}/… */
  id: string;
  kind: BackendKind;
  label: string;
  /** Upstream base URL without a trailing slash */
  baseUrl: string;
  /** Bearer token sent upstream; never exposed to the browser */
  apiKey?: string;
}

export const BACKEND_ID_RE = /^[a-z0-9-]+$/;

const CAPABILITIES: Record<BackendKind, BackendCapability[]> = {
  ollama: ["chat", "generate", "embed", "create-modelfile"],
  ollaya: ["decide", "create-questions"],
};

export function backendCapabilities(kind: BackendKind): BackendCapability[] {
  return [...CAPABILITIES[kind]];
}

// Ollaya's documented API surface (docs/api.md §1). Anything else is refused
// before it reaches the daemon, so the manager never exposes more than the
// contract promises. Reserved endpoints (push, blobs) are left out on purpose.
const OLLAYA_API_PATHS = new Set([
  "version",
  "tags",
  "ps",
  "show",
  "pull",
  "delete",
  "copy",
  "create",
  "decide",
]);
const OLLAYA_V1_PATHS = new Set(["systemone", "decisions", "models"]);

// A path segment as Ollama/Ollaya use them (e.g. "blobs/sha256:abc…"). Rejecting
// everything else — "%", "..", empty segments — rules out path traversal and
// double-encoding tricks before the path is glued onto the upstream URL.
const SEGMENT_RE = /^[A-Za-z0-9_:-][A-Za-z0-9._:-]*$/;

/**
 * Maps the part after /api/backends/{id}/ to the upstream path, or returns null
 * when the path is not allowed for this backend kind.
 */
export function upstreamPathFor(kind: BackendKind, rest: string): string | null {
  const segments = rest.split("/");
  if (segments.length === 0 || !segments.every((s) => SEGMENT_RE.test(s))) return null;

  if (segments[0] === "v1") {
    // Ollama's own OpenAI-compatible /v1 is not relayed (the manager never has);
    // Ollaya's TypeSafe-compatible /v1 is, for its three documented endpoints.
    if (kind !== "ollaya") return null;
    const v1 = segments.slice(1).join("/");
    return OLLAYA_V1_PATHS.has(v1) ? `/v1/${v1}` : null;
  }

  if (kind === "ollaya" && !OLLAYA_API_PATHS.has(rest)) return null;
  return `/api/${rest}`;
}

/** Splits "/api/backends/{id}/{rest}" into its parts; null for any other path. */
export function parseBackendRoute(pathname: string): { id: string; rest: string } | null {
  const match = pathname.match(/^\/api\/backends\/([^/]+)\/(.+)$/);
  if (!match?.[1] || !match[2]) return null;
  return { id: match[1], rest: match[2] };
}

/**
 * Validates and normalizes a host setting. "http://" is assumed without a
 * scheme; only http and https are accepted. With `defaultPort`, a missing port
 * on http means that port (Ollaya's OLLAYA_HOST behavior: 11435). A path is
 * kept as a prefix; query and fragment are refused because every relayed path
 * is appended to the result. Errors name the variable so a typo in the
 * environment is obvious at startup.
 */
export function normalizeHost(raw: string, variable: string, defaultPort?: number): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new Error(`${variable}=${JSON.stringify(raw)} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${variable}=${JSON.stringify(raw)} must use http:// or https://`);
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error(
      `${variable}=${JSON.stringify(raw)} must not contain a query, fragment or credentials`,
    );
  }
  if (defaultPort && !url.port && url.protocol === "http:") url.port = String(defaultPort);
  return url.toString().replace(/\/+$/, "");
}

export function loadBackends(env: Record<string, string | undefined>): Backend[] {
  const backends: Backend[] = [
    {
      id: "ollama",
      kind: "ollama",
      label: "Ollama",
      // No default port here: OLLAMA_HOST has always been taken literally, and
      // e.g. an Ollama behind a reverse proxy on port 80 must keep working.
      baseUrl: normalizeHost(env.OLLAMA_HOST || "http://localhost:11434", "OLLAMA_HOST"),
    },
  ];

  const ollayaHost = (env.OLLAYA_HOST || "").trim();
  if (ollayaHost) {
    const apiKey = (env.OLLAYA_API_KEY || "").trim();
    backends.push({
      id: "ollaya",
      kind: "ollaya",
      label: "Ollaya",
      baseUrl: normalizeHost(ollayaHost, "OLLAYA_HOST", 11435),
      ...(apiKey ? { apiKey } : {}),
    });
  }

  return backends;
}

// Hop-by-hop headers (RFC 9110 §7.6.1) describe one connection, never the
// next one: the manager's connection to the backend is its own. Plus the
// forwarding family, which the manager has not verified and must not vouch for.
const HOP_BY_HOP = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
const FORWARDING = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

function stripHopByHop(headers: Headers): void {
  // Names listed in Connection are hop-by-hop too (e.g. "Connection: x-foo").
  for (const name of (headers.get("connection") || "").split(",")) {
    const n = name.trim().toLowerCase();
    if (n) headers.delete(n);
  }
  for (const name of HOP_BY_HOP) headers.delete(name);
}

/**
 * Headers for the upstream request. The manager is the HTTP client here, so
 * browser-originated headers go: Origin/Referer would trip the backends' origin
 * checks, and the manager's own session (cookie or x-session-token) must never
 * leak to a service that has no use for it. Hop-by-hop and forwarding headers
 * are dropped as well. For a backend with an API key the caller's
 * Authorization is replaced by the server-side key.
 */
export function upstreamHeaders(incoming: Headers, backend: Backend): Headers {
  const headers = new Headers(incoming);
  stripHopByHop(headers);
  for (const name of FORWARDING) headers.delete(name);
  headers.set("host", new URL(backend.baseUrl).host);
  headers.delete("origin");
  headers.delete("referer");
  headers.delete("cookie");
  headers.delete("x-session-token");
  if (backend.kind === "ollaya") {
    headers.delete("authorization");
    if (backend.apiKey) headers.set("authorization", `Bearer ${backend.apiKey}`);
  }
  return headers;
}

/**
 * Headers for the response relayed back to the browser. A backend must not be
 * able to set cookies on the manager's origin, hop-by-hop headers belong to
 * the upstream connection, and no header may carry the backend's API key back
 * (e.g. an endpoint that echoes request headers).
 */
export function downstreamHeaders(incoming: Headers, backend: Backend): Headers {
  const headers = new Headers(incoming);
  stripHopByHop(headers);
  headers.delete("set-cookie");
  if (backend.apiKey) {
    const key = backend.apiKey;
    for (const [name, value] of [...headers]) {
      if (value.includes(key)) headers.delete(name);
    }
  }
  return headers;
}

/** Headers for requests the manager itself makes to a backend (probes, sync). */
export function authHeaders(backend: Backend): Record<string, string> {
  return backend.apiKey ? { Authorization: `Bearer ${backend.apiKey}` } : {};
}

export interface BackendStatus {
  status: "connected" | "unreachable";
  version: string | null;
}

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export async function probeBackend(
  backend: Backend,
  fetchFn: FetchFn = fetch,
  timeoutMs = 2_000,
): Promise<BackendStatus> {
  try {
    const r = await fetchFn(`${backend.baseUrl}/api/version`, {
      headers: authHeaders(backend),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) return { status: "unreachable", version: null };
    const d = (await r.json()) as { version?: string };
    return { status: "connected", version: d.version ?? null };
  } catch {
    return { status: "unreachable", version: null };
  }
}

/**
 * Probes every backend, sharing one in-flight probe and caching the result
 * for `ttlMs`. /health and /api/backends both use it, so a burst of requests
 * costs one probe per backend instead of one per request.
 */
export function createProbeAll(
  backends: Backend[],
  { ttlMs = 5_000, fetchFn = fetch as FetchFn } = {},
): () => Promise<(BackendStatus & { id: string })[]> {
  let cached: { at: number; value: (BackendStatus & { id: string })[] } | null = null;
  let inflight: Promise<(BackendStatus & { id: string })[]> | null = null;
  return () => {
    if (cached && Date.now() - cached.at < ttlMs) return Promise.resolve(cached.value);
    if (!inflight) {
      inflight = Promise.all(backends.map((b) => probeBackend(b, fetchFn)))
        .then((statuses) => {
          const value = backends.map((b, i) => ({
            id: b.id,
            ...(statuses[i] ?? { status: "unreachable" as const, version: null }),
          }));
          cached = { at: Date.now(), value };
          return value;
        })
        .finally(() => {
          inflight = null;
        });
    }
    return inflight;
  };
}
