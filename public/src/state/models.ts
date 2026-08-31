import { api, apiOk } from "../api";
import { escHtml } from "../utils/format";

export interface OllamaModelDetails {
  parameter_size?: string;
  quantization_level?: string;
  family?: string;
  families?: string[];
  context_length?: number;
}

export interface OllamaModel {
  name: string;
  size?: number;
  size_vram?: number;
  expires_at?: string;
  modified_at?: string;
  details?: OllamaModelDetails;
}

// Shared across Models, Running, Chat/Generate/Embeddings and Catalog pages —
// all of them read the installed-model list, so it lives here rather than
// inside any one page module.
export let modelCache: OllamaModel[] = [];
export let runningNames: Set<string> = new Set();

let modelsPromise: Promise<OllamaModel[]> | null = null;

// ES module bindings are read-only from the importer's side, so a page that
// already has the fetched list in hand (loadDashboard fetches /api/tags and
// /api/ps together, rather than going through fetchModels()) sets it back
// through this rather than assigning the imported binding directly.
export function setModelCache(models: OllamaModel[]): void {
  modelCache = models;
}

export async function fetchModels(): Promise<OllamaModel[]> {
  const r = await apiOk("/api/tags");
  const d = await r.json();
  modelCache = d.models || [];
  return modelCache;
}

export async function ensureModels(): Promise<void> {
  if (modelCache.length) return;
  if (!modelsPromise) modelsPromise = fetchModels().catch(() => modelCache);
  await modelsPromise;
}

// Best-effort: a failed /api/ps degrades to "nothing running" rather than
// throwing, since callers (Running page, Catalog running-dot/filter) treat an
// empty list as a normal state, not an error.
export async function refreshRunning(): Promise<OllamaModel[]> {
  try {
    const r = await api("/api/ps");
    if (r.ok) {
      const d = await r.json();
      const models: OllamaModel[] = d.models || [];
      runningNames = new Set(models.map((m) => m.name));
      return models;
    }
  } catch {
    // network error — degrade quietly, same as refreshRunning's original behavior
  }
  return [];
}

// loadDashboard() fetches /api/ps itself (alongside /api/tags, in parallel)
// rather than calling refreshRunning() — this keeps that Set in sync either way.
export function setRunningNames(names: Set<string>): void {
  runningNames = names;
}

let lastModelCacheKey = "";
const MODEL_SELECT_IDS = ["chat-model", "gen-model", "embed-model"];

// Keyed by name, not just count — deleting one model and pulling another
// (count unchanged) must still refresh the dropdowns, otherwise they can keep
// offering a model that was just deleted.
export function populateModelSelects(): void {
  const key = modelCache.map((m) => m.name).join("\n");
  if (key === lastModelCacheKey) return;
  lastModelCacheKey = key;
  for (const id of MODEL_SELECT_IDS) {
    const sel = document.getElementById(id) as HTMLSelectElement | null;
    if (!sel) continue;
    const cur = sel.value;
    sel.innerHTML = modelCache.length
      ? modelCache
          .map((m) => `<option value="${escHtml(m.name)}">${escHtml(m.name)}</option>`)
          .join("")
      : '<option value="">— no models —</option>';
    if (cur) sel.value = cur;
  }
}
