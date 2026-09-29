import { api, apiOk, readNdjsonLines } from "../api";
import { navigateTo } from "../nav";
import { backendLabel, ensureBackends, getBackend } from "../state/backends";
import { type BackendModel, fetchModels, modelCache, refreshRunning } from "../state/models";
import {
  backendBadge,
  backendErrorBanner,
  backendFilterChips,
  fillBackendSelect,
  getBackendFilter,
  setBackendFilter,
} from "../ui/backend";
import { showConfirm } from "../ui/confirm";
import { openModal } from "../ui/modal";
import { toast } from "../ui/toast";
import { backendPath, formatExpires, matchesBackend, parseModelKey } from "../utils/backends";
import { escHtml, fmtSize } from "../utils/format";

function skeletonModelCards(n = 6): string {
  return `<div class="model-grid">${Array.from(
    { length: n },
    () => `
    <div class="skeleton-card">
      <div class="skeleton-line" style="height:14px;width:60%;margin-bottom:12px"></div>
      <div style="display:flex;gap:6px;margin-bottom:12px">
        <div class="skeleton-line" style="height:20px;width:55px"></div>
        <div class="skeleton-line" style="height:20px;width:40px"></div>
        <div class="skeleton-line" style="height:20px;width:48px"></div>
      </div>
      <div style="display:flex;gap:8px">
        <div class="skeleton-line" style="height:28px;flex:1"></div>
        <div class="skeleton-line" style="height:28px;flex:1"></div>
      </div>
    </div>`,
  ).join("")}</div>`;
}

function skeletonTableRows(n = 3): string {
  return `<div class="table-wrap"><table>
    <thead><tr><th>Model</th><th>Size</th><th>VRAM</th><th>Expires</th></tr></thead>
    <tbody>${Array.from(
      { length: n },
      () => `<tr>
      <td><div class="skeleton-line" style="height:12px;width:140px"></div></td>
      <td><div class="skeleton-line" style="height:12px;width:60px"></div></td>
      <td><div class="skeleton-line" style="height:12px;width:60px"></div></td>
      <td><div class="skeleton-line" style="height:12px;width:80px"></div></td>
    </tr>`,
    ).join("")}</tbody>
  </table></div>`;
}

function modelCard(m: BackendModel): string {
  const d = m.details || {};
  const isRouter = d.format === "router";
  const key = escHtml(m.key);
  return `
      <div class="model-card">
        <div class="model-name">
          <span>${escHtml(m.name)}</span>
          ${d.parameter_size ? `<span style="color:var(--accent);font-size:11px">${escHtml(d.parameter_size)}</span>` : ""}
        </div>
        <div class="model-meta">
          ${backendBadge(m.backend)}
          ${d.format ? `<span class="badge" title="${isRouter ? "Routes each request to one of its target models" : "Model format"}">${escHtml(d.format)}</span>` : ""}
          ${d.quantization_level ? `<span class="badge" style="background:rgba(200,240,96,0.08);color:var(--accent);border-color:rgba(200,240,96,0.2)">${escHtml(d.quantization_level)}</span>` : ""}
          <span class="badge">${fmtSize(m.size || 0)}</span>
        </div>
        <div class="model-actions">
          <button class="btn btn-sm" data-action="info" data-key="${key}"><i class="ti ti-info-circle" aria-hidden="true"></i> Info</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-key="${key}"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>
        </div>
      </div>`;
}

export async function loadModels(): Promise<void> {
  const wrap = document.getElementById("model-grid-wrap") as HTMLElement;
  wrap.innerHTML = skeletonModelCards(6);
  try {
    await ensureBackends();
    const all = await fetchModels();
    const filter = getBackendFilter();
    const models = all.filter((m) => matchesBackend(filter, m.backend));
    const head = backendErrorBanner() + backendFilterChips();
    if (models.length === 0) {
      wrap.innerHTML = `${head}<div class="empty"><i class="ti ti-box" aria-hidden="true"></i>No models found.<br><button class="btn btn-primary" style="margin-top:12px" data-action="goto-pull"><i class="ti ti-download" aria-hidden="true"></i> Pull your first model</button></div>`;
      return;
    }
    wrap.innerHTML = `${head}<div class="model-grid">${models.map(modelCard).join("")}</div>`;
  } catch {
    toast("Failed to load models", "error");
  }
}

