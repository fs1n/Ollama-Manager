import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  dedupeByName,
  hasNextSearchPage,
  parseLibraryDetailHtml,
  parseLibraryHtml,
  parseUpdatedTitle,
} from "./library";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "..", "test", "fixtures", name), "utf-8");

describe("parseLibraryHtml — /library template (group w-full space-y-5)", () => {
  const models = parseLibraryHtml(fixture("library-llama3.1.html"));
  const m = models.find((x) => x.name === "llama3.1");

  test("finds the card", () => {
    expect(models.length).toBe(1);
    expect(m).toBeDefined();
  });

  test("extracts description", () => {
    expect(m?.description).toBe(
      "Llama 3.1 is a new state-of-the-art model from Meta available in 8B, 70B and 405B parameter sizes.",
    );
  });

  test("extracts capabilities from indigo badges", () => {
    expect(m?.capabilities).toEqual(["tools"]);
  });

  test("extracts param sizes, separating non-param variants", () => {
    expect(m?.sizes).toEqual(["8b", "70b", "405b"]);
    expect(m?.variants).toEqual([]);
  });

  test("extracts pulls, tag count and updated info", () => {
    expect(m?.pulls).toBe("118.7M");
    expect(m?.tagCount).toBe(93);
    expect(m?.updatedText).toBe("over a year ago");
    expect(m?.updatedAt).toBe("2024-11-30T22:34:00.000Z");
  });

  test("not cloud", () => {
    expect(m?.isCloud).toBe(false);
  });
});

describe("parseLibraryHtml — cloud + variant badges", () => {
  const models = parseLibraryHtml(fixture("library-gemma4.html"));
  const m = models.find((x) => x.name === "gemma4");

  test("cloud badge sets isCloud and adds 'cloud' capability", () => {
    expect(m?.isCloud).toBe(true);
    expect(m?.capabilities).toEqual(["vision", "tools", "thinking", "audio", "cloud"]);
  });

  test("e2b/e4b land in variants, not sizes", () => {
    expect(m?.sizes).toEqual(["12b", "26b", "31b"]);
    expect(m?.variants).toEqual(["e2b", "e4b"]);
  });
});

describe("parseLibraryHtml — /search template (group w-full, no space-y-5)", () => {
  const models = parseLibraryHtml(fixture("search-deepseek-v4-flash.html"));
  const m = models.find((x) => x.name === "deepseek-v4-flash");

  test("finds the card despite the different card class", () => {
    expect(m).toBeDefined();
    expect(m?.description).toContain("DeepSeek-V4-Flash is a preview");
  });

  test("capabilities + cloud", () => {
    expect(m?.capabilities).toEqual(["tools", "thinking", "cloud"]);
    expect(m?.isCloud).toBe(true);
  });

  test("meta fields present on the search template too", () => {
    expect(m?.pulls).toBeTruthy();
    expect(typeof m?.tagCount).toBe("number");
    expect(m?.updatedAt).not.toBeNull();
  });
});

describe("hasNextSearchPage", () => {
  test("true when a hx-get pagination marker for the next page exists", () => {
    expect(hasNextSearchPage(fixture("search-deepseek-v4-flash.html"), 1)).toBe(true);
  });

  test("false on the last page (no marker)", () => {
    expect(hasNextSearchPage(fixture("library-llama3.1.html"), 99)).toBe(false);
  });
});

describe("dedupeByName", () => {
  test("keeps first occurrence per name", () => {
    const base = parseLibraryHtml(fixture("library-llama3.1.html"))[0];
    const dupe = { ...base, description: "shorter" };
    const out = dedupeByName([base, dupe]);
    expect(out.length).toBe(1);
    expect(out[0].description).toBe(base.description);
  });
});

describe("parseUpdatedTitle", () => {
  test("parses the UTC title into ISO", () => {
    expect(parseUpdatedTitle("Aug 14, 2026 4:54 PM UTC")).toBe("2026-08-14T16:54:00.000Z");
    expect(parseUpdatedTitle("Nov 30, 2024 10:34 PM UTC")).toBe("2024-11-30T22:34:00.000Z");
  });

  test("returns null for garbage", () => {
    expect(parseUpdatedTitle("nope")).toBeNull();
    expect(parseUpdatedTitle("")).toBeNull();
  });
});

describe("parseLibraryDetailHtml — /library/<name> tag table", () => {
  const detail = parseLibraryDetailHtml(fixture("library-llama3.1-detail.html"), "llama3.1");

  test("extracts all desktop tag rows, deduped", () => {
    expect(detail.tags.map((t) => t.name)).toEqual(["latest", "8b", "70b", "405b"]);
  });

  test("each tag carries size, context and input type", () => {
    const latest = detail.tags[0];
    expect(latest.size).toBe("4.9GB");
    expect(latest.context).toBe("128K");
    expect(latest.input).toBe("Text");
  });

  test("extracts page-level downloads and updated timestamp", () => {
    expect(detail.pulls).toBe("118.7M");
    expect(detail.updatedAt).toBe("2024-11-30T22:34:00.000Z");
  });
});
