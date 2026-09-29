import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createCatalogs, scrapeLibraryWithFallback } from "./catalogs";

const fixture = (name: string) =>
  readFileSync(path.join(import.meta.dir, "..", "test", "fixtures", name), "utf-8");

const htmlResponse = (body: string) =>
  new Response(body, { status: 200, headers: { "Content-Type": "text/html" } });

// Several tests below deliberately make /library parse to 0 models to
// exercise the /search fallback path — that's expected to log a "/library
// parsed 0 models, falling back to /search pagination" warning each time
// (see scrapeLibraryWithFallback in ./catalogs.ts), not a sign anything failed.
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

describe("catalog routes (M4: bounded detail cache)", () => {
  const detailHtml = fixture("library-llama3.1-detail.html");

  test("invalid or overlong names are refused before anything is fetched", async () => {
    let calls = 0;
    const catalogs = createCatalogs({
      fetchFn: async () => {
        calls++;
        return htmlResponse(detailHtml);
      },
    });
    for (const name of ["a".repeat(101), "UPPER", "-dash", "a/b"]) {
      expect((await catalogs.serveLibraryDetail(name)).status).toBe(400);
    }
    expect(calls).toBe(0);
  });

  test("the detail cache keeps at most 500 names", async () => {
    const catalogs = createCatalogs({ fetchFn: async () => htmlResponse(detailHtml) });
    for (let i = 0; i < 520; i++) await catalogs.serveLibraryDetail(`m${i}`);
    expect(catalogs.detailCacheSize()).toBe(500);
  });

  test("a registry 404 stays a 404, other failures a 502", async () => {
    const notFound = createCatalogs({ fetchFn: async () => new Response("", { status: 404 }) });
    expect((await notFound.serveLibraryDetail("nope")).status).toBe(404);
    const broken = createCatalogs({ fetchFn: async () => new Response("", { status: 500 }) });
    expect((await broken.serveLibraryDetail("nope")).status).toBe(502);
  });

  test("the library index is served with cache flags and retried on failure", async () => {
    let calls = 0;
    const catalogs = createCatalogs({
      retryDelayMs: 1,
      fetchFn: async () => {
        calls++;
        return calls === 1
          ? new Response("", { status: 503 })
          : htmlResponse(fixture("library-llama3.1.html"));
      },
    });
    const body = (await (await catalogs.serveLibrary()).json()) as {
      models: unknown[];
      cached: boolean;
      stale: boolean;
    };
    expect(body.models.length).toBe(1);
    expect(body).toMatchObject({ cached: true, stale: false });
    expect(calls).toBe(2);
  });
});
