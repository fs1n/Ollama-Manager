import { api } from "../api";
import { ensureBackends, firstBackendOfKind } from "../state/backends";
import {
  type BackendModel,
  ensureModels,
  modelCache,
  refreshRunning,
  runningKeys,
} from "../state/models";
import { openModal } from "../ui/modal";
import { toast } from "../ui/toast";
import type { BackendKind } from "../utils/backends";
import { baseName, escAttr, escHtml, parseModelSize, parsePulls } from "../utils/format";
import { setPullTarget, showModel } from "./models";

interface CatalogModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  variants: string[];
  isCloud: boolean;
  pulls: string;
  tagCount: number;
  updatedText: string;
  updatedAt: string | null;
}

interface CatalogTag {
  name: string;
  size: string;
  context: string;
  input: string;
}

/** One model of ollaya.dev's index, as served by /api/catalog/ollaya */
interface OllayaCatalogModel {
  name: string;
  description: string;
  capabilities: string[];
  rank: number | null;
  updated: string | null;
  tags: { name: string; summary: string }[];
}

// Two registries: ollama.com (scraped) for Ollama, ollaya.dev (JSON index)
// for Ollaya. The ollaya.dev source only appears when an Ollaya backend exists.
type CatalogSource = "ollama" | "ollaya";
let catSource: CatalogSource = "ollama";
let ollayaData: OllayaCatalogModel[] = [];

let catalogData: CatalogModel[] = [];
let catCapFilter = "all";
let catSort = "az";
let catView = "all";
let catalogDebounce: ReturnType<typeof setTimeout> | undefined;

function renderCaps(caps: string[] | undefined): string {
  return (caps || []).map((c) => `<span class="cap-badge cap-${c}">${c}</span>`).join("");
}

function renderSizes(sizes: string[] | undefined, variants: string[] | undefined): string {
  const s = (sizes || []).map((x) => `<span class="size-badge">${x}</span>`).join("");
  const v = (variants || [])
    .map(
      (x) =>
        `<span class="size-badge variant" title="Named variant, not a parameter count">${x}</span>`,
    )
    .join("");
  return s + v;
}

function debouncedFilterCatalog(): void {
  clearTimeout(catalogDebounce);
  catalogDebounce = setTimeout(renderCatalog, 150);
}

function clearCatalogSearch(): void {
  const input = document.getElementById("catalog-search") as HTMLInputElement;
  input.value = "";
  input.focus();
  renderCatalog();
}

function setCatalogSort(val: string): void {
  catSort = val;
  renderCatalog();
}

// Installed/running state for a catalog is judged against the models on the
// backends of the matching kind only (an Ollama "nli" is not Ollaya's "nli").
function modelsOfKind(kind: BackendKind): BackendModel[] {
  const backend = firstBackendOfKind(kind);
  return backend ? modelCache.filter((m) => m.backend === backend.id) : [];
}

function runningBaseNamesOfKind(kind: BackendKind): Set<string> {
  const backend = firstBackendOfKind(kind);
  const prefix = backend ? `${backend.id}/` : "\0";
  return new Set(
    [...runningKeys]
      .filter((k) => k.startsWith(prefix))
      .map((k) => baseName(k.slice(prefix.length))),
  );
}

export async function loadCatalog(): Promise<void> {
  const wrap = document.getElementById("catalog-wrap") as HTMLElement;
  wrap.innerHTML = '<div class="empty"><span class="spinner"></span> Loading catalog…</div>';
  try {
    if (catSource === "ollaya") {
      const r = await api("/api/catalog/ollaya");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      ollayaData = d.models || [];
      renderCatalog();
      toast(`Loaded ${ollayaData.length} models from ollaya.dev`, "success");
      return;
    }
    const r = await api("/api/catalog/library");
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    catalogData = d.models || [];
    renderCatalog();
    toast(`Loaded ${catalogData.length} models from registry`, "success");
  } catch (e: any) {
    wrap.innerHTML =
      '<div class="empty"><i class="ti ti-alert-circle" aria-hidden="true"></i>Failed to load catalog</div>';
    toast(`Catalog load failed: ${e.message}`, "error");
  }
}

function setCatCap(val: string): void {
  document.querySelectorAll<HTMLElement>(".cat-cap").forEach((b) => {
    b.classList.toggle("active", b.dataset.cap === val);
  });
  catCapFilter = val;
  renderCatalog();
}

function setCatView(val: string): void {
  document.querySelectorAll<HTMLElement>(".cat-view").forEach((b) => {
    b.classList.toggle("active", b.dataset.view === val);
  });
  catView = val;
  renderCatalog();
}

