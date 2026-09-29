// Relays one request to one backend (Ollama, Ollaya, …) and streams the
// answer back, with the header hygiene from src/backends.ts in both directions.
import { type Backend, downstreamHeaders, upstreamHeaders } from "./backends";
import { type FetchFn, jsonError, withIdleTimeout } from "./http";

// Hard cap to receive the upstream response headers. Cold-starting a large
// model can take minutes before the first byte, so this is generous.
const PROXY_CONNECT_TIMEOUT_MS = 600_000;
// Once a body is streaming (large model pulls, long chat/generate output), only
// abort if no new chunk arrives for this long — NOT after a fixed total
// duration, which would kill a large, slow-but-progressing pull.
const PROXY_IDLE_TIMEOUT_MS = 120_000;

// Upstream endpoints (Ollama and Ollaya alike) whose responses stream
// long-lived NDJSON bodies, matched against the *upstream* path. Only these
// get the idle-timeout body wrapper — everything else returns a small JSON
// body right after the headers, and wrapping it would put a JS-land stream
// pump on the dashboard's hot polling path (/api/tags, /api/ps) for no benefit.
const STREAMING_API_PATHS = new Set([
  "/api/pull",
  "/api/push",
  "/api/chat",
  "/api/generate",
  "/api/create",
]);

/**
 * `upstreamPath` is the backend's own path (e.g. "/api/tags"), already
 * validated by upstreamPathFor() or, for the legacy /api/* alias, the
 * incoming path itself.
 */
export async function forwardToBackend(
  req: Request,
  backend: Backend,
  upstreamPath: string,
  fetchFn: FetchFn = fetch,
): Promise<Response> {
  const url = new URL(req.url);
  const target = `${backend.baseUrl}${upstreamPath}${url.search}`;
  const headers = upstreamHeaders(req.headers, backend);

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
    const resp = await fetchFn(target, {
      method: req.method,
      headers,
      body: req.body,
      signal,
    });
    clearTimeout(connectDeadline);

    const proxyHeaders = downstreamHeaders(resp.headers, backend);
    proxyHeaders.set("Cache-Control", "no-store");
    const body = STREAMING_API_PATHS.has(upstreamPath)
      ? withIdleTimeout(resp.body, PROXY_IDLE_TIMEOUT_MS, () => upstreamAbort.abort())
      : resp.body;
    return new Response(body, { status: resp.status, headers: proxyHeaders });
  } catch (err: unknown) {
    clearTimeout(connectDeadline);
    if (connectTimedOut) return jsonError("Upstream request timed out", 504);
    const name = (err as { name?: string })?.name;
    if (name === "AbortError") return new Response(null, { status: 499 });
    return jsonError(`${backend.label} unreachable`);
  }
}
