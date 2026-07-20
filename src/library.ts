// Parser for the ollama.com/library registry catalog page.
//
// The page is server-rendered (no pagination — every model card is present in the
// initial HTML) but has no stable data-testid/x-test-* hooks; the DOM structure has
// changed at least once already (the previous parser targeted `x-test-model` /
// `x-test-capability` / `x-test-size` attributes that no longer exist on the live
// page, silently returning zero models). This parser keys off the one thing that's
// unlikely to move independently of a full redesign: each card is a link to
// `/library/<name>` wrapping a fixed Tailwind class, and its capability/size/cloud
// badges share one badge shape distinguished only by background color:
//   - bg-[#ddf4ff] ............ size badge, e.g. "7b", "8x22b", "335m"
//   - bg-indigo-50 ............ capability badge, e.g. "tools", "vision"
//   - bg-cyan-50 .............. the "cloud" badge (model has a hosted cloud variant)

export interface LibraryModel {
  name: string;
  description: string;
  capabilities: string[];
  sizes: string[];
  isCloud: boolean;
}

const CARD_START_RE = /<a href="\/library\/([a-z0-9][a-z0-9._-]*)" class="group w-full space-y-5">/;
const DESCRIPTION_RE = /text-neutral-800 text-md">([^<]*)<\/p>/;
const BADGE_RE = /class="inline-flex items-center rounded-md (bg-\S+)[^"]*">([^<]*)<\/span>/g;

const ENTITY_MAP: Record<string, string> = {
  "&#39;": "'",
  "&apos;": "'",
  "&quot;": '"',
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&nbsp;": " ",
};

export function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#39;|&apos;|&quot;|&amp;|&lt;|&gt;|&nbsp;/g, (m) => ENTITY_MAP[m] ?? m)
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(parseInt(code, 10)))
    .trim();
}

export function parseLibraryHtml(html: string): LibraryModel[] {
  const models: LibraryModel[] = [];
  const parts = html.split(CARD_START_RE);

  // split() with a single-capture-group regex interleaves the capture into the
  // result: [preamble, name1, body1, name2, body2, ..., trailingBody]
  for (let i = 1; i < parts.length; i += 2) {
    const name = parts[i];
    const body = parts[i + 1] ?? "";
    if (!name) continue;

    const descMatch = body.match(DESCRIPTION_RE);
    const description = descMatch ? decodeHtmlEntities(descMatch[1]) : "";

    const capabilities: string[] = [];
    const sizes: string[] = [];
    let isCloud = false;

    for (const m of body.matchAll(BADGE_RE)) {
      const bgClass = m[1];
      const label = m[2].trim();
      if (!label) continue;
      if (bgClass.startsWith("bg-indigo")) capabilities.push(label);
      else if (bgClass.startsWith("bg-cyan")) isCloud = true;
      else if (bgClass.startsWith("bg-[#ddf4ff]") || bgClass.startsWith("bg-blue"))
        sizes.push(label);
    }

    models.push({ name, description, capabilities, sizes, isCloud });
  }

  return models;
}
