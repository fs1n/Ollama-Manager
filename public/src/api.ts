import { describeApiError } from "./utils/backends";

// Auth rides on the httpOnly om_session cookie, which same-origin fetch sends
// automatically — no token is stored or readable in JS.

// Set by pages/auth.ts's checkSession() once /api/session responds; api()
// only needs to know whether a 401 should pop the login overlay.
export let authRequired = false;
export function setAuthRequired(value: boolean): void {
  authRequired = value;
}

export function api(path: string, opts: RequestInit = {}): Promise<Response> {
  const { headers: customHeaders, ...rest } = opts;
  const headers = {
    "Content-Type": "application/json",
    ...(customHeaders as Record<string, string>),
  };
  return fetch(path, { headers, ...rest }).then((r) => {
    if (r.status === 401 && authRequired) {
      document.getElementById("login-overlay")?.classList.add("open");
    }
    return r;
  });
}

export async function httpErrorDetail(r: Response): Promise<string> {
  let body: unknown = null;
  try {
    body = await r.json();
  } catch {
    // response body wasn't JSON — fall through with just the status
  }
  return describeApiError(r.status, body);
}

// api() that throws on any non-2xx response, with the server's error detail in
// the message. Use this everywhere a non-ok response should land in the
// caller's catch block; use plain api() only where non-ok is handled specially
// (e.g. pushModel reads the body either way, refreshRunning degrades quietly).
export async function apiOk(path: string, opts?: RequestInit): Promise<Response> {
  const r = await api(path, opts);
  if (!r.ok) throw new Error(await httpErrorDetail(r));
  return r;
}

// Parses a streamed NDJSON response body (Ollama's /api/pull, /api/chat,
// /api/generate, …) one JSON object at a time as it arrives.
// T describes the lines the caller expects; they are JSON from the backend,
// so every field should be treated as optional.
export async function* readNdjsonLines<T = Record<string, unknown>>(
  response: Response,
): AsyncGenerator<T> {
  if (!response.body) return;
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += dec.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // ignore a line that isn't valid JSON (shouldn't happen, but a
        // truncated stream chunk shouldn't crash the whole read loop)
      }
    }
  }
  if (buffer.trim()) {
    try {
      yield JSON.parse(buffer);
    } catch {
      // trailing partial line, same as above
    }
  }
}
