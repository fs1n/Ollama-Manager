import { getBackends, loadBackends } from "../state/backends";
import { fetchModels, refreshRunning } from "../state/models";
import { applyCapabilityNav, backendBadge } from "../ui/backend";
import { toast } from "../ui/toast";
import { statusSummary } from "../utils/backends";
import { escHtml, fmtSize } from "../utils/format";

function setStatus(): void {
  const dot = document.getElementById("status-dot") as HTMLElement;
  const txt = document.getElementById("status-text") as HTMLElement;
  const { state, text } = statusSummary(getBackends());
  dot.className = `status-dot ${state === "connected" ? "connected" : state === "partial" ? "partial" : "error"}`;
  txt.textContent = text;
}

export async function loadAppVersion(): Promise<void> {
  try {
    const r = await fetch("/api/app-version");
    if (!r.ok) return;
    const d = await r.json();
    if (d.version) {
      const el = document.getElementById("version-badge") as HTMLElement;
      // Unlike the backends' own versions (shown in the header status badge),
      // this is OLLAMA_MANAGER_VERSION — an arbitrary build-time string, not
      // necessarily semver (e.g. a CI run might set it to a branch/PR name).
      // Label it explicitly instead of guessing a "v" prefix onto it, so it
      // reads clearly next to the backends' "vX.Y.Z" badges instead of looking
      // like a second, differently-formatted version number.
      el.textContent = `Manager: ${d.version}`;
    }
  } catch {
    // version badge just stays blank — not worth surfacing an error for
  }
}

// Last known status per backend id, so toasts only fire on actual changes,
// not on every manual refresh.
const lastKnownStatus = new Map<string, string>();

export async function connect(): Promise<void> {
  try {
    const backends = await loadBackends();
    for (const b of backends) {
      const prev = lastKnownStatus.get(b.id);
      if (prev !== b.status) {
        if (b.status === "connected") {
          toast(`Connected to ${b.label} ${b.version || ""}`.trim(), "success");
        } else {
          toast(`${b.label} unreachable`, "error");
        }
      }
      lastKnownStatus.set(b.id, b.status);
    }
  } catch {
    // /api/backends itself failed: the manager is unreachable (or logged out)
    if (lastKnownStatus.get("*") !== "down") toast("Manager unreachable", "error");
    lastKnownStatus.set("*", "down");
    setStatus();
    return;
  }
  lastKnownStatus.delete("*");
  setStatus();
  applyCapabilityNav();
  await loadDashboard();
}

function backendCard(
  id: string,
  models: { size?: number; backend: string }[],
  running: { size?: number; size_vram?: number; backend: string }[],
): string {
  const b = getBackends().find((x) => x.id === id);
  if (!b) return "";
  const own = models.filter((m) => m.backend === id);
  const ownRunning = running.filter((m) => m.backend === id);
  const disk = own.reduce((sum, m) => sum + (m.size || 0), 0);
  const vram = ownRunning.reduce((sum, m) => sum + (m.size_vram || 0), 0);
  const up = b.status === "connected";
  return `<div class="backend-card${up ? "" : " down"}">
    <div class="backend-card-title">
      <span class="status-dot ${up ? "connected" : "error"}"></span>
      <span>${escHtml(b.label)}</span>
      <span class="badge">${up ? escHtml(b.version ? `v${b.version}` : "unknown") : "unreachable"}</span>
    </div>
    <div class="backend-card-stats">
      <div><span class="info-label">Models</span><span class="info-value">${up ? own.length : "—"}</span></div>
      <div><span class="info-label">Running</span><span class="info-value">${up ? ownRunning.length : "—"}</span></div>
      <div><span class="info-label">Disk</span><span class="info-value">${up ? fmtSize(disk) : "—"}</span></div>
      <div><span class="info-label">VRAM</span><span class="info-value">${up ? fmtSize(vram) : "—"}</span></div>
    </div>
  </div>`;
}

export async function loadDashboard(): Promise<void> {
  try {
    const [models, running] = await Promise.all([fetchModels(), refreshRunning()]);
    // One card per backend; an unreachable one says so on its own card.
    (document.getElementById("dash-backends") as HTMLElement).innerHTML = getBackends()
      .map((b) => backendCard(b.id, models, running))
      .join("");
    const totalDisk = models.reduce((sum, m) => sum + (m.size || 0), 0);
    (document.getElementById("dash-disk") as HTMLElement).textContent = fmtSize(totalDisk);
    (document.getElementById("dash-model-count") as HTMLElement).textContent = String(
      models.length,
    );
    (document.getElementById("dash-running-count") as HTMLElement).textContent = String(
      running.length,
    );
    const runList = document.getElementById("dash-running-list") as HTMLElement;
    if (running.length === 0) {
      runList.innerHTML =
        '<div class="empty"><i class="ti ti-player-pause" aria-hidden="true"></i>No models running</div>';
    } else {
      runList.innerHTML = running
        .map(
          (m) => `
        <div style="display:flex;align-items:center;justify-content:space-between;padding:10px 0;border-bottom:1px solid var(--border)">
          <span style="font-family:var(--mono);font-size:12px;color:var(--accent)">${escHtml(m.name)}</span>
          <div style="display:flex;gap:8px;align-items:center">
            ${backendBadge(m.backend)}
            <span class="badge running">running</span>
            <span class="badge">${fmtSize(m.size_vram || m.size || 0)}</span>
          </div>
        </div>`,
        )
        .join("");
    }
  } catch {
    toast("Dashboard load failed", "error");
  }
}

export function initDashboard(): void {
  document.getElementById("dash-refresh-btn")?.addEventListener("click", connect);
}
