import { api, apiOk } from "../api";
import { ensureBackends, firstBackendOfKind } from "../state/backends";
import { toast } from "../ui/toast";
import { errorMessage, escHtml } from "../utils/format";
import {
  litellmCurlExample,
  litellmEnvSnippet,
  type TypesafeStatus,
  typesafeStateView,
} from "../utils/litellm";

interface SyncDetail {
  status: "success" | "skipped" | "failed" | "info";
  message: string;
}

interface SyncResult {
  time: number;
  success: number;
  failed: number;
  skipped: number;
  details: SyncDetail[];
}

interface LiteLLMStatus {
  enabled: boolean;
  url: string;
  interval: number;
  lastSync: SyncResult | null;
}

function syncLogClass(status: SyncDetail["status"]): string {
  return ({ success: "ok", failed: "err", skipped: "" } as Record<string, string>)[status] || "";
}

function renderLiteLLMStatus(
  statusDiv: HTMLElement,
  actionsDiv: HTMLElement,
  d: LiteLLMStatus,
): void {
  if (!d.enabled) {
    statusDiv.innerHTML = `<div class="empty"><i class="ti ti-x" aria-hidden="true"></i>LiteLLM sync is not configured.<br><span style="color:var(--text3);font-size:12px">Set LITELLM_URL and LITELLM_KEY environment variables.</span></div>`;
    actionsDiv.style.display = "none";
    return;
  }
  actionsDiv.style.display = "block";
  const last = d.lastSync;
  if (!last) {
    statusDiv.innerHTML = `<div class="empty"><i class="ti ti-info-circle" aria-hidden="true"></i>LiteLLM sync is configured but has not run yet.<br><span style="color:var(--text3);font-size:12px">URL: ${escHtml(d.url)} · Interval: ${d.interval} min</span></div>`;
    return;
  }
  const ts = new Date(last.time).toLocaleString();
  statusDiv.innerHTML = `<div style="margin-bottom:8px;font-size:12px;color:var(--text3)">Last run: ${escHtml(ts)} · URL: ${escHtml(d.url)} · Interval: ${d.interval} min</div>
    <div class="info-grid" style="margin-bottom:12px">
      <div class="info-item"><div class="info-label">Successful</div><div class="info-value" style="color:var(--success)">${last.success}</div></div>
      <div class="info-item"><div class="info-label">Skipped</div><div class="info-value" style="color:var(--warning)">${last.skipped}</div></div>
      <div class="info-item"><div class="info-label">Failed</div><div class="info-value" style="color:var(--danger)">${last.failed}</div></div>
    </div>
    <div class="pull-log">${last.details.map((l) => `<span class="log-line ${syncLogClass(l.status)}">${escHtml(l.message)}</span>`).join("")}</div>`;
}

// ---------------------------------------------------------------------------
// Ollaya through LiteLLM's TypeSafe pass-through

let litellmUrl = "";

