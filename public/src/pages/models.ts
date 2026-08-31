import { api, apiOk, readNdjsonLines } from "../api";
import { navigateTo } from "../nav";
import { fetchModels, refreshRunning } from "../state/models";
import { showConfirm } from "../ui/confirm";
import { openModal } from "../ui/modal";
import { toast } from "../ui/toast";
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

export async function loadModels(): Promise<void> {
  const wrap = document.getElementById("model-grid-wrap") as HTMLElement;
  wrap.innerHTML = skeletonModelCards(6);
  try {
    const models = await fetchModels();
    if (models.length === 0) {
      wrap.innerHTML =
        '<div class="empty"><i class="ti ti-box" aria-hidden="true"></i>No models found.<br>' +
        '<button class="btn btn-primary" style="margin-top:12px" data-action="goto-pull">' +
        '<i class="ti ti-download" aria-hidden="true"></i> Pull your first model</button></div>';
      return;
    }
    wrap.innerHTML = `<div class="model-grid">${models
      .map(
        (m) => `
      <div class="model-card">
        <div class="model-name">
          <span>${escHtml(m.name)}</span>
          ${m.details?.parameter_size ? `<span style="color:var(--accent);font-size:11px">${escHtml(m.details.parameter_size)}</span>` : ""}
        </div>
        <div class="model-meta">
          ${m.details?.quantization_level ? `<span class="badge" style="background:rgba(200,240,96,0.08);color:var(--accent);border-color:rgba(200,240,96,0.2)">${escHtml(m.details.quantization_level)}</span>` : ""}
          <span class="badge">${fmtSize(m.size || 0)}</span>
          <span class="badge">${escHtml(m.details?.parameter_size || "")}</span>
        </div>
        <div class="model-actions">
          <button class="btn btn-sm" data-action="info" data-model="${escHtml(m.name)}"><i class="ti ti-info-circle" aria-hidden="true"></i> Info</button>
          <button class="btn btn-sm btn-danger" data-action="delete" data-model="${escHtml(m.name)}"><i class="ti ti-trash" aria-hidden="true"></i> Delete</button>
        </div>
      </div>`,
      )
      .join("")}</div>`;
  } catch {
    toast("Failed to load models", "error");
  }
}

