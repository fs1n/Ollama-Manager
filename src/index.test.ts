import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { scrapeLibraryWithFallback } from "./index";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "..", "test", "fixtures", name), "utf-8");

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });

describe("scrapeLibraryWithFallback", () => {
  test("returns /library models without touching /search", async () => {
    const fetchFn = mock((url: string) => {
      if (url === "https://ollama.com/library")
        return Promise.resolve(htmlResponse(fixture("library-llama3.1.html")));
      throw new Error(`/search should not be fetched, got ${url}`);
    });

    const models = await scrapeLibraryWithFallback(fetchFn);
    expect(models.map((m) => m.name)).toEqual(["llama3.1"]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  test("falls back to /search and paginates until the hx-get marker disappears", async () => {
    const page1 = fixture("search-deepseek-v4-flash.html"); // contains hx-get=?page=2 marker
    const page2 = fixture("library-llama3.1.html"); // no marker → stop here

    const fetchFn = mock((url: string) => {
      if (url === "https://ollama.com/library")
        return Promise.resolve(htmlResponse("<html><body>redesigned!</body></html>"));
      if (url === "https://ollama.com/search?page=1") {
        return Promise.resolve(htmlResponse(page1));
      }
      if (url === "https://ollama.com/search?page=2") {
        return Promise.resolve(htmlResponse(page2));
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const models = await scrapeLibraryWithFallback(fetchFn);
    expect(models.map((m) => m.name)).toEqual(["deepseek-v4-flash", "llama3.1"]);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  test("dedupes cards repeated across search pages", async () => {
    const page = fixture("search-deepseek-v4-flash.html");
    let calls = 0;
    const fetchFn = mock((_url: string) => {
      calls++;
      return Promise.resolve(htmlResponse(calls === 1 ? "<html></html>" : page));
    });

    // Both pages return the same card → dedupe keeps one, and since the page
    // repeats cards, the loop stops even though the hx-get marker is present.
    const models = await scrapeLibraryWithFallback(fetchFn);
    expect(models.map((m) => m.name)).toEqual(["deepseek-v4-flash"]);
    expect(calls).toBe(3); // /library + page1 + page2
  });

  test("throws when both sources parse to zero models", async () => {
    const fetchFn = mock(() => Promise.resolve(htmlResponse("<html><body>x</body></html>")));
    await expect(scrapeLibraryWithFallback(fetchFn)).rejects.toThrow(/0 models/);
  });
});
