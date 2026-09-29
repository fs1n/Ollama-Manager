import { api, apiOk } from "../api";
import { type BackendCapability, backendPath, modelKey } from "../utils/backends";
import { escHtml } from "../utils/format";
import { backendsWith, ensureBackends, getBackend, hasMultipleBackends } from "./backends";

export interface OllamaModelDetails {
  parameter_size?: string;
  quantization_level?: string;
  family?: string;
  families?: string[];
  context_length?: number;
  /** Ollaya: "onnx", "gguf" or "router" */
  format?: string;
}

export interface OllamaModel {
  name: string;
  size?: number;
  size_vram?: number;
  /** Ollaya sends null for "kept loaded forever" */
  expires_at?: string | null;
  modified_at?: string;
  details?: OllamaModelDetails;
  /** Ollaya /api/ps: "cpu", "cuda:0", "metal", … */
  device?: string;
  context_length?: number;
}

/** A model together with the backend it lives on. */
export interface BackendModel extends OllamaModel {
  backend: string;
  /** `${backend}/${name}` — unique across backends */
  key: string;
}

// Shared across Models, Running, Chat/Generate/Embeddings and Catalog pages —
// all of them read the installed-model list, so it lives here rather than
// inside any one page module. It aggregates every backend.
export let modelCache: BackendModel[] = [];
export let runningKeys: Set<string> = new Set();
/** Last error per backend id from the most recent tags/ps fetch */
export const backendErrors = new Map<string, string>();

let modelsPromise: Promise<BackendModel[]> | null = null;

// Fetches the same endpoint from every backend in parallel. A backend that
// fails only records an error; the others' results are still returned.
async function fetchFromAll(path: string, strict: boolean): Promise<BackendModel[]> {
  const list = await ensureBackends();
  const results = await Promise.allSettled(
    list.map(async (b) => {
      const url = backendPath(b.id, path);
      const r = strict ? await apiOk(url) : await api(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      return ((d.models || []) as OllamaModel[]).map(
        (m): BackendModel => ({ ...m, backend: b.id, key: modelKey(b.id, m.name) }),
      );
    }),
  );
  const out: BackendModel[] = [];
  results.forEach((res, i) => {
    const id = list[i]?.id;
    if (!id) return;
    if (res.status === "fulfilled") {
      backendErrors.delete(id);
      out.push(...res.value);
    } else {
      backendErrors.set(id, res.reason instanceof Error ? res.reason.message : String(res.reason));
    }
  });
  return out;
}

export async function fetchModels(): Promise<BackendModel[]> {
  modelCache = await fetchFromAll("/tags", true);
  return modelCache;
}

export async function ensureModels(): Promise<void> {
  if (modelCache.length) return;
  if (!modelsPromise) {
    modelsPromise = fetchModels()
      .catch(() => modelCache)
      .finally(() => {
        modelsPromise = null;
      });
  }
  await modelsPromise;
}

// Best-effort: a failed /ps degrades to "nothing running" for that backend
// rather than throwing, since callers (Running page, Catalog running-dot/filter)
// treat an empty list as a normal state, not an error.
export async function refreshRunning(): Promise<BackendModel[]> {
  try {
    const models = await fetchFromAll("/ps", false);
    runningKeys = new Set(models.map((m) => m.key));
    return models;
  } catch {
    return [];
  }
}

export function modelsOnBackend(backend: string): BackendModel[] {
  return modelCache.filter((m) => m.backend === backend);
}

let lastModelCacheKey = "";
const MODEL_SELECTS: [string, BackendCapability][] = [
  ["chat-model", "chat"],
  ["gen-model", "generate"],
  ["embed-model", "embed"],
];

// Keyed by model key, not just count — deleting one model and pulling another
// (count unchanged) must still refresh the dropdowns, otherwise they can keep
// offering a model that was just deleted. Each dropdown only offers models from
// backends that support that page (chat/generate/embed are Ollama-only).
export function populateModelSelects(): void {
  const key = modelCache.map((m) => m.key).join("\n");
  if (key === lastModelCacheKey) return;
  lastModelCacheKey = key;
  const showBackend = hasMultipleBackends();
  for (const [id, cap] of MODEL_SELECTS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel) continue;
    const allowed = new Set(backendsWith(cap).map((b) => b.id));
    const models = modelCache.filter((m) => allowed.has(m.backend));
    const cur = sel.value;
    sel.innerHTML = models.length
      ? models
          .map((m) => {
            const suffix = showBackend ? ` · ${getBackend(m.backend)?.label ?? m.backend}` : "";
            return `<option value="${escHtml(m.key)}">${escHtml(m.name + suffix)}</option>`;
          })
          .join("")
      : '<option value="">— no models —</option>';
    if (cur) sel.value = cur;
  }
}
