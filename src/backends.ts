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
 * Normalizes a host setting the way Ollaya's own OLLAYA_HOST does: "http://" is
 * assumed without a scheme, and a missing port means 11435 for http (443 for
 * https, which URL already implies). Returns the URL without a trailing slash.
 */
export function normalizeHost(raw: string, defaultPort: number): string {
  const trimmed = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(withScheme);
  if (!url.port && url.protocol === "http:") url.port = String(defaultPort);
  return url.toString().replace(/\/+$/, "");
}

export function loadBackends(env: Record<string, string | undefined>): Backend[] {
  const backends: Backend[] = [
    {
      id: "ollama",
      kind: "ollama",
      label: "Ollama",
      baseUrl: (env.OLLAMA_HOST || "http://localhost:11434").replace(/\/$/, ""),
    },
  ];

  const ollayaHost = (env.OLLAYA_HOST || "").trim();
  if (ollayaHost) {
    const apiKey = (env.OLLAYA_API_KEY || "").trim();
    backends.push({
      id: "ollaya",
      kind: "ollaya",
      label: "Ollaya",
      baseUrl: normalizeHost(ollayaHost, 11435),
      ...(apiKey ? { apiKey } : {}),
    });
  }

  return backends;
}

/**
 * Headers for the upstream request. The manager is the HTTP client here, so
 * browser-originated headers go: Origin/Referer would trip the backends' origin
 * checks, and the manager's own session (cookie or x-session-token) must never
 * leak to a service that has no use for it. For a backend with an API key the
 * caller's Authorization is replaced by the server-side key.
 */
export function upstreamHeaders(incoming: Headers, backend: Backend): Headers {
  const headers = new Headers(incoming);
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
