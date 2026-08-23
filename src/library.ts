// Parser for the ollama.com library catalog.
//
// Two server-rendered templates carry the same model cards:
//   - /library ......... single page with every model (<a class="group w-full space-y-5">)
//   - /search .......... HTMX-paginated variant (<a class="group w-full">) used as fallback
//                         when /library's markup moves out from under us
// The previous regex parser targeted exact Tailwind class strings and silently
// returned zero models when ollama.com changed them, so this parser anchors on
// the structure instead: each card is an <a href="/library/<name>"> whose badge
// spans are distinguished only by background color:
//   - bg-indigo-* ............ capability badge, e.g. "tools", "vision"
//   - bg-cyan-* .............. the "cloud" badge (model has a hosted cloud variant)
//   - bg-[#ddf4ff]/bg-blue-* . size badge, e.g. "7b", "8x22b" — but also non-param
//                              variant labels like "e2b"/"e4b" (Gemma), which we
//                              split into `variants` so size filters stay honest

import { parse as parseHtml } from "node-html-parser";

export interface LibraryModel {
  name: string;
  description: string;
  capabilities: string[];
  /** Parameter-size badges, e.g. "7b", "8x22b", "335m" */
  sizes: string[];
  /** Non-numeric size-slot badges, e.g. Gemma's "e2b"/"e4b" */
  variants: string[];
  isCloud: boolean;
  /** Raw pulls count as shown, e.g. "649.2K" */
  pulls: string;
  tagCount: number;
  /** Relative updated text as shown, e.g. "1 week ago" */
  updatedText: string;
  /** ISO timestamp parsed from the updated span's title="… UTC" */
  updatedAt: string | null;
}

export interface LibraryTag {
  name: string;
  size: string;
  context: string;
  input: string;
}

export interface LibraryModelDetail {
  name: string;
  tags: LibraryTag[];
  pulls: string;
  updatedText: string;
  updatedAt: string | null;
}

const SIZE_RE = /^\d+(?:\.\d+)?x\d+(?:\.\d+)?[bmk]$|^\d+(?:\.\d+)?[bmk]$/i;

/** Splits a size-slot badge into sizes vs. non-param variants (e2b/e4b). */
export function classifySizeBadge(label: string): "size" | "variant" {
  return SIZE_RE.test(label) ? "size" : "variant";
}

/** "Aug 14, 2026 4:54 PM UTC" → ISO string, or null when unparseable. */
export function parseUpdatedTitle(title: string): string | null {
  const ms = Date.parse(title);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export function parseLibraryHtml(html: string): LibraryModel[] {
  const root = parseHtml(html);
  const models: LibraryModel[] = [];

  for (const card of root.querySelectorAll('a[href^="/library/"]')) {
    const href = card.getAttribute("href") ?? "";
    const name = href.slice("/library/".length);
    // Cards link directly to /library/<name> — skip deeper links (:tag, /tags subpaths)
    if (!/^[a-z0-9][a-z0-9._-]*$/.test(name)) continue;

    // Description is the same <p> in both templates
    const descEl = card.querySelector("p.text-neutral-800") ?? card.querySelector("p.text-md");
    const description = descEl?.text.trim() ?? "";

    const capabilities: string[] = [];
    const sizes: string[] = [];
    const variants: string[] = [];
    let isCloud = false;

    for (const badge of card.querySelectorAll("span")) {
      const cls = badge.getAttribute("class") ?? "";
      if (!cls.includes("rounded-md")) continue;
      const label = badge.text.trim();
      if (!label) continue;
      if (cls.includes("bg-cyan")) {
        isCloud = true;
        capabilities.push("cloud");
      } else if (cls.includes("bg-indigo")) {
        capabilities.push(label);
      } else if (cls.includes("bg-[#ddf4ff]") || cls.includes("bg-blue")) {
        if (classifySizeBadge(label) === "size") sizes.push(label);
        else variants.push(label);
      }
    }

    // Meta row: pulls count, tag count, updated (span with title="… UTC")
    let pulls = "";
    let tagCount = 0;
    let updatedText = "";
    let updatedAt: string | null = null;

    const metaSpans = card.querySelectorAll("span.flex.items-center");
    for (const span of metaSpans) {
      const text = span.text.replace(/ /g, " ").trim();
      if (/\bPulls$/.test(text)) {
        pulls = text.replace(/\s*Pulls$/, "").trim();
      } else if (/\bTags$/.test(text)) {
        tagCount = parseInt(text.replace(/\s*Tags$/, "").trim(), 10) || 0;
      } else if (/\bUpdated\b/.test(text)) {
        updatedText = text.replace(/^Updated\s*/, "").trim();
        updatedAt = parseUpdatedTitle(span.getAttribute("title") ?? "");
      }
    }

    models.push({
      name,
      description,
      capabilities,
      sizes,
      variants,
      isCloud,
      pulls,
      tagCount,
      updatedText,
      updatedAt,
    });
  }

  return models;
}

/** True when the search page carries an HTMX marker loading /search?page=<page+1>. */
export function hasNextSearchPage(html: string, page: number): boolean {
  return html.includes(`hx-get="/search?page=${page + 1}"`);
}

/** Dedupe by model name, first occurrence wins (later pages may repeat cards). */
export function dedupeByName(models: LibraryModel[]): LibraryModel[] {
  const seen = new Set<string>();
  return models.filter((m) => {
    if (seen.has(m.name)) return false;
    seen.add(m.name);
    return true;
  });
}

/**
 * Parses the tag table on /library/<name>. Desktop rows are
 * <a href="/library/<name>:<tag>"> links followed by size/context/input cells;
 * mobile rows repeat the same tags, so we dedupe by tag name.
 */
export function parseLibraryDetailHtml(html: string, name: string): LibraryModelDetail {
  const root = parseHtml(html);
  const tags: LibraryTag[] = [];
  const seen = new Set<string>();

  const prefix = `/library/${name}:`;
  for (const link of root.querySelectorAll(`a[href^="${prefix}"]`)) {
    const tagName = (link.getAttribute("href") ?? "").slice(prefix.length);
    if (!tagName || seen.has(tagName)) continue;

    // Desktop row: the <a> sits in a grid row (class "sm:grid-cols-12 text-[13px]")
    // whose sibling <p> cells carry size/context/input. Mobile rows are <a> tags
    // themselves with a summary line — skipping them also dedupes the tag names.
    const row = link.closest("div[class*='grid-cols-12']");
    if (!row) continue;
    const cells = row.querySelectorAll("p[class*='col-span-2']");
    const cellText = cells.map((c) => c.text.trim());
    seen.add(tagName);
    tags.push({
      name: tagName,
      size: cellText[0] ?? "",
      context: cellText[1] ?? "",
      input: cellText[2] ?? "",
    });
  }

  // Page-level meta: "<n> Downloads" and the updated span's title="… UTC"
  let pulls = "";
  let updatedText = "";
  let updatedAt: string | null = null;
  for (const span of root.querySelectorAll("span.flex.items-center")) {
    const text = span.text.replace(/ /g, " ").trim();
    if (/\bDownloads$/.test(text)) {
      pulls = text.replace(/\s*Downloads$/, "").trim();
    } else if (/\bUpdated\b/.test(text)) {
      updatedText = text.replace(/^Updated\s*/, "").trim();
      updatedAt = parseUpdatedTitle(span.getAttribute("title") ?? "");
    }
  }

  return { name, tags, pulls, updatedText, updatedAt };
}
