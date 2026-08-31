import { apiOk } from "../api";
import { modelCache, type OllamaModel, setModelCache, setRunningNames } from "../state/models";
import { toast } from "../ui/toast";
import { escHtml, fmtSize } from "../utils/format";

function setStatus(ok: boolean, version: string): void {
  const dot = document.getElementById("status-dot") as HTMLElement;
  const txt = document.getElementById("status-text") as HTMLElement;
  dot.className = `status-dot ${ok ? "connected" : "error"}`;
  txt.textContent = ok
    ? version && version !== "unknown"
      ? `v${version}`
      : "unknown"
    : "unreachable";
}

export async function loadAppVersion(): Promise<void> {
  try {
    const r = await fetch("/api/app-version");
    if (!r.ok) return;
    const d = await r.json();
    if (d.version) {
      const el = document.getElementById("version-badge") as HTMLElement;
      // Unlike Ollama's own version (shown in the header status badge), this
      // is OLLAMA_MANAGER_VERSION — an arbitrary build-time string, not
      // necessarily semver (e.g. a CI run might set it to a branch/PR name).
      // Label it explicitly instead of guessing a "v" prefix onto it, so it
      // reads clearly next to Ollama's own "vX.Y.Z" badge instead of looking
      // like a second, differently-formatted version number.
      el.textContent = `Manager: ${d.version}`;
    }
  } catch {
    // version badge just stays blank — not worth surfacing an error for
  }
}

let lastKnownConnected: boolean | null = null;

export async function connect(): Promise<void> {
  try {
    const r = await apiOk("/api/version");
    const d = await r.json();
    const version = d.version || "unknown";
    setStatus(true, version);
    (document.getElementById("dash-version") as HTMLElement).textContent = version;
    // Only toast on an actual state change, not on every manual refresh.
    if (lastKnownConnected !== true) toast(`Connected to Ollama ${version}`, "success");
    lastKnownConnected = true;
    await loadDashboard();
  } catch {
    setStatus(false, "");
    (document.getElementById("dash-version") as HTMLElement).textContent = "—";
    if (lastKnownConnected !== false) toast("Ollama unreachable", "error");
    lastKnownConnected = false;
  }
}

export async function loadDashboard(): Promise<void> {
  try {
    const [modR, runR] = await Promise.all([apiOk("/api/tags"), apiOk("/api/ps")]);
    const modD = await modR.json();
    const runD = await runR.json();
    setModelCache(modD.models || []);
    const running: OllamaModel[] = runD.models || [];
    setRunningNames(new Set(running.map((m) => m.name)));
    const totalDisk = modelCache.reduce((sum, m) => sum + (m.size || 0), 0);
    (document.getElementById("dash-disk") as HTMLElement).textContent = fmtSize(totalDisk);
    (document.getElementById("dash-model-count") as HTMLElement).textContent = String(
      modelCache.length,
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
