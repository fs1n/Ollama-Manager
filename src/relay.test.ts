import { describe, expect, test } from "bun:test";
import type { Backend } from "./backends";
import { forwardToBackend } from "./relay";

const ollama: Backend = {
  id: "ollama",
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://o:11434",
};

// A fetch that never answers until its signal aborts, like a stuck backend.
const hanging = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () =>
      reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
    );
  });

describe("forwardToBackend", () => {
  test("a backend that never sends headers ends in 504", async () => {
    const r = await forwardToBackend(
      new Request("http://m/api/tags"),
      ollama,
      "/api/tags",
      hanging,
      {
        connectTimeoutMs: 20,
      },
    );
    expect(r.status).toBe(504);
  });

  test("a client that goes away aborts the upstream request (499)", async () => {
    const client = new AbortController();
    const pending = forwardToBackend(
      new Request("http://m/api/tags", { signal: client.signal }),
      ollama,
      "/api/tags",
      hanging,
    );
    client.abort();
    expect((await pending).status).toBe(499);
  });

  test("the query string is kept, the path is the validated upstream path", async () => {
    let target = "";
    await forwardToBackend(
      new Request("http://m/api/backends/ollama/tags?x=1"),
      ollama,
      "/api/tags",
      async (url) => {
        target = url;
        return Response.json({});
      },
    );
    expect(target).toBe("http://o:11434/api/tags?x=1");
  });
});
