import { apiOk } from "../api";
import { toast } from "../ui/toast";
import { escHtml } from "../utils/format";

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
    <div class="pull-log" style="max-height:200px">${last.details.map((l) => `<span class="log-line ${syncLogClass(l.status)}">${escHtml(l.message)}</span>`).join("")}</div>`;
}

export async function loadLiteLLMStatus(): Promise<void> {
  const statusDiv = document.getElementById("litellm-status") as HTMLElement;
  const actionsDiv = document.getElementById("litellm-actions") as HTMLElement;
  try {
    const r = await apiOk("/api/litellm/status");
    const d = await r.json();
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
  } catch (e: any) {
    statusDiv.innerHTML = `<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i>Sync failed: ${escHtml(e.message)}</div>`;
    toast("LiteLLM sync failed", "error");
  } finally {
    btn.disabled = false;
  }
}

export function initLiteLLM(): void {
  document.getElementById("litellm-sync-btn")?.addEventListener("click", triggerLiteLLMSync);
}
