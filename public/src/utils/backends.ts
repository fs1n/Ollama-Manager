// Pure helpers for working with several backends (Ollama, Ollaya, …) at once.
// No DOM access here, so they stay testable with plain bun:test.

export type BackendKind = "ollama" | "ollaya";

export type BackendCapability =
  | "chat"
  | "generate"
  | "embed"
  | "create-modelfile"
  | "decide"
  | "create-questions";

/** One entry of GET /api/backends */
export interface BackendInfo {
  id: string;
  kind: BackendKind;
  label: string;
  capabilities: BackendCapability[];
  status: "connected" | "unreachable";
  version: string | null;
}

/** "/tags" on backend "ollaya" → "/api/backends/ollaya/tags" */
export function backendPath(id: string, path: string): string {
  return `/api/backends/${encodeURIComponent(id)}${path.startsWith("/") ? path : `/${path}`}`;
}

// Model names can contain "/" (namespace/model), backend ids never do, so the
// first "/" is always the separator.
export function modelKey(backend: string, name: string): string {
  return `${backend}/${name}`;
}

export function parseModelKey(key: string): { backend: string; name: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  return { backend: key.slice(0, i), name: key.slice(i + 1) };
}

/**
 * /api/ps "expires_at": Ollaya sends null for "kept loaded forever" (Ollama
 * sends a far-future date instead, which we treat the same way).
 */
export function formatExpires(expiresAt: string | null | undefined, now = Date.now()): string {
  if (expiresAt === null) return "forever";
  if (!expiresAt) return "—";
  const t = new Date(expiresAt).getTime();
  if (Number.isNaN(t)) return "—";
  if (t - now > 365 * 24 * 3600_000) return "forever";
  return new Date(t).toLocaleTimeString();
}

/**
 * Human-readable error from a backend error body. Ollama sends {error};
 * Ollaya adds a machine-readable `code` and, for validation errors, `detail`
 * issues (TypeSafe's shape) — surfaced here so the user sees what was wrong.
 */
export function describeApiError(status: number, body: unknown): string {
  const b = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    code?: unknown;
    detail?: unknown;
  };
  let text = `HTTP ${status}`;
  if (typeof b.error === "string" && b.error) text += ` — ${b.error}`;
  if (typeof b.code === "string" && b.code) text += ` (${b.code})`;
  if (Array.isArray(b.detail)) {
    const msgs = b.detail
      .map((d) => {
        const issue = d as { loc?: unknown; msg?: unknown };
        if (typeof issue?.msg !== "string") return "";
        const loc = Array.isArray(issue.loc) ? issue.loc.filter((p) => p !== "body").join(".") : "";
        return loc ? `${loc}: ${issue.msg}` : issue.msg;
      })
      .filter(Boolean);
    // The top-level error usually repeats the first issue; list the rest.
    const extra = msgs.filter((m) => typeof b.error !== "string" || !b.error.includes(m));
    if (extra.length) text += ` · ${extra.join(" · ")}`;
  }
  return text;
}

export type BackendFilter = "all" | string;

export function matchesBackend(filter: BackendFilter, backend: string): boolean {
  return filter === "all" || filter === backend;
}

/** Summary for the header badge: "v0.9.0" for one backend, "Ollama v0.9.0 · Ollaya ✕" for several. */
export function statusSummary(backends: BackendInfo[]): {
  state: "connected" | "partial" | "error";
  text: string;
} {
  if (backends.length === 0) return { state: "error", text: "unreachable" };
  const up = backends.filter((b) => b.status === "connected").length;
  const state = up === backends.length ? "connected" : up === 0 ? "error" : "partial";
  const version = (b: BackendInfo) =>
    b.status !== "connected" ? "unreachable" : b.version ? `v${b.version}` : "unknown";
  const [only] = backends;
  if (backends.length === 1 && only) return { state, text: version(only) };
  return { state, text: backends.map((b) => `${b.label} ${version(b)}`).join(" · ") };
}