export async function loadRunning(): Promise<void> {
  const wrap = document.getElementById("running-wrap") as HTMLElement;
  wrap.innerHTML = skeletonTableRows(3);
  try {
    await ensureBackends();
    const filter = getBackendFilter();
    const models = (await refreshRunning()).filter((m) => matchesBackend(filter, m.backend));
    const head = backendErrorBanner() + backendFilterChips();
    if (models.length === 0) {
      wrap.innerHTML = `${head}<div class="empty"><i class="ti ti-player-pause" aria-hidden="true"></i>No models currently running</div>`;
      return;
    }
    const showDevice = models.some((m) => m.device);
    wrap.innerHTML = `${head}<div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>Size</th><th>VRAM</th>${showDevice ? "<th>Device</th>" : ""}<th>Expires</th><th></th></tr></thead>
      <tbody>${models
        .map(
          (m) => `<tr>
        <td>${escHtml(m.name)} ${backendBadge(m.backend)}</td>
        <td>${fmtSize(m.size || 0)}</td>
        <td>${fmtSize(m.size_vram || 0)}
          ${m.size && m.size_vram ? `<div class="progress-wrap" style="margin-top:4px;height:4px"><div class="progress-bar" style="width:${Math.min(100, Math.round((m.size_vram / m.size) * 100))}%"></div></div>` : ""}
        </td>
        ${showDevice ? `<td style="font-family:var(--mono);font-size:11px">${escHtml(m.device || "—")}</td>` : ""}
        <td style="font-family:var(--mono);font-size:11px">${escHtml(formatExpires(m.expires_at))}</td>
        <td style="text-align:right"><button class="btn btn-sm" data-action="unload" data-key="${escHtml(m.key)}" title="Unload from memory"><i class="ti ti-player-eject" aria-hidden="true"></i> Unload</button></td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>`;
  } catch {
    toast("Failed to load running models", "error");
  }
}

const sectionLabel = (text: string) =>
  `<div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">${text}</div>`;
const preBlock = (text: string, maxHeight: number) =>
  `<pre style="max-height:${maxHeight}px;overflow:auto;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:11px;color:var(--text2)">${escHtml(text)}</pre>`;

interface ShowResponse {
  details?: Record<string, string | string[] | undefined>;
  parameters?: string;
  license?: string;
  modelfile?: string;
  modified_at?: string;
  size?: number;
  // Ollaya only
  capabilities?: string[];
  questions?: Record<string, { type?: string; instructions?: unknown }> | null;
  router?: { strategy?: string; default?: string; routes?: Record<string, string> } | null;
  model_info?: Record<string, unknown>;
}

// Ollaya-only sections of /api/show: what the model can answer, its built-in
// questions, and for routers where requests go.
function formatDecisionInfo(d: ShowResponse): string {
  let html = "";
  if (d.capabilities?.length) {
    html += `<div style="margin-bottom:12px">${sectionLabel("Capabilities")}<div style="display:flex;gap:6px;flex-wrap:wrap">${d.capabilities
      .map((c) => `<span class="badge">${escHtml(c)}</span>`)
      .join("")}</div></div>`;
  }
  const languages = d.model_info?.["general.languages"];
  const source = d.model_info?.["general.source"];
  if (Array.isArray(languages) || typeof source === "string") {
    html += '<div class="info-grid" style="margin-bottom:12px">';
    if (Array.isArray(languages)) {
      html += `<div class="info-item"><div class="info-label">Languages</div><div class="info-value">${escHtml(languages.join(", "))}</div></div>`;
    }
    if (typeof source === "string") {
      html += `<div class="info-item"><div class="info-label">Weights</div><div class="info-value" style="font-size:11px;word-break:break-all">${escHtml(source)}</div></div>`;
    }
    html += "</div>";
  }
  if (d.router?.routes) {
    const routes = Object.entries(d.router.routes);
    html += `<div style="margin-bottom:12px">${sectionLabel(`Router${d.router.strategy ? ` · ${escHtml(d.router.strategy)}` : ""}`)}${preBlock(
      routes
        .map(
          ([route, target]) =>
            `${route}${route === d.router?.default ? " (default)" : ""} → ${target}`,
        )
        .join("\n"),
      120,
    )}</div>`;
  }
  if (d.questions && Object.keys(d.questions).length) {
    html += `<div style="margin-bottom:12px">${sectionLabel("Built-in questions")}${preBlock(
      Object.entries(d.questions)
        .map(
          ([id, q]) =>
            `${id}  (${q.type ?? "?"})${typeof q.instructions === "string" ? ` — ${q.instructions}` : ""}`,
        )
        .join("\n"),
      160,
    )}</div>`;
  }
  return html;
}

function formatModelInfo(d: ShowResponse, m: BackendModel | undefined): string {
  const details = d.details || {};
  const params = d.parameters || "";
  const license = d.license || "";
  const modelfile = d.modelfile || "";
  const family = String(details.family || (details.families as string[] | undefined)?.[0] || "—");
  const quant = String(details.quantization_level || "—");
  const pSize = String(details.parameter_size || "—");
  const ctx = String(details.context_length || d.model_info?.["laya.context_length"] || "—");
  const modified = d.modified_at || m?.modified_at;

  let html =
    '<div style="font-family:var(--sans);font-size:13px;line-height:1.7;color:var(--text)">';

  html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">';
  if (m) html += backendBadge(m.backend);
  html += `<span class="badge" style="background:rgba(200,240,96,0.1);color:var(--accent);border-color:rgba(200,240,96,0.25)">${escHtml(family)}</span>`;
  if (details.format) html += `<span class="badge">${escHtml(String(details.format))}</span>`;
  html += `<span class="badge">${escHtml(quant)}</span>`;
  html += `<span class="badge">${escHtml(pSize)}</span>`;
  html += "</div>";

  html += '<div class="info-grid" style="margin-bottom:16px">';
  html += `<div class="info-item"><div class="info-label">Size</div><div class="info-value">${fmtSize(d.size || m?.size || 0)}</div></div>`;
  html += `<div class="info-item"><div class="info-label">Context</div><div class="info-value">${escHtml(ctx)}</div></div>`;
  html += `<div class="info-item"><div class="info-label">Modified</div><div class="info-value">${modified ? new Date(modified).toLocaleString() : "—"}</div></div>`;
  html += "</div>";

  html += formatDecisionInfo(d);

  const sysMatch = modelfile.match(/SYSTEM\s+"""([\s\S]*?)"""/);
  if (sysMatch?.[1]) {
    html += `<div style="margin-bottom:12px">${sectionLabel("System Prompt")}${preBlock(sysMatch[1].trim(), 160)}</div>`;
  }
  if (params) {
    html += `<div style="margin-bottom:12px">${sectionLabel("Parameters")}${preBlock(params, 120)}</div>`;
  }
  if (license) {
    html += `<div>${sectionLabel("License")}${preBlock(license, 80)}</div>`;
  }

  html += "</div>";
  return html;
}

/** Opens the detail modal for a model, addressed by its key ("backend/name"). */
export async function showModel(key: string): Promise<void> {
  const parsed = parseModelKey(key);
  if (!parsed) return;
  try {
    const r = await apiOk(backendPath(parsed.backend, "/show"), {
      method: "POST",
      body: JSON.stringify({ model: parsed.name }),
    });
    const d = (await r.json()) as ShowResponse;
    const m = modelCache.find((x) => x.key === key);
    openModal(parsed.name, formatModelInfo(d, m), { rich: true, focus: true });
  } catch (e) {
    toast(`Failed to load model info: ${e instanceof Error ? e.message : e}`, "error");
  }
}

async function deleteModel(key: string): Promise<void> {
  const parsed = parseModelKey(key);
  if (!parsed) return;
  const { backend, name } = parsed;
  const ok = await showConfirm(
    "Delete model",
    `Delete "${name}" from ${backendLabel(backend)}? This cannot be undone.`,
    "Delete",
  );
  if (!ok) return;
  document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]').forEach((b) => {
    b.disabled = true;
  });
  try {
    await apiOk(backendPath(backend, "/delete"), {
      method: "DELETE",
      body: JSON.stringify({ model: name }),
    });
    toast(`Deleted ${name}`, "success");
    loadModels();
  } catch (e) {
    toast(`Delete failed: ${e instanceof Error ? e.message : e}`, "error");
  } finally {
    document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]').forEach((b) => {
      b.disabled = false;
    });
  }
}

