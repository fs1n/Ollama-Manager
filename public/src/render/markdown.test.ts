import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown — XSS safety", () => {
  test("escapes raw HTML in model output before any markdown transform runs", () => {
    const out = renderMarkdown('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });

  test("does not double-escape text inside fenced code blocks", () => {
    const out = renderMarkdown("```\n<script>alert(1)</script>\n```");
    expect(out).not.toContain("<script>");
    expect(out).toContain("&lt;script&gt;");
    // the code block's own <pre><code> wrapper must remain live markup
    expect(out).toContain("<pre");
    expect(out).toContain("<code");
  });

  test("rejects unsafe link schemes but keeps safe ones", () => {
    const unsafe = renderMarkdown("[click me](javascript:alert(1))");
    expect(unsafe).not.toContain("<a ");

    const safe = renderMarkdown("[docs](https://example.com)");
    expect(safe).toContain('<a href="https://example.com"');
  });
});

describe("renderMarkdown — formatting", () => {
  test("renders bold, italic, inline code and line breaks", () => {
    const out = renderMarkdown("**bold** *italic* `code`\nnext line");
    expect(out).toContain("<strong>bold</strong>");
    expect(out).toContain("<em>italic</em>");
    expect(out).toContain("<code");
    expect(out).toContain("<br>");
  });

  test("renders headers, bullet and numbered lists", () => {
    expect(renderMarkdown("# Title")).toContain("<strong");
    expect(renderMarkdown("- item")).toContain("•");
    expect(renderMarkdown("1. item")).toContain("1.");
  });
});