export async function loadRunning(): Promise<void> {
  const wrap = document.getElementById("running-wrap") as HTMLElement;
  wrap.innerHTML = skeletonTableRows(3);
  try {
    const models = await refreshRunning();
    if (models.length === 0) {
      wrap.innerHTML =
        '<div class="empty"><i class="ti ti-player-pause" aria-hidden="true"></i>No models currently running</div>';
      return;
    }
    wrap.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>Size</th><th>VRAM</th><th>Expires</th></tr></thead>
      <tbody>${models
        .map(
          (m) => `<tr>
        <td>${escHtml(m.name)}</td>
        <td>${fmtSize(m.size || 0)}</td>
        <td>${fmtSize(m.size_vram || 0)}
          ${m.size && m.size_vram ? `<div class="progress-wrap" style="margin-top:4px;height:4px"><div class="progress-bar" style="width:${Math.min(100, Math.round((m.size_vram / m.size) * 100))}%"></div></div>` : ""}
        </td>
        <td style="font-family:var(--mono);font-size:11px">${m.expires_at ? new Date(m.expires_at).toLocaleTimeString() : "—"}</td>
      </tr>`,
        )
        .join("")}</tbody>
    </table></div>`;
  } catch {
    toast("Failed to load running models", "error");
  }
}

function formatModelInfo(d: any): string {
  const details = d.details || {};
  const params = d.parameters || "";
  const license = d.license || "";
  const modelfile = d.modelfile || "";
  const family = details.family || details.families?.[0] || "—";
  const quant = details.quantization_level || "—";
  const pSize = details.parameter_size || "—";
  const ctx = details.context_length || "—";

  let html =
    '<div style="font-family:var(--sans);font-size:13px;line-height:1.7;color:var(--text)">';

  html += '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px">';
  html += `<span class="badge" style="background:rgba(200,240,96,0.1);color:var(--accent);border-color:rgba(200,240,96,0.25)">${escHtml(family)}</span>`;
  html += `<span class="badge">${escHtml(quant)}</span>`;
  html += `<span class="badge">${escHtml(pSize)}</span>`;
  html += "</div>";

  html += '<div class="info-grid" style="margin-bottom:16px">';
  html += `<div class="info-item"><div class="info-label">Size</div><div class="info-value">${fmtSize(d.size)}</div></div>`;
  html += `<div class="info-item"><div class="info-label">Context</div><div class="info-value">${escHtml(String(ctx))}</div></div>`;
  html += `<div class="info-item"><div class="info-label">Modified</div><div class="info-value">${d.modified_at ? new Date(d.modified_at).toLocaleString() : "—"}</div></div>`;
  html += "</div>";

  const sysMatch = modelfile.match(/SYSTEM\s+"""([\s\S]*?)"""/);
  if (sysMatch) {
    html +=
      '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">System Prompt</div>';
    html += `<pre style="max-height:160px;overflow:auto;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:11px;color:var(--text2)">${escHtml(sysMatch[1].trim())}</pre></div>`;
  }

  if (params) {
    html +=
      '<div style="margin-bottom:12px"><div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">Parameters</div>';
    html += `<pre style="max-height:120px;overflow:auto;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:11px;color:var(--text2)">${escHtml(params)}</pre></div>`;
  }

  if (license) {
    html +=
      '<div><div style="font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em;margin-bottom:6px">License</div>';
    html += `<pre style="max-height:80px;overflow:auto;background:var(--bg3);border:1px solid var(--border);border-radius:var(--radius);padding:10px;font-size:11px;color:var(--text2)">${escHtml(license)}</pre></div>`;
  }

  html += "</div>";
  return html;
}

export async function showModel(name: string): Promise<void> {
  try {
    const r = await apiOk("/api/show", { method: "POST", body: JSON.stringify({ model: name }) });
    const d = await r.json();
    openModal(name, formatModelInfo(d), { rich: true, focus: true });
  } catch {
    toast("Failed to load model info", "error");
  }
}

async function deleteModel(name: string): Promise<void> {
  const ok = await showConfirm(
    "Delete model",
    `Delete "${name}"? This cannot be undone.`,
    "Delete",
  );
  if (!ok) return;
  document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]').forEach((b) => {
    b.disabled = true;
  });
  try {
    await apiOk("/api/delete", { method: "DELETE", body: JSON.stringify({ model: name }) });
    toast(`Deleted ${name}`, "success");
    loadModels();
  } catch {
    toast("Delete failed", "error");
  } finally {
    document.querySelectorAll<HTMLButtonElement>('[data-action="delete"]').forEach((b) => {
      b.disabled = false;
    });
  }
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
    const r = await apiOk("/api/pull", {
      method: "POST",
      body: JSON.stringify({ model, stream: true }),
      signal: pullAbort.signal,
    });

    // Ollama streams one "pulling <digest>" sequence per layer, each with its
    // own completed/total byte counts. Track them per digest and sum, so the
    // bar shows true overall progress instead of resetting near 0 every time
    // a new layer starts (which is what happens if you only look at the
    // latest event's completed/total).
    const layerBytes = new Map<string, { completed: number; total: number }>();
    let lastStatus = "";

    for await (const ev of readNdjsonLines(r)) {
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
        bar.style.width = "100%";
        toast(`Pull complete: ${model}`, "success");
      } else if (totalBytes > 0) {
        bar.style.width = `${pct}%`;
      }
      logDiv.innerHTML = `<span class="log-line">${escHtml(lastStatus)}${totalBytes ? ` (${pct}%)` : ""}</span>`;
    }
  } catch (e: any) {
    if (e.name !== "AbortError") toast(`Pull failed: ${e.message}`, "error");
  } finally {
    pullAbort = null;
    pullBtn.innerHTML = '<i class="ti ti-download" aria-hidden="true"></i> Pull';
    pullBtn.classList.remove("btn-danger");
    pullBtn.classList.add("btn-primary");
  }
}

let copying = false;

async function copyModel(): Promise<void> {
  if (copying) return;
  const src = (document.getElementById("copy-src") as HTMLInputElement).value.trim();
  const dst = (document.getElementById("copy-dst") as HTMLInputElement).value.trim();
  if (!src || !dst) {
    toast("Fill in both fields", "error");
    return;
  }
  copying = true;
  try {
    await apiOk("/api/copy", {
      method: "POST",
      body: JSON.stringify({ source: src, destination: dst }),
    });
    toast(`Copied ${src} → ${dst}`, "success");
  } catch {
    toast("Copy failed", "error");
  } finally {
    copying = false;
  }
}

async function pushModel(): Promise<void> {
  const model = (document.getElementById("push-model") as HTMLInputElement).value.trim();
  if (!model) {
    toast("Enter a model name", "error");
    return;
  }
  toast(`Pushing ${model}…`, "info");
  try {
    const r = await api("/api/push", {
      method: "POST",
      body: JSON.stringify({ model, stream: false }),
    });
    const d = await r.json();
    toast(d.status || "Push complete", r.ok ? "success" : "error");
  } catch {
    toast("Push failed", "error");
  }
}

function onEnter(id: string, fn: () => void): void {
  document.getElementById(id)?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") fn();
  });
}

export function initModels(): void {
  document.getElementById("models-refresh-btn")?.addEventListener("click", loadModels);
  document.getElementById("running-refresh-btn")?.addEventListener("click", loadRunning);
  document.getElementById("pull-btn")?.addEventListener("click", pullModel);
  document.getElementById("copy-btn")?.addEventListener("click", copyModel);
  document.getElementById("push-btn")?.addEventListener("click", pushModel);
  onEnter("pull-model", pullModel);
  onEnter("copy-src", copyModel);
  onEnter("copy-dst", copyModel);
  onEnter("push-model", pushModel);

  document.getElementById("model-grid-wrap")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    const name = btn.dataset.model;
    if (btn.dataset.action === "info" && name) showModel(name);
    if (btn.dataset.action === "delete" && name) deleteModel(name);
    if (btn.dataset.action === "goto-pull") navigateTo("pull");
  });
}