// Both backends unload through their inference endpoint with keep_alive 0 and
// no input: Ollama's /api/generate, Ollaya's /api/decide (which must not get
// `stream`, it rejects stream: true and only knows non-streaming responses).
async function unloadModel(key: string): Promise<void> {
  const parsed = parseModelKey(key);
  if (!parsed) return;
  const kind = getBackend(parsed.backend)?.kind;
  const path = kind === "ollaya" ? "/decide" : "/generate";
  const body: Record<string, unknown> = { model: parsed.name, keep_alive: 0 };
  if (kind !== "ollaya") body.stream = false;
  try {
    await apiOk(backendPath(parsed.backend, path), {
      method: "POST",
      body: JSON.stringify(body),
    });
    toast(`Unloaded ${parsed.name}`, "success");
    loadRunning();
  } catch (e) {
    toast(`Unload failed: ${e instanceof Error ? e.message : e}`, "error");
  }
}

const PULL_PLACEHOLDERS: Record<string, string> = {
  ollama: "llama3.2, mistral, gemma2:9b …",
  ollaya: "laya, winnow:e4b, nli …",
};
const PULL_SUBTITLES: Record<string, string> = {
  ollama: "Download a model from the Ollama registry",
  ollaya: "Download a decision model from ollaya.dev (routers pull their target models too)",
};