function renderOllayaCatalog(q: string): void {
  const installed = modelsOfKind("ollaya");
  const installedNames = new Set(installed.map((m) => m.name));
  const installedBaseNames = new Set(installed.map((m) => baseName(m.name)));
  const runningBaseNames = runningBaseNamesOfKind("ollaya");
  const firstInstalledMap = new Map<string, string>();
  for (const m of installed) {
    const base = baseName(m.name);
    if (!firstInstalledMap.has(base)) firstInstalledMap.set(base, m.key);
  }

  const filtered = ollayaData.filter((m) => {
    if (
      q &&
      !m.name.toLowerCase().includes(q) &&
      !(m.description || "").toLowerCase().includes(q) &&
      !m.capabilities.some((c) => c.toLowerCase().includes(q))
    )
      return false;
    if (catView === "installed" && !installedBaseNames.has(m.name)) return false;
    if (catView === "running" && !runningBaseNames.has(m.name)) return false;
    return true;
  });
  filtered.sort((a, b) => {
    // "popular" is ollaya.dev's editorial rank: it publishes no pull counts.
    if (catSort === "popular") return (a.rank ?? Infinity) - (b.rank ?? Infinity);
    if (catSort === "newest") return (b.updated || "").localeCompare(a.updated || "");
    const cmp = a.name.localeCompare(b.name);
    return catSort === "za" ? -cmp : cmp;
  });

  (document.getElementById("catalog-count") as HTMLElement).textContent =
    `${filtered.length} models`;
  const wrap = document.getElementById("catalog-wrap") as HTMLElement;
  if (filtered.length === 0) {
    wrap.innerHTML =
      '<div class="empty"><i class="ti ti-search" aria-hidden="true"></i>No models match</div>';
    return;
  }
  wrap.innerHTML = `<div class="catalog-grid">${filtered
    .map((m) => {
      const inst = installedBaseNames.has(m.name);
      const running = runningBaseNames.has(m.name);
      const firstInstalled = firstInstalledMap.get(m.name) || "";
      const tags = m.tags.length ? m.tags : [{ name: `${m.name}:latest`, summary: "" }];
      return `<div class="catalog-card${inst ? " installed" : ""}">
      <div class="catalog-name">
        ${running ? '<span class="running-dot" title="Running"></span>' : ""}
        <span>${escHtml(m.name)}</span>
        ${inst ? '<span class="installed-badge">installed</span>' : ""}
      </div>
      ${m.description ? `<div class="catalog-desc">${escHtml(m.description)}</div>` : ""}
      <div class="catalog-badges">${m.capabilities.map((c) => `<span class="cap-badge cap-ollaya">${escHtml(c)}</span>`).join("")}</div>
      <div class="catalog-tags">${tags
        .map((t) => {
          const have = installedNames.has(t.name);
          return `<button class="tag-chip${have ? " installed" : ""}" data-action="ollaya-pull" data-tag="${escHtml(t.name)}" title="${escHtml(t.summary || (have ? "Installed — pull again to update" : "Pull"))}">${escHtml(t.name)}${have ? ' <i class="ti ti-check" aria-hidden="true"></i>' : ""}</button>`;
        })
        .join("")}</div>
      <div class="catalog-meta">
        ${m.updated ? `<span title="Updated"><i class="ti ti-clock" aria-hidden="true"></i>${escHtml(m.updated)}</span>` : ""}
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        ${inst ? `<button class="btn btn-sm" style="flex:1" data-action="info-key" data-key="${escHtml(firstInstalled)}"><i class="ti ti-info-circle" aria-hidden="true"></i> Details</button>` : ""}
        <a class="btn btn-sm" href="https://ollaya.dev/library/${encodeURIComponent(m.name)}" target="_blank" rel="noopener" title="View on ollaya.dev">
          <i class="ti ti-external-link" aria-hidden="true"></i>
        </a>
      </div>
    </div>`;
    })
    .join("")}</div>`;
}

