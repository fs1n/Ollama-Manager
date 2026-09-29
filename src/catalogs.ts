// The two model registries the web UI browses: ollama.com (scraped HTML, with
// a /search fallback and on-demand per-model detail pages) and ollaya.dev (a
// static JSON index). Everything fetched is cached via src/cache.ts.
import { createTtlCache } from "./cache";
import { clip, type FetchFn, jsonError, log } from "./http";
import {
  dedupeByName,
  hasNextSearchPage,
  type LibraryModel,
  type LibraryModelDetail,
  type OllayaCatalogModel,
  parseLibraryDetailHtml,
  parseLibraryHtml,
  parseOllayaSearchIndex,
} from "./library";

const SCRAPE_TIMEOUT_MS = 10_000;
const LIBRARY_TTL_MS = 3600_000;
// Detail pages change far less often than the index, so a longer TTL and one
// cached entry per model name keeps ollama.com load trivial.
const DETAIL_TTL_MS = 6 * 3600_000;
const MAX_DETAIL_ENTRIES = 500;
const OLLAYA_CATALOG_URL = "https://ollaya.dev/search.json";

const SCRAPE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
};

/** A model name as ollama.com uses it in /library/<name> URLs. */
export const LIBRARY_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

function scrapeFetch(fetchFn: FetchFn, url: string, headers: Record<string, string> = {}) {
  return fetchFn(url, {
    headers: { ...SCRAPE_HEADERS, ...headers },
    credentials: "omit",
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
}

/** Dedupes consecutive pages only — stops as soon as a page repeats cards. */
async function scrapeSearchFallback(fetchFn: FetchFn): Promise<LibraryModel[]> {
  const all: LibraryModel[] = [];
  let lastCount = 0;

  // /search serves 20 cards per page and signals the next page via an HTMX
  // hx-get="?page=N+1" marker; a missing marker means we've reached the end.
  for (let page = 1; page <= 50; page++) {
    const resp = await scrapeFetch(fetchFn, `https://ollama.com/search?page=${page}`, {
      "HX-Request": "true",
    });
    if (!resp.ok) throw new Error(`search page ${page}: HTTP ${resp.status}`);

    const html = await resp.text();
    all.push(...parseLibraryHtml(html));

    const deduped = dedupeByName(all);
    if (deduped.length <= lastCount) break; // page repeated cards — done
    lastCount = deduped.length;
    if (!hasNextSearchPage(html, page)) break;
  }

  return dedupeByName(all);
}

export async function scrapeLibraryWithFallback(fetchFn: FetchFn = fetch): Promise<LibraryModel[]> {
  const resp = await scrapeFetch(fetchFn, "https://ollama.com/library");
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const models = parseLibraryHtml(await resp.text());
  if (models.length > 0) return models;

  // /library parsed to zero — the page markup moved. Fall back to the second
  // template (/search, HTMX-paginated) before treating this as a scrape failure.
  log("warn", "/library parsed 0 models, falling back to /search pagination");
  const fallback = await scrapeSearchFallback(fetchFn);
  if (fallback.length === 0) {
    throw new Error("Parsed 0 models from both /library and /search — selectors are stale");
  }
  return fallback;
}

export async function fetchOllayaCatalog(fetchFn: FetchFn = fetch): Promise<OllayaCatalogModel[]> {
  const resp = await scrapeFetch(fetchFn, OLLAYA_CATALOG_URL, { Accept: "application/json" });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const models = parseOllayaSearchIndex(await resp.json());
  if (models.length === 0) throw new Error("ollaya.dev index parsed to 0 models");
  return models;
}

class NotFoundError extends Error {}

/** Response envelope shared by all catalog routes: the data plus cache flags. */
function catalogResponse<T extends object>(data: T, fresh: boolean, stale: boolean): Response {
  return Response.json({ ...data, cached: fresh, stale });
}

export function createCatalogs({
  fetchFn = fetch as FetchFn,
  retryDelayMs = 1000,
}: {
  fetchFn?: FetchFn;
  retryDelayMs?: number;
} = {}) {
  const library = createTtlCache<"library", LibraryModel[]>({ ttlMs: LIBRARY_TTL_MS });
  const details = createTtlCache<string, LibraryModelDetail>({
    ttlMs: DETAIL_TTL_MS,
    maxEntries: MAX_DETAIL_ENTRIES,
  });
  const ollaya = createTtlCache<"ollaya", OllayaCatalogModel[]>({ ttlMs: LIBRARY_TTL_MS });

  // ollama.com is scraped with retries and exponential backoff; the stale
  // fallback of the cache takes over once all attempts failed.
  async function scrapeLibraryWithRetries(): Promise<LibraryModel[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await Bun.sleep(retryDelayMs * 2 ** (attempt - 1));
      try {
        const models = await scrapeLibraryWithFallback(fetchFn);
        log("info", "Library scraped", { count: models.length });
        return models;
      } catch (err) {
        lastErr = err;
        log("warn", "Library scrape attempt failed", { attempt: attempt + 1, error: String(err) });
      }
    }
    throw lastErr;
  }

  async function scrapeDetail(name: string): Promise<LibraryModelDetail> {
    const resp = await scrapeFetch(fetchFn, `https://ollama.com/library/${name}`);
    if (resp.status === 404) throw new NotFoundError("Model not found in registry");
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const detail = parseLibraryDetailHtml(await resp.text(), name);
    if (detail.tags.length === 0 && !detail.pulls) {
      throw new Error("Detail page parsed empty — selectors may be stale");
    }
    return detail;
  }

  return {
    async serveLibrary(): Promise<Response> {
      try {
        const r = await library.get("library", scrapeLibraryWithRetries);
        return catalogResponse({ models: r.value }, r.fresh, r.stale);
      } catch (err) {
        log("error", "Failed to serve library catalog", { error: String(err) });
        return jsonError("Failed to fetch library catalog");
      }
    },

    async serveLibraryDetail(name: string): Promise<Response> {
      if (!LIBRARY_NAME_RE.test(name)) return jsonError("Invalid model name", 400);
      try {
        const r = await details.get(name, () => scrapeDetail(name));
        return catalogResponse(r.value, r.fresh, r.stale);
      } catch (err) {
        if (err instanceof NotFoundError) return jsonError(err.message, 404);
        log("warn", "Library detail scrape failed", {
          name: clip(name, 100),
          error: clip(String(err)),
        });
        return jsonError("Failed to fetch model details");
      }
    },

    async serveOllayaCatalog(): Promise<Response> {
      try {
        const r = await ollaya.get("ollaya", () => fetchOllayaCatalog(fetchFn));
        return catalogResponse({ models: r.value }, r.fresh, r.stale);
      } catch (err) {
        log("warn", "ollaya.dev catalog fetch failed", { error: String(err) });
        return jsonError("Failed to fetch ollaya.dev catalog");
      }
    },

    /** Drops long-expired entries (run periodically). */
    sweep(): void {
      library.sweep();
      details.sweep();
      ollaya.sweep();
    },

    detailCacheSize: () => details.size,
  };
}

export type Catalogs = ReturnType<typeof createCatalogs>;