function renderOllayaCard(s: TypesafeStatus): string {
  const view = typesafeStateView(s);
  const color = { ok: "var(--success)", warn: "var(--warning)", err: "var(--danger)" }[view.tone];
  const pre = (text: string) =>
    `<pre class="embed-result" style="white-space:pre-wrap">${escHtml(text)}</pre>`;
  const list = (names: string[]) =>
    names.length
      ? `<div style="display:flex;flex-wrap:wrap;gap:4px">${names.map((n) => `<span class="badge" style="white-space:nowrap">${escHtml(n)}</span>`).join("")}</div>`
      : "—";
  const model = s.ollayaModels[0] ?? "laya";
  let html = `<div style="display:flex;gap:10px;align-items:center;margin-bottom:10px">
      <span class="badge" style="color:${color};border-color:${color}">${escHtml(view.label)}</span>
      <span style="font-size:12px;color:var(--text2)">${escHtml(s.detail)}</span>
    </div>`;
  if (s.managementApiExposed) {
    html += `<div class="backend-warning" style="color:var(--danger);border-color:rgba(255,85,85,0.35);background:rgba(255,85,85,0.06)"><i class="ti ti-alert-triangle" aria-hidden="true"></i> LiteLLM forwards <b>every</b> path under /typesafe/, and it reaches Ollaya's management API: anyone with a LiteLLM key can pull, copy, create and delete models. Point TYPESAFE_API_BASE at the manager's gateway below instead of at Ollaya.</div>`;
  }
  if (s.litellmModels.length || s.ollayaModels.length) {
    html += `<div class="info-grid" style="margin-bottom:12px">
      <div class="info-item"><div class="info-label">LiteLLM sees</div><div>${list(s.litellmModels)}</div></div>
      <div class="info-item"><div class="info-label">Ollaya has</div><div>${list(s.ollayaModels)}</div></div>
    </div>`;
  }
  html += `<div style="font-size:12px;color:var(--text2);margin:8px 0">LiteLLM doesn't register decision models; it forwards <code>/typesafe/*</code> to one TypeSafe-compatible server. Let it forward to the manager's gateway, which only allows <code>systemone</code>, <code>decisions</code> and <code>models</code>:</div>`;
  if (!s.gatewayEnabled) {
    html += `<div class="backend-warning"><i class="ti ti-info-circle" aria-hidden="true"></i> The gateway is off. Set <code>OLLAYA_TYPESAFE_KEY</code> on the manager (any long random string) to turn it on.</div>`;
  }
  html += pre(litellmEnvSnippet(location.origin, s.gatewayPath));
  html += `<div style="font-size:11px;color:var(--text3);margin:4px 0 12px">Use the address under which <b>LiteLLM</b> reaches the manager — in Docker Compose usually the service name, e.g. http://ollama-manager:3000.</div>`;
  html += `<div style="font-size:12px;color:var(--text2);margin-bottom:6px">Clients then call LiteLLM with a LiteLLM key (TypeSafe SDK: <code>TYPESAFE_BASE_URL=&lt;litellm&gt;/typesafe</code>):</div>`;
  html += pre(litellmCurlExample(litellmUrl, model));
  return html;
}

export async function loadOllayaThroughLiteLLM(): Promise<void> {
  const card = document.getElementById("litellm-ollaya-card") as HTMLElement;
  const box = document.getElementById("litellm-ollaya") as HTMLElement;
  await ensureBackends();
  if (!firstBackendOfKind("ollaya")) {
    card.style.display = "none";
    return;
  }
  card.style.display = "";
  box.innerHTML = '<div class="empty"><span class="spinner"></span> Checking…</div>';
  try {
    const r = await api("/api/litellm/ollaya-status");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    box.innerHTML = renderOllayaCard((await r.json()) as TypesafeStatus);
  } catch (e) {
    box.innerHTML = `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i>Check failed: ${escHtml(errorMessage(e))}</div>`;
  }
}

export async function loadLiteLLMStatus(): Promise<void> {
  const statusDiv = document.getElementById("litellm-status") as HTMLElement;
  const actionsDiv = document.getElementById("litellm-actions") as HTMLElement;
  try {
    const r = await apiOk("/api/litellm/status");
    const d = await r.json();
    litellmUrl = d.url || "";
    renderLiteLLMStatus(statusDiv, actionsDiv, d);
  } catch {
    statusDiv.innerHTML = `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i>Failed to load LiteLLM status</div>`;
    actionsDiv.style.display = "none";
  }
}

async function triggerLiteLLMSync(): Promise<void> {
  const btn = document.getElementById("litellm-sync-btn") as HTMLButtonElement;
  const statusDiv = document.getElementById("litellm-status") as HTMLElement;
  const actionsDiv = document.getElementById("litellm-actions") as HTMLElement;
  btn.disabled = true;
  statusDiv.innerHTML = `<div style="margin-bottom:8px;font-size:12px;color:var(--text3)">Syncing models…</div><div class="empty"><span class="spinner"></span></div>`;
  try {
    const r = await apiOk("/api/litellm/sync", { method: "POST" });
    const d = await r.json();
    const result = d.lastSync;
    toast(
      `LiteLLM sync complete — ${result.success} success, ${result.failed} failed, ${result.skipped} skipped`,
      result.failed > 0 ? "warning" : "success",
    );
    renderLiteLLMStatus(statusDiv, actionsDiv, d);
  } catch (e) {
    statusDiv.innerHTML = `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i>Sync failed: ${escHtml(errorMessage(e))}</div>`;
    toast("LiteLLM sync failed", "error");
  } finally {
    btn.disabled = false;
  }
}

export function initLiteLLM(): void {
  document.getElementById("litellm-sync-btn")?.addEventListener("click", triggerLiteLLMSync);
  document
    .getElementById("litellm-ollaya-refresh")
    ?.addEventListener("click", () => loadOllayaThroughLiteLLM());
}