function updatePullHints(): void {
  const id = (document.getElementById("pull-backend") as HTMLSelectElement).value;
  const kind = getBackend(id)?.kind ?? "ollama";
  (document.getElementById("pull-model") as HTMLInputElement).placeholder =
    PULL_PLACEHOLDERS[kind] ?? "";
  (document.getElementById("pull-sub") as HTMLElement).textContent = PULL_SUBTITLES[kind] ?? "";
}

export async function loadPull(): Promise<void> {
  await ensureBackends();
  fillBackendSelect("pull-backend", "pull-backend-wrap");
  updatePullHints();
}

/** Used by the catalog: preselects backend and model name on the Pull page. */
export async function setPullTarget(backend: string, name: string): Promise<void> {
  await ensureBackends();
  fillBackendSelect("pull-backend", "pull-backend-wrap");
  (document.getElementById("pull-backend") as HTMLSelectElement).value = backend;
  (document.getElementById("pull-model") as HTMLInputElement).value = name;
  navigateTo("pull");
}

let pullAbort: AbortController | null = null;

async function pullModel(): Promise<void> {
  const pullBtn = document.getElementById("pull-btn") as HTMLButtonElement;

  // If already pulling, this acts as stop
  if (pullAbort) {
    pullAbort.abort();
    return;
  }

  const modelInput = document.getElementById("pull-model") as HTMLInputElement;
  const model = modelInput.value.trim();
  if (!model) {
    toast("Enter a model name", "error");
    return;
  }
  const backend = (document.getElementById("pull-backend") as HTMLSelectElement).value || "ollama";
  const statusDiv = document.getElementById("pull-status") as HTMLElement;
  const logDiv = document.getElementById("pull-log") as HTMLElement;
  const bar = document.getElementById("pull-progress") as HTMLElement;
  statusDiv.style.display = "block";
  logDiv.innerHTML = "";
  bar.style.width = "0%";

  pullAbort = new AbortController();
  pullBtn.innerHTML = '<i class="ti ti-player-stop" aria-hidden="true"></i> Stop';
  pullBtn.classList.add("btn-danger");
  pullBtn.classList.remove("btn-primary");

  try {
    const r = await apiOk(backendPath(backend, "/pull"), {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
      signal: pullAbort.signal,
    });

    // Both backends stream one "pulling <digest>" sequence per layer, each with
    // its own completed/total byte counts. Track them per digest and sum, so the
    // bar shows true overall progress instead of resetting near 0 every time
    // a new layer starts (which is what happens if you only look at the
    // latest event's completed/total).
    const layerBytes = new Map<string, { completed: number; total: number }>();
    let lastStatus = "";
    let succeeded = false;

    for await (const ev of readNdjsonLines(r)) {
      // Errors after the stream started arrive as a line of their own.
      if (ev.error) throw new Error(ev.code ? `${ev.error} (${ev.code})` : ev.error);
      if (ev.status)
        lastStatus = ev.status === "pulling manifest" ? "Downloading manifest…" : ev.status;
      if (ev.digest && typeof ev.total === "number") {
        layerBytes.set(ev.digest, { completed: ev.completed || 0, total: ev.total });
      }

      let completedBytes = 0;
      let totalBytes = 0;
      for (const layer of layerBytes.values()) {
        completedBytes += layer.completed;
        totalBytes += layer.total;
      }
      const pct =
        totalBytes > 0 ? Math.min(100, Math.round((completedBytes / totalBytes) * 100)) : 0;

      if (ev.status === "success") {
        succeeded = true;
        bar.style.width = "100%";
        toast(`Pull complete: ${model} (${backendLabel(backend)})`, "success");
      } else if (totalBytes > 0) {
        bar.style.width = `${pct}%`;
      }
      logDiv.innerHTML = `<span class="log-line">${escHtml(lastStatus)}${totalBytes ? ` (${pct}%)` : ""}</span>`;
    }
    // A stream without its terminal "success" line was cut off.
    if (!succeeded) throw new Error("the download stream ended before it finished");
    fetchModels().catch(() => {});
  } catch (e) {
    const err = e as Error;
    if (err.name !== "AbortError") {
      toast(`Pull failed: ${err.message}`, "error");
      logDiv.innerHTML = `<span class="log-line err">${escHtml(err.message)}</span>`;
    }
  } finally {
    pullAbort = null;
    pullBtn.innerHTML = '<i class="ti ti-download" aria-hidden="true"></i> Pull';
    pullBtn.classList.remove("btn-danger");
    pullBtn.classList.add("btn-primary");
  }
}