function renderCatalog(): void {
  const q = (
    (document.getElementById("catalog-search") as HTMLInputElement).value || ""
  ).toLowerCase();
  if (catSource === "ollaya") {
    renderOllayaCatalog(q);
    return;
  }
  const sizeFilter = (document.getElementById("catalog-size") as HTMLSelectElement).value;
  const installed = modelsOfKind("ollama");
  const installedBaseNames = new Set(installed.map((m) => baseName(m.name)));
  const runningBaseNames = runningBaseNamesOfKind("ollama");
  // First-wins: if multiple installed tags share a base name (e.g. llama3.2:1b
  // and llama3.2:3b), the catalog card's "Details" button should open the
  // first one found, not whichever happened to be inserted into the Map last.
  const firstInstalledMap = new Map<string, string>();
  for (const m of installed) {
    const base = baseName(m.name);
    if (!firstInstalledMap.has(base)) firstInstalledMap.set(base, m.key);
  }

  const filtered = catalogData.filter((m) => {
    if (q && !m.name.toLowerCase().includes(q) && !(m.description || "").toLowerCase().includes(q))
      return false;
    if (catCapFilter !== "all" && !m.capabilities.includes(catCapFilter)) return false;
    if (sizeFilter !== "any") {
      const max = Number.parseFloat(sizeFilter);
      const hasMatch = (m.sizes || []).some((s) => parseModelSize(s) <= max);
      if (!hasMatch) return false;
    }
    const inst = installedBaseNames.has(m.name);
    if (catView === "installed" && !inst) return false;
    if (catView === "running" && !runningBaseNames.has(m.name)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (catSort === "popular") return parsePulls(b.pulls) - parsePulls(a.pulls);
    if (catSort === "newest") return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    const cmp = a.name.localeCompare(b.name);
    return catSort === "za" ? -cmp : cmp;
  });

  (document.getElementById("catalog-count") as HTMLElement).textContent =
    `${filtered.length} models`;
  if (filtered.length === 0) {
    (document.getElementById("catalog-wrap") as HTMLElement).innerHTML =
      '<div class="empty"><i class="ti ti-search" aria-hidden="true"></i>No models match</div>';
    return;
  }
  (document.getElementById("catalog-wrap") as HTMLElement).innerHTML =
    `<div class="catalog-grid">${filtered
      .map((m) => {
        const inst = installedBaseNames.has(m.name);
        const running = runningBaseNames.has(m.name);
        const firstInstalled = firstInstalledMap.get(m.name) || "";
        return `<div class="catalog-card${inst ? " installed" : ""}">
      <div class="catalog-name">
        ${running ? '<span class="running-dot" title="Running"></span>' : ""}
        <span>${escHtml(m.name)}</span>
        ${inst ? '<span class="installed-badge">installed</span>' : ""}
      </div>
      ${m.description ? `<div class="catalog-desc">${escHtml(m.description)}</div>` : ""}
      <div class="catalog-badges">${renderCaps(m.capabilities)}${renderSizes(m.sizes, m.variants)}</div>
      <div class="catalog-meta">
        ${m.pulls ? `<span title="Pulls from ollama.com"><i class="ti ti-download" aria-hidden="true"></i>${escHtml(m.pulls)}</span>` : ""}
        ${m.tagCount ? `<span title="Tags"><i class="ti ti-tag" aria-hidden="true"></i>${m.tagCount}</span>` : ""}
        ${m.updatedText ? `<span title="${m.updatedAt ? escAttr(new Date(m.updatedAt).toLocaleString()) : "Updated"}"><i class="ti ti-clock" aria-hidden="true"></i>${escHtml(m.updatedText)}</span>` : ""}
      </div>
      <div style="display:flex;gap:8px;margin-top:4px">
        ${
          inst
            ? `<button class="btn btn-sm" style="flex:1" data-action="info-key" data-key="${escHtml(firstInstalled)}"><i class="ti ti-info-circle" aria-hidden="true"></i> Details</button>`
            : `<button class="btn btn-sm btn-primary" style="flex:1" data-action="quick-pull" data-model="${escHtml(m.name)}"><i class="ti ti-download" aria-hidden="true"></i> Pull</button>`
        }
        <a class="btn btn-sm" href="https://ollama.com/library/${encodeURIComponent(baseName(m.name))}" target="_blank" rel="noopener" title="View on ollama.com">
          <i class="ti ti-external-link" aria-hidden="true"></i>
        </a>
      </div>
    </div>`;
      })
      .join("")}</div>`;
}

function showTagPicker(name: string): void {
  const m = catalogData.find((x) => x.name === name);
  if (!m) return;
  // Index-derived chips for instant render; replaced by the real tag table
  // once the detail scrape lands.
  const sizes = [...(m.sizes || []), ...(m.variants || [])];
  const isCloud = m.isCloud;
  const tags =
    sizes.length > 0
      ? ["latest", ...sizes.filter((s) => s !== "latest"), ...(isCloud ? ["cloud"] : [])]
      : isCloud
        ? ["cloud"]
        : ["latest"];
  const installedNames = new Set(modelsOfKind("ollama").map((x) => x.name));

  const content = `<div style="font-family:var(--sans);font-size:13px;color:var(--text2);margin-bottom:16px">${escHtml(m.description || "")}</div>
    <div style="display:flex;flex-direction:column;gap:8px">
      ${tags
        .map((t) => {
          const fullTag = `${name}:${t}`;
          const installed = installedNames.has(fullTag);
          return `<button class="tag-pick-btn${installed ? " installed" : ""}"
          data-action="pull-tag" data-tag="${escAttr(fullTag)}"
          ${installed ? "disabled" : ""}>
          <span style="font-family:var(--mono);font-size:13px;color:var(--text)">${escHtml(fullTag)}</span>
          ${t === "latest" ? '<span class="badge">default</span>' : ""}
          ${t === "cloud" ? '<span class="cap-badge cap-cloud">cloud</span>' : ""}
          ${installed ? '<span class="installed-badge">already installed</span>' : '<span class="cap-badge cap-tools" style="margin-left:auto">pull</span>'}
        </button>`;
        })
        .join("")}
    </div>`;
  openModal(`Pull ${name}`, content, { rich: true });
}

function pullTag(name: string, kind: BackendKind = "ollama"): void {
  document.getElementById("modal-overlay")?.classList.remove("open");
  const backend = firstBackendOfKind(kind);
  if (!backend) return;
  setPullTarget(backend.id, name);
}

async function loadCatalogDetailTags(name: string): Promise<void> {
  const box = document.getElementById("catalog-detail-tags");
  if (!box) return;
  const m = catalogData.find((x) => x.name === name);
  const fallback = `<div style="margin-bottom:8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em">Sizes</div>
    <div>${renderSizes(m?.sizes, m?.variants) || '<span style="color:var(--text3);font-size:12px">various</span>'}</div>`;
  try {
    const r = await api(`/api/catalog/library/${encodeURIComponent(name)}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    if (!document.getElementById("catalog-detail-tags")) return; // modal already closed/replaced
    const tags: CatalogTag[] = d.tags || [];
    if (tags.length === 0) {
      box.innerHTML = fallback;
      return;
    }
    box.innerHTML = `<div style="margin-bottom:8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em">Tags (${tags.length}${d.stale ? " · cached" : ""})</div>
      <div class="table-wrap"><table>
        <thead><tr><th>Tag</th><th>Size</th><th>Context</th><th>Input</th></tr></thead>
        <tbody>${tags
          .map(
            (t) =>
              `<tr><td style="font-family:var(--mono);font-size:12px">${escHtml(name)}:${escHtml(t.name)}</td><td>${escHtml(t.size || "—")}</td><td>${escHtml(t.context || "—")}</td><td>${escHtml(t.input || "—")}</td></tr>`,
          )
          .join("")}</tbody>
      </table></div>`;
  } catch {
    if (document.getElementById("catalog-detail-tags")) box.innerHTML = fallback;
  }
}

function showCatalogDetail(name: string): void {
  const m = catalogData.find((x) => x.name === name);
  if (!m) return;
  const inst = modelsOfKind("ollama").some((x) => baseName(x.name) === name);
  const running = runningBaseNamesOfKind("ollama").has(name);
  const content = `<div style="font-family:var(--sans);font-size:13px;line-height:1.7;color:var(--text)">
      <div style="margin-bottom:16px;display:flex;gap:8px;flex-wrap:wrap;align-items:center">
        ${inst ? '<span class="installed-badge">installed</span>' : ""}
        ${running ? '<span class="badge running">running</span>' : ""}
        ${!inst ? '<span class="badge">not installed</span>' : ""}
        ${m.pulls ? `<span class="badge">↓ ${escHtml(m.pulls)} pulls</span>` : ""}
        ${m.updatedText ? `<span class="badge">updated ${escHtml(m.updatedText)}</span>` : ""}
      </div>
      ${m.description ? `<p style="margin-bottom:16px;color:var(--text2)">${escHtml(m.description)}</p>` : ""}
      <div style="margin-bottom:8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em">Capabilities</div>
      <div style="margin-bottom:16px">${renderCaps(m.capabilities) || '<span style="color:var(--text3);font-size:12px">none</span>'}</div>
      <div id="catalog-detail-tags" style="margin-bottom:16px">
        <div style="margin-bottom:8px;font-size:11px;color:var(--text3);text-transform:uppercase;letter-spacing:0.05em">Tags</div>
        <div class="empty" style="padding:12px"><span class="spinner"></span> Loading tag list…</div>
      </div>
      <a href="https://ollama.com/library/${encodeURIComponent(baseName(name))}" target="_blank" rel="noopener" class="btn btn-sm" style="display:inline-flex">
        <i class="ti ti-external-link" aria-hidden="true"></i> View on ollama.com
      </a>
    </div>`;
  openModal(name, content, { rich: true, focus: true });
  loadCatalogDetailTags(name);
}

// The ollaya.dev source (and its toggle) only exists with an Ollaya backend.
// Filters that only make sense for ollama.com (size, ollama.com capability
// badges) are hidden on the ollaya.dev source.
function applySourceUi(): void {
  const hasOllaya = !!firstBackendOfKind("ollaya");
  if (!hasOllaya) catSource = "ollama";
  (document.getElementById("catalog-source-toggle") as HTMLElement).style.display = hasOllaya
    ? ""
    : "none";
  document.querySelectorAll<HTMLElement>(".cat-source").forEach((b) => {
    b.classList.toggle("active", b.dataset.source === catSource);
  });
  const ollaya = catSource === "ollaya";
  (document.getElementById("catalog-size") as HTMLElement).style.display = ollaya ? "none" : "";
  document.querySelectorAll<HTMLElement>(".cat-cap").forEach((b) => {
    b.style.display = ollaya ? "none" : "";
  });
  const popular = document.querySelector<HTMLOptionElement>(
    '#catalog-sort option[value="popular"]',
  );
  if (popular) popular.textContent = ollaya ? "Featured" : "Most pulled";
  (document.getElementById("catalog-sub") as HTMLElement).textContent = ollaya
    ? "Decision models on ollaya.dev — pick a tag to pull it into Ollaya"
    : "All models available on ollama.com — click to pull";
}

function setCatSource(val: CatalogSource): void {
  if (val === catSource) return;
  catSource = val;
  applySourceUi();
  const loaded = catSource === "ollaya" ? ollayaData.length : catalogData.length;
  if (loaded) renderCatalog();
  else loadCatalog();
}

export async function loadCatalogTab(): Promise<void> {
  await ensureBackends();
  applySourceUi();
  // Installed/running markers need both lists; render once they are in.
  await Promise.all([ensureModels(), refreshRunning()]);
  const loaded = catSource === "ollaya" ? ollayaData.length : catalogData.length;
  if (loaded) renderCatalog();
  else loadCatalog();
}

export function initCatalog(): void {
  document.getElementById("catalog-refresh-btn")?.addEventListener("click", loadCatalog);
  document.getElementById("catalog-search-clear")?.addEventListener("click", clearCatalogSearch);
  document.getElementById("catalog-search")?.addEventListener("input", debouncedFilterCatalog);
  document.getElementById("catalog-search")?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      clearCatalogSearch();
    }
  });
  document.getElementById("catalog-size")?.addEventListener("change", renderCatalog);
  document.getElementById("catalog-sort")?.addEventListener("change", (e) => {
    setCatalogSort((e.target as HTMLSelectElement).value);
  });

  document.getElementById("catalog-cap-filters")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-cap]");
    if (btn?.dataset.cap) setCatCap(btn.dataset.cap);
  });

  document.getElementById("catalog-source-toggle")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-source]");
    if (btn?.dataset.source === "ollama" || btn?.dataset.source === "ollaya") {
      setCatSource(btn.dataset.source);
    }
  });

  document.getElementById("catalog-view-toggle")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-view]");
    if (btn?.dataset.view) setCatView(btn.dataset.view);
  });

  document.getElementById("catalog-wrap")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "info-key" && btn.dataset.key) {
      // The installed list can be stale (model deleted meanwhile): fall back
      // to the registry's own detail view for ollama.com models.
      const key = btn.dataset.key;
      if (modelCache.some((x) => x.key === key)) showModel(key);
      else if (catSource === "ollama") showCatalogDetail(baseName(key.slice(key.indexOf("/") + 1)));
    }
    if (btn.dataset.action === "ollaya-pull" && btn.dataset.tag) pullTag(btn.dataset.tag, "ollaya");
    const model = btn.dataset.model;
    if (!model) return;
    if (btn.dataset.action === "quick-pull") showTagPicker(model);
  });

  // Delegated: tag-pick buttons live inside the (dynamically-populated) modal
  // body, rendered by showTagPicker() above.
  document.getElementById("modal-body")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-action="pull-tag"]');
    if (btn?.dataset.tag) pullTag(btn.dataset.tag);
  });
}
