import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeHtmlEntities, parseLibraryHtml } from "./library";

const FIXTURE_PATH = path.join(import.meta.dir, "__fixtures__", "library.sample.html");
const SAMPLE_HTML = readFileSync(FIXTURE_PATH, "utf-8");

describe("parseLibraryHtml", () => {
  const models = parseLibraryHtml(SAMPLE_HTML);
  const byName = new Map(models.map((m) => [m.name, m]));

  test("parses every card in the fixture", () => {
    expect(models.length).toBe(6);
  });

  test("plain model with a size badge and no capabilities", () => {
    const m = byName.get("alfred");
    expect(m).toBeDefined();
    expect(m?.capabilities).toEqual([]);
    expect(m?.sizes).toEqual(["40b"]);
    expect(m?.isCloud).toBe(false);
  });

  test("decodes HTML entities in the description", () => {
    const m = byName.get("llama3.2");
    expect(m?.description).toBe("Meta's Llama 3.2 goes small with 1B and 3B models.");
    expect(m?.description).not.toContain("&#39;");
  });

  test("classifies capability, size, and cloud badges independently", () => {
    const m = byName.get("gpt-oss");
    expect(m?.capabilities).toEqual(["tools", "thinking"]);
    expect(m?.sizes).toEqual(["20b", "120b"]);
    expect(m?.isCloud).toBe(true);
  });

  test("cloud-only model with no local size badges", () => {
    const m = byName.get("minimax-m2.7");
    expect(m?.isCloud).toBe(true);
    expect(m?.sizes).toEqual([]);
  });

  test("MoE-style size labels are captured as-is", () => {
    const m = byName.get("mixtral");
    expect(m?.sizes).toEqual(["8x7b", "8x22b"]);
  });

  test("sub-billion (million-scale) size labels are captured as-is", () => {
    const m = byName.get("all-minilm");
    expect(m?.sizes).toEqual(["23m", "335m"]);
  });

  test("badges never bleed across adjacent cards", () => {
    // alfred has no capabilities/cloud badge of its own — if the card boundary
    // regex were wrong, the next card's "tools" badge could leak in here.
    expect(byName.get("alfred")?.capabilities).toEqual([]);
    expect(byName.get("alfred")?.isCloud).toBe(false);
  });

  test("returns an empty list (not a throw) when no cards match", () => {
    // This is the actual historical failure mode: ollama.com redesigned the
    // page and the old x-test-model/x-test-capability selectors silently
    // matched nothing. The caller (src/index.ts _scrapeLibrary) is
    // responsible for treating an empty result as a scrape failure — this
    // test just pins the parser's own contract.
    expect(parseLibraryHtml("<html><body>no cards here</body></html>")).toEqual([]);
    expect(parseLibraryHtml('<li x-test-model><a href="/library/old">old</a></li>')).toEqual([]);
  });
});

describe("decodeHtmlEntities", () => {
  test("decodes common named entities", () => {
    expect(decodeHtmlEntities("Meta&#39;s &amp; Friends&quot;")).toBe("Meta's & Friends\"");
  });

  test("decodes numeric entities", () => {
    expect(decodeHtmlEntities("caf&#233;")).toBe("café");
  });

  test("trims surrounding whitespace", () => {
    expect(decodeHtmlEntities("  hello  ")).toBe("hello");
  });

  test("leaves plain text untouched", () => {
    expect(decodeHtmlEntities("no entities here")).toBe("no entities here");
  });
});
