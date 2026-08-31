import { describe, expect, test } from "bun:test";
import { baseName, escAttr, escHtml, fmtSize, parseModelSize, parsePulls } from "./format";

describe("fmtSize", () => {
  test("formats GB/MB/KB thresholds", () => {
    expect(fmtSize(4_900_000_000)).toBe("4.9 GB");
    expect(fmtSize(2_000_000)).toBe("2 MB");
    expect(fmtSize(500)).toBe("1 KB");
  });

  test("returns an em dash for falsy input", () => {
    expect(fmtSize(0)).toBe("—");
  });
});

describe("parsePulls", () => {
  test("parses plain numbers and K/M/B suffixes", () => {
    expect(parsePulls("42")).toBe(42);
    expect(parsePulls("649.2K")).toBe(649_200);
    expect(parsePulls("118.7M")).toBe(118_700_000);
    expect(parsePulls("1.2B")).toBe(1_200_000_000);
  });

  test("returns 0 for empty or unparseable input", () => {
    expect(parsePulls("")).toBe(0);
    expect(parsePulls(null)).toBe(0);
    expect(parsePulls("n/a")).toBe(0);
  });
});

describe("parseModelSize", () => {
  test("parses plain b/m sizes into billions-of-params", () => {
    expect(parseModelSize("7b")).toBe(7);
    expect(parseModelSize("335m")).toBeCloseTo(0.335);
  });

  test("parses MoE sizes (8x22b) as the product, not just the leading number", () => {
    expect(parseModelSize("8x22b")).toBe(176);
  });

  test("returns Infinity for missing/unparseable input so it sorts/filters last", () => {
    expect(parseModelSize(undefined)).toBe(Number.POSITIVE_INFINITY);
    expect(parseModelSize("latest")).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("escHtml", () => {
  test("escapes all five HTML-sensitive characters", () => {
    expect(escHtml(`<img onerror="x" src='y'>&`)).toBe(
      "&lt;img onerror=&quot;x&quot; src=&#39;y&#39;&gt;&amp;",
    );
  });
});

describe("baseName", () => {
  test("strips the tag from a name:tag pair", () => {
    expect(baseName("llama3.2:1b")).toBe("llama3.2");
  });

  test("returns the name unchanged when there is no tag", () => {
    expect(baseName("llama3.2")).toBe("llama3.2");
  });
});

describe("escAttr", () => {
  test("escapes for use inside a single-quoted JS string within an HTML attribute", () => {
    expect(escAttr(`it's a "test" <tag>\\`)).toBe("it\\'s a &quot;test&quot; &lt;tag&gt;\\\\");
  });
});
