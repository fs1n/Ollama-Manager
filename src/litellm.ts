// Optional background sync of the local Ollama models into a LiteLLM proxy
// (LITELLM_URL + LITELLM_KEY): registers new models as "ollama/<name>" and
// removes entries this tool created for models that no longer exist.
import type { FetchFn } from "./http";
import { log } from "./http";

interface SyncDetail {
  status: "success" | "skipped" | "failed" | "info";
  message: string;
}

export interface SyncResult {
  time: number;
  success: number;
  failed: number;
  skipped: number;
  details: SyncDetail[];
}

// The "ollama/" prefix marks entries this tool created — nothing else in
// LiteLLM is ever touched.
const PREFIX = "ollama/";

const errorText = (e: unknown) => (e instanceof Error ? e.message : "Network error");

export function createLiteLLMSync({
  url,
  key,
  intervalMin,
  ollamaHost,
  fetchFn = fetch as FetchFn,
}: {
  url: string;
  key: string;
  intervalMin: number;
  ollamaHost: string;
  fetchFn?: FetchFn;
}) {
  const enabled = !!(url && key);
  let lastSync: SyncResult | null = null;
  let inProgress = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const headers = (json = false): Record<string, string> => ({
    Authorization: `Bearer ${key}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  });

  // Best-effort reads: null on any failure, so a missing list only skips the
  // part of the sync that needs it.
  const getJson = (path: string) =>
    fetchFn(`${url}${path}`, { headers: headers() })
      .then(async (r) => (r.ok ? r.json() : null))
      .catch(() => null);

  async function post(path: string, body: unknown): Promise<Response> {
    return fetchFn(`${url}${path}`, {
      method: "POST",
      headers: headers(true),
      body: JSON.stringify(body),
    });
  }

  async function sync(): Promise<SyncResult> {
    inProgress = true;
    const result: SyncResult = { time: 0, success: 0, failed: 0, skipped: 0, details: [] };
    const push = (status: SyncDetail["status"], message: string) =>
      result.details.push({ status, message });

    try {
      const [ollamaData, llmData, llmInfoData] = await Promise.all([
        fetchFn(`${ollamaHost}/api/tags`).then(async (r) => {
          if (!r.ok) throw new Error(`Ollama unreachable: HTTP ${r.status}`);
          return r.json();
        }),
        getJson("/models"),
        // Used only for de-registration below (needs each model's internal id,
        // which /models doesn't expose). A failure just skips orphan cleanup.
        getJson("/model/info"),
      ]);

      const ollamaModels: string[] = (ollamaData.models || [])
        .map((m: { name?: string }) => m.name || "")
        .filter(Boolean);
      if (ollamaModels.length === 0) push("info", "No models found in Ollama");

      const existing = new Set<string>(
        (llmData?.data || []).map((m: { id?: string }) => m.id).filter(Boolean),
      );

      for (const name of ollamaModels) {
        const fullName = `${PREFIX}${name}`;
        if (existing.has(fullName)) {
          result.skipped++;
          push("skipped", `${name} — already registered`);
          continue;
        }
        try {
          const resp = await post("/model/new", {
            model_name: fullName,
            litellm_params: { model: fullName, api_base: ollamaHost },
          });
          if (resp.ok) {
            result.success++;
            push("success", `Registered ${name}`);
          } else {
            result.failed++;
            push("failed", `${name}: HTTP ${resp.status} — ${(await resp.text()).slice(0, 100)}`);
          }
        } catch (e) {
          result.failed++;
          push("failed", `${name}: ${errorText(e)}`);
        }
      }

      // De-registration: remove our entries for models that no longer exist in
      // Ollama, so deleted models don't leave dead routes behind.
      const current = new Set(ollamaModels.map((n) => `${PREFIX}${n}`));
      const infoList: Array<{ model_name?: string; model_info?: { id?: string } }> =
        llmInfoData?.data ?? llmInfoData ?? [];
      for (const entry of infoList) {
        const modelName = entry.model_name;
        const id = entry.model_info?.id;
        if (!modelName || !id || !modelName.startsWith(PREFIX) || current.has(modelName)) continue;
        try {
          const resp = await post("/model/delete", { id });
          if (resp.ok) {
            push("info", `Removed ${modelName} — no longer in Ollama`);
          } else {
            result.failed++;
            push("failed", `Failed to remove ${modelName}: HTTP ${resp.status}`);
          }
        } catch (e) {
          result.failed++;
          push("failed", `Failed to remove ${modelName}: ${errorText(e)}`);
        }
      }
    } catch (e) {
      push("failed", `Sync error: ${e instanceof Error ? e.message : "Unknown error"}`);
    } finally {
      inProgress = false;
      result.time = Date.now();
      lastSync = result;
    }
    return result;
  }

  return {
    enabled,
    get inProgress() {
      return inProgress;
    },
    sync,
    status() {
      return {
        enabled,
        url,
        interval: intervalMin,
        inProgress,
        lastSync: lastSync ? { ...lastSync, details: lastSync.details.slice(-50) } : null,
      };
    },
    start(): void {
      if (!enabled || intervalMin <= 0 || timer) return;
      timer = setInterval(() => {
        if (inProgress) return;
        sync().catch((e: Error) =>
          log("error", "LiteLLM scheduled sync failed", { error: e.message }),
        );
      }, intervalMin * 60_000);
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type LiteLLMSync = ReturnType<typeof createLiteLLMSync>;
