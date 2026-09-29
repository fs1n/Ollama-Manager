import { apiOk } from "../api";
import type { BackendCapability, BackendInfo, BackendKind } from "../utils/backends";

// The backends the server relays to (GET /api/backends), with their live
// status. Loaded on connect() and refreshed by the dashboard; every page that
// talks to a backend reads it from here.
let backends: BackendInfo[] = [];

export async function loadBackends(): Promise<BackendInfo[]> {
  const r = await apiOk("/api/backends");
  const d = await r.json();
  backends = d.backends || [];
  return backends;
}

// Pages can be opened before connect() finishes; make sure the list exists.
export async function ensureBackends(): Promise<BackendInfo[]> {
  if (backends.length) return backends;
  try {
    return await loadBackends();
  } catch {
    return backends;
  }
}

export function getBackends(): BackendInfo[] {
  return backends;
}

export function getBackend(id: string): BackendInfo | undefined {
  return backends.find((b) => b.id === id);
}

export function backendsWith(cap: BackendCapability): BackendInfo[] {
  return backends.filter((b) => b.capabilities.includes(cap));
}

export function firstBackendOfKind(kind: BackendKind): BackendInfo | undefined {
  return backends.find((b) => b.kind === kind);
}

export function hasMultipleBackends(): boolean {
  return backends.length > 1;
}

export function backendLabel(id: string): string {
  return getBackend(id)?.label ?? id;
}
