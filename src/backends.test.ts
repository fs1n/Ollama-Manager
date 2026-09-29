import { describe, expect, test } from "bun:test";
import {
  type Backend,
  loadBackends,
  normalizeHost,
  parseBackendRoute,
  probeBackend,
  upstreamHeaders,
  upstreamPathFor,
} from "./backends";

const ollama: Backend = {
  id: "ollama",
  kind: "ollama",
  label: "Ollama",
  baseUrl: "http://localhost:11434",
};
const ollaya: Backend = {
  id: "ollaya",
  kind: "ollaya",
  label: "Ollaya",
  baseUrl: "http://127.0.0.1:11435",
  apiKey: "secret",
};

describe("parseBackendRoute", () => {
  test("splits id and the rest of the path", () => {
    expect(parseBackendRoute("/api/backends/ollaya/tags")).toEqual({ id: "ollaya", rest: "tags" });
    expect(parseBackendRoute("/api/backends/ollaya/v1/models")).toEqual({
      id: "ollaya",
      rest: "v1/models",
    });
  });

  test("ignores the registry route and anything else", () => {
    expect(parseBackendRoute("/api/backends")).toBeNull();
    expect(parseBackendRoute("/api/backends/")).toBeNull();
    expect(parseBackendRoute("/api/backends/ollama")).toBeNull();
    expect(parseBackendRoute("/api/tags")).toBeNull();
  });
});

describe("upstreamPathFor", () => {
  test("Ollama: any /api path, as the legacy proxy always allowed", () => {
    expect(upstreamPathFor("ollama", "tags")).toBe("/api/tags");
    expect(upstreamPathFor("ollama", "chat")).toBe("/api/chat");
    expect(upstreamPathFor("ollama", "blobs/sha256:abc123")).toBe("/api/blobs/sha256:abc123");
  });

  test("Ollama: its /v1 API is not relayed", () => {
    expect(upstreamPathFor("ollama", "v1/chat/completions")).toBeNull();
  });

  test("Ollaya: only the documented endpoints", () => {
    for (const p of [
      "version",
      "tags",
      "ps",
      "show",
      "pull",
      "delete",
      "copy",
      "create",
      "decide",
    ]) {
      expect(upstreamPathFor("ollaya", p)).toBe(`/api/${p}`);
    }
    expect(upstreamPathFor("ollaya", "chat")).toBeNull();
    expect(upstreamPathFor("ollaya", "push")).toBeNull();
    expect(upstreamPathFor("ollaya", "blobs/sha256:abc")).toBeNull();
    expect(upstreamPathFor("ollaya", "tags/extra")).toBeNull();
  });

  test("Ollaya: the TypeSafe-compatible /v1 endpoints", () => {
    expect(upstreamPathFor("ollaya", "v1/systemone")).toBe("/v1/systemone");
    expect(upstreamPathFor("ollaya", "v1/decisions")).toBe("/v1/decisions");
    expect(upstreamPathFor("ollaya", "v1/models")).toBe("/v1/models");
    expect(upstreamPathFor("ollaya", "v1/other")).toBeNull();
    expect(upstreamPathFor("ollaya", "v1")).toBeNull();
  });

  test("rejects traversal, encoding and empty segments", () => {
    for (const kind of ["ollama", "ollaya"] as const) {
      expect(upstreamPathFor(kind, "../tags")).toBeNull();
      expect(upstreamPathFor(kind, "..")).toBeNull();
      expect(upstreamPathFor(kind, "%2e%2e/tags")).toBeNull();
      expect(upstreamPathFor(kind, "tags/")).toBeNull();
      expect(upstreamPathFor(kind, "a//b")).toBeNull();
      expect(upstreamPathFor(kind, ".hidden")).toBeNull();
    }
  });
});

describe("normalizeHost", () => {
  test("adds scheme and default port like OLLAYA_HOST does", () => {
    expect(normalizeHost("127.0.0.1", 11435)).toBe("http://127.0.0.1:11435");
    expect(normalizeHost("ollaya:9000", 11435)).toBe("http://ollaya:9000");
    expect(normalizeHost("http://host.docker.internal", 11435)).toBe(
      "http://host.docker.internal:11435",
    );
    expect(normalizeHost("https://ollaya.example.com/", 11435)).toBe("https://ollaya.example.com");
    expect(normalizeHost(" http://h:1/prefix/ ", 11435)).toBe("http://h:1/prefix");
  });
});

describe("loadBackends", () => {
  test("Ollama only by default", () => {
    expect(loadBackends({})).toEqual([
      { id: "ollama", kind: "ollama", label: "Ollama", baseUrl: "http://localhost:11434" },
    ]);
  });

  test("adds Ollaya when OLLAYA_HOST is set", () => {
    const backends = loadBackends({
      OLLAMA_HOST: "http://gpu:11434/",
      OLLAYA_HOST: "gpu",
      OLLAYA_API_KEY: " k ",
    });
    expect(backends.map((b) => [b.id, b.baseUrl, b.apiKey])).toEqual([
      ["ollama", "http://gpu:11434", undefined],
      ["ollaya", "http://gpu:11435", "k"],
    ]);
  });

  test("no apiKey field without OLLAYA_API_KEY", () => {
    const [, o] = loadBackends({ OLLAYA_HOST: "gpu" });
    expect(o && "apiKey" in o).toBe(false);
  });
});

describe("upstreamHeaders", () => {
  const incoming = () =>
    new Headers({
      host: "manager.example.com",
      origin: "https://manager.example.com",
      referer: "https://manager.example.com/#models",
      cookie: "om_session=tok",
      "x-session-token": "tok",
      authorization: "Bearer from-browser",
      "content-type": "application/json",
    });

  test("strips browser and manager-session headers", () => {
    const h = upstreamHeaders(incoming(), ollama);
    expect(h.get("host")).toBe("localhost:11434");
    for (const name of ["origin", "referer", "cookie", "x-session-token"]) {
      expect(h.get(name)).toBeNull();
    }
    expect(h.get("content-type")).toBe("application/json");
    // Ollama keeps the caller's Authorization, as the proxy always did.
    expect(h.get("authorization")).toBe("Bearer from-browser");
  });

  test("Ollaya: the server-side key replaces the caller's Authorization", () => {
    expect(upstreamHeaders(incoming(), ollaya).get("authorization")).toBe("Bearer secret");
    const { apiKey: _, ...noKey } = ollaya;
    expect(upstreamHeaders(incoming(), noKey).get("authorization")).toBeNull();
  });
});

describe("probeBackend", () => {
  test("reports version and sends the API key", async () => {
    let seen: RequestInit | undefined;
    const status = await probeBackend(ollaya, async (url, init) => {
      expect(url).toBe("http://127.0.0.1:11435/api/version");
      seen = init;
      return Response.json({ version: "0.4.0" });
    });
    expect(status).toEqual({ status: "connected", version: "0.4.0" });
    expect(seen?.headers).toEqual({ Authorization: "Bearer secret" });
  });

  test("unreachable on HTTP errors and network failures", async () => {
    expect(await probeBackend(ollama, async () => new Response("", { status: 401 }))).toEqual({
      status: "unreachable",
      version: null,
    });
    expect(
      await probeBackend(ollama, async () => {
        throw new Error("ECONNREFUSED");
      }),
    ).toEqual({ status: "unreachable", version: null });
  });
});