export async function loadCopy(): Promise<void> {
  await ensureBackends();
  fillBackendSelect("copy-backend", "copy-backend-wrap");
  const multi =
    (document.getElementById("copy-backend-wrap") as HTMLElement).style.display !== "none";
  (document.getElementById("push-backend-note") as HTMLElement).style.display = multi ? "" : "none";
}

let copying = false;

async function copyModel(): Promise<void> {
  if (copying) return;
  const backend = (document.getElementById("copy-backend") as HTMLSelectElement).value || "ollama";
  const src = (document.getElementById("copy-src") as HTMLInputElement).value.trim();
  const dst = (document.getElementById("copy-dst") as HTMLInputElement).value.trim();
  if (!src || !dst) {
    toast("Fill in both fields", "error");
    return;
  }
  copying = true;
  try {
    await apiOk(backendPath(backend, "/copy"), {
      method: "POST",
      body: JSON.stringify({ source: src, destination: dst }),
    });
    toast(`Copied ${src} → ${dst}`, "success");
  } catch (e) {
    toast(`Copy failed: ${e instanceof Error ? e.message : e}`, "error");
  } finally {
    copying = false;
  }
}

// Only Ollama has a registry to push to (Ollaya reserves /api/push).
async function pushModel(): Promise<void> {
  const model = (document.getElementById("push-model") as HTMLInputElement).value.trim();
  if (!model) {
    toast("Enter a model name", "error");
    return;
  }
  toast(`Pushing ${model}…`, "info");
  try {
    const r = await api(backendPath("ollama", "/push"), {
      method: "POST",
      body: JSON.stringify({ model, stream: false }),
    });
    const d = await r.json();
    toast(d.status || d.error || "Push complete", r.ok ? "success" : "error");
  } catch {
    toast("Push failed", "error");
  }
}

function onEnter(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") fn();
  });
}

function onBackendFilter(target: HTMLElement, reload: () => void): boolean {
  const chip = target.closest<HTMLElement>("[data-backend-filter]");
  if (!chip?.dataset.backendFilter) return false;
  setBackendFilter(chip.dataset.backendFilter);
  reload();
  return true;
}

export function initModels(): void {
  document.getElementById("models-refresh-btn")?.addEventListener("click", loadModels);
  document.getElementById("running-refresh-btn")?.addEventListener("click", loadRunning);
  document.getElementById("pull-btn")?.addEventListener("click", pullModel);
  document.getElementById("pull-backend")?.addEventListener("change", updatePullHints);
  document.getElementById("copy-btn")?.addEventListener("click", copyModel);
  document.getElementById("push-btn")?.addEventListener("click", pushModel);
  onEnter("pull-model", pullModel);
  onEnter("copy-src", copyModel);
  onEnter("copy-dst", copyModel);
  onEnter("push-model", pushModel);

  document.getElementById("model-grid-wrap")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (onBackendFilter(target, loadModels)) return;
    const btn = target.closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const key = btn.dataset.key;
    if (btn.dataset.action === "info" && key) showModel(key);
    if (btn.dataset.action === "delete" && key) deleteModel(key);
    if (btn.dataset.action === "goto-pull") navigateTo("pull");
  });

  document.getElementById("running-wrap")?.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (onBackendFilter(target, loadRunning)) return;
    const btn = target.closest<HTMLElement>('[data-action="unload"]');
    if (btn?.dataset.key) unloadModel(btn.dataset.key);
  });
}
