// Small shared pieces for showing several backends side by side: the backend
// badge on models, the filter chips, the "backend unreachable" banner and the
// target-backend <select> on the Pull/Copy pages.

import { backendLabel, getBackend, getBackends, hasMultipleBackends } from "../state/backends";
import { backendErrors } from "../state/models";
import type { BackendCapability, BackendFilter } from "../utils/backends";
import { escHtml } from "../utils/format";

/** Badge naming the model's backend; empty while only one backend exists. */
export function backendBadge(id: string): string {
  if (!hasMultipleBackends()) return "";
  const kind = getBackend(id)?.kind ?? "ollama";
  return `<span class="backend-badge backend-${escHtml(kind)}">${escHtml(backendLabel(id))}</span>`;
}

const FILTER_STORAGE_KEY = "om.backendFilter";
let backendFilter: BackendFilter = (() => {
  try {
    return localStorage.getItem(FILTER_STORAGE_KEY) || "all";
  } catch {
    return "all";
  }
})();

export function getBackendFilter(): BackendFilter {
  // A remembered filter for a backend that no longer exists falls back to all.
  if (backendFilter !== "all" && !getBackend(backendFilter)) return "all";
  return backendFilter;
}

export function setBackendFilter(value: BackendFilter): void {
  backendFilter = value;
  try {
    localStorage.setItem(FILTER_STORAGE_KEY, value);
  } catch {
    // storage unavailable (private mode) — filter just isn't remembered
  }
}

/** "All / Ollama / Ollaya" chips; empty while only one backend exists. */
export function backendFilterChips(): string {
  if (!hasMultipleBackends()) return "";
  const current = getBackendFilter();
  const chip = (value: string, label: string) =>
    `<button class="btn btn-sm backend-filter${current === value ? " active" : ""}" data-backend-filter="${escHtml(value)}">${escHtml(label)}</button>`;
  return `<div class="backend-filters">${chip("all", "All")}${getBackends()
    .map((b) => chip(b.id, b.label))
    .join("")}</div>`;
}

/** Warning banner for every backend whose last fetch failed. */
export function backendErrorBanner(): string {
  if (backendErrors.size === 0) return "";
  return [...backendErrors]
    .map(
      ([id, err]) =>
        `<div class="backend-warning"><i class="ti ti-alert-triangle" aria-hidden="true"></i> Could not load from ${escHtml(backendLabel(id))} (${escHtml(err)}). Showing the other backends.</div>`,
    )
    .join("");
}

/**
 * Fills a backend <select> with the backends that have `cap` (or all), keeping
 * the current choice. Its wrapper is hidden while there is nothing to choose.
 */
export function fillBackendSelect(selectId: string, wrapId: string, cap?: BackendCapability): void {
  const sel = document.getElementById(selectId) as HTMLSelectElement | null;
  const wrap = document.getElementById(wrapId);
  if (!sel) return;
  const options = getBackends().filter((b) => !cap || b.capabilities.includes(cap));
  const cur = sel.value;
  sel.innerHTML = options
    .map((b) => `<option value="${escHtml(b.id)}">${escHtml(b.label)}</option>`)
    .join("");
  if (cur && options.some((b) => b.id === cur)) sel.value = cur;
  if (wrap) wrap.style.display = options.length > 1 ? "" : "none";
}
