// In-process tests of the complete request handler (src/app.ts): routing,
// the auth gate, the login rate limit, logout revocation and the relay's
// header hygiene. Upstreams are a fake fetch, so nothing binds a port.
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { createApp, type ServerLike } from "./app";
import { type Config, loadConfig } from "./config";

interface Upstream {
  url: string;
  method: string;
  headers: Headers;
}

function fakeFetch(
  respond: (url: string, init: RequestInit) => Response = () => Response.json({}),
) {
  const seen: Upstream[] = [];
  const fn = async (url: string, init: RequestInit = {}) => {
    seen.push({ url, method: init.method ?? "GET", headers: new Headers(init.headers) });
    if (url.endsWith("/api/version")) return Response.json({ version: "1.2.3" });
    return respond(url, init);
  };
  return { fn, seen };
}

function config(env: Record<string, string> = {}): Config {
  return {
    ...loadConfig({ OLLAMA_HOST: "http://ollama.test:11434", ...env }),
    publicDir: path.join(import.meta.dir, "..", "dist", "public"),
  };
}

function server(ip = "10.0.0.1") {
  const timeouts: number[] = [];
  const s: ServerLike = {
    requestIP: () => ({ address: ip }),
    timeout: (_req, seconds) => {
      timeouts.push(seconds);
    },
  };
  return { s, timeouts };
}

const req = (p: string, init: RequestInit = {}) => new Request(`http://manager.test${p}`, init);

async function login(app: ReturnType<typeof createApp>, key = "master"): Promise<string> {
  const r = await app.fetch(
    req("/api/auth", { method: "POST", body: JSON.stringify({ key }) }),
    server().s,
  );
  return ((await r.json()) as { token: string }).token;
}

describe("routing table", () => {
  const upstream = fakeFetch(() => Response.json({ models: [] }));
  const app = createApp(config({ MASTER_KEY: "master" }), { fetchFn: upstream.fn });

  test("public routes answer without a session", async () => {
    expect((await app.fetch(req("/api/session"))).status).toBe(200);
    expect((await app.fetch(req("/api/app-version"))).status).toBe(200);
    expect((await app.fetch(req("/api/openapi.json"))).status).toBe(200);
    expect((await app.fetch(req("/health"))).status).toBe(200);
  });

  test("every other API route needs a session", async () => {
    for (const p of [
      "/api/backends",
      "/api/backends/ollama/tags",
      "/api/catalog/library",
      "/api/catalog/ollaya",
      "/api/litellm/status",
      "/api/tags",
    ]) {
      expect({ p, status: (await app.fetch(req(p))).status }).toEqual({ p, status: 401 });
    }
  });

  test("wrong methods get 405 with Allow instead of reaching Ollama", async () => {
    const before = upstream.seen.length;
    const r = await app.fetch(req("/health", { method: "POST" }));
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD");
    expect((await app.fetch(req("/api/session", { method: "DELETE" }))).status).toBe(405);
    expect((await app.fetch(req("/api/app-version", { method: "POST" }))).status).toBe(405);
    expect(upstream.seen.length).toBe(before);
  });

  test("a protected route checks the session before revealing its methods", async () => {
    expect((await app.fetch(req("/api/catalog/library", { method: "POST" }))).status).toBe(401);
  });

  test("security headers on every answer, the docs page gets its own CSP", async () => {
    const r = await app.fetch(req("/api/session"));
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("content-security-policy")).toContain("script-src 'self'");
    const docs = await app.fetch(req("/api/docs"));
    expect(docs.headers.get("content-security-policy")).toContain("https://unpkg.com");
  });

  test("a malformed static path is a 400, not an unhandled 500", async () => {
    const r = await app.fetch(req("/%"));
    expect(r.status).toBe(400);
  });

  test("static traversal stays inside the public directory", async () => {
    const r = await app.fetch(req("/%2e%2e/package.json"));
    expect(await r.text()).not.toContain('"name": "ollama-manager"');
  });
});

describe("login (K2)", () => {
  test("non-string keys are refused and counted like any other failure", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }));
    const { s } = server("10.0.0.2");
    const statuses: number[] = [];
    for (const body of [
      '{"key":{}}',
      '{"key":123}',
      "not json",
      '{"key":null}',
      '{"key":["a"]}',
      '{"key":"x"}',
    ]) {
      const r = await app.fetch(req("/api/auth", { method: "POST", body }), s);
      statuses.push(r.status);
    }
    expect(statuses).toEqual([401, 401, 400, 401, 401, 429]);
  });

  test("oversized bodies are rejected before parsing and counted", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }));
    const { s } = server("10.0.0.3");
    const big = JSON.stringify({ key: "x".repeat(10_000) });
    const r = await app.fetch(req("/api/auth", { method: "POST", body: big }), s);
    expect(r.status).toBe(413);
    expect(app.sessions.stats().trackedIps).toBe(1);
  });

  test("the right key logs in and resets the counter", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }));
    const { s } = server("10.0.0.4");
    await app.fetch(req("/api/auth", { method: "POST", body: '{"key":"wrong"}' }), s);
    const r = await app.fetch(req("/api/auth", { method: "POST", body: '{"key":"master"}' }), s);
    expect(r.status).toBe(200);
    expect(r.headers.get("set-cookie")).toContain("HttpOnly");
    expect(app.sessions.stats().trackedIps).toBe(0);
  });
});

describe("logout revocation (K1)", () => {
  test("forged tokens are never stored", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }));
    for (let i = 0; i < 200; i++) {
      await app.fetch(
        req("/api/logout", {
          method: "POST",
          headers: { "x-session-token": `99999999999999.${i}.forged` },
        }),
      );
    }
    await app.fetch(
      req("/api/logout", { method: "POST", headers: { "x-session-token": "x".repeat(4000) } }),
    );
    expect(app.sessions.stats().revoked).toBe(0);
  });

  test("a real token is revoked and stops working", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }), { fetchFn: fakeFetch().fn });
    const token = await login(app);
    const headers = { "x-session-token": token };
    expect((await app.fetch(req("/api/backends", { headers }))).status).toBe(200);
    await app.fetch(req("/api/logout", { method: "POST", headers }));
    expect(app.sessions.stats().revoked).toBe(1);
    expect((await app.fetch(req("/api/backends", { headers }))).status).toBe(401);
  });
});

describe("/health (M3)", () => {
  test("anonymous callers only learn that the manager and Ollama are up", async () => {
    const app = createApp(config({ MASTER_KEY: "master" }), { fetchFn: fakeFetch().fn });
    expect(await (await app.fetch(req("/health"))).json()).toEqual({
      status: "ok",
      ollama: "connected",
    });
    const token = await login(app);
    const full = await (
      await app.fetch(req("/health", { headers: { "x-session-token": token } }))
    ).json();
    expect(full).toMatchObject({ ollamaVersion: "1.2.3", backends: [{ id: "ollama" }] });
  });

  test("probes are shared: a burst costs one probe per backend", async () => {
    const upstream = fakeFetch();
    const app = createApp(config({ OLLAYA_HOST: "ollaya.test" }), { fetchFn: upstream.fn });
    await Promise.all(Array.from({ length: 10 }, () => app.fetch(req("/health"))));
    await app.fetch(req("/api/backends"));
    expect(upstream.seen.filter((u) => u.url.endsWith("/api/version")).length).toBe(2);
  });
});

describe("relay header hygiene (M1, M2)", () => {
  test("hop-by-hop, forwarding and nominated headers never reach the backend", async () => {
    const upstream = fakeFetch(() => Response.json({ models: [] }));
    const app = createApp(config(), { fetchFn: upstream.fn });
    await app.fetch(
      req("/api/backends/ollama/tags", {
        headers: {
          "x-forwarded-for": "1.2.3.4",
          "x-forwarded-proto": "https",
          "proxy-authorization": "Basic cHJveHk=",
          te: "trailers",
          connection: "X-Sneak",
          "x-sneak": "boom",
          "x-custom": "kept",
        },
      }),
    );
    const sent = upstream.seen.at(-1)?.headers;
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-proto",
      "proxy-authorization",
      "te",
      "connection",
      "x-sneak",
    ]) {
      expect({ name, value: sent?.get(name) ?? null }).toEqual({ name, value: null });
    }
    expect(sent?.get("x-custom")).toBe("kept");
  });

  test("backend Set-Cookie and echoed API keys don't reach the browser", async () => {
    const upstream = fakeFetch(
      (_url, init) =>
        new Response("{}", {
          headers: {
            "set-cookie": "om_session=evil; Path=/",
            "x-echo": new Headers(init.headers).get("authorization") ?? "",
            "x-fine": "yes",
          },
        }),
    );
    const app = createApp(config({ OLLAYA_HOST: "ollaya.test", OLLAYA_API_KEY: "sekret" }), {
      fetchFn: upstream.fn,
    });
    const r = await app.fetch(req("/api/backends/ollaya/tags"));
    expect(upstream.seen.at(-1)?.headers.get("authorization")).toBe("Bearer sekret");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(r.headers.get("x-echo")).toBeNull();
    expect(r.headers.get("x-fine")).toBe("yes");
  });
});

describe("slow routes (H2)", () => {
  test("relay and LiteLLM sync lift Bun's idle timeout for their own request", async () => {
    const app = createApp(config(), { fetchFn: fakeFetch().fn });
    const { s, timeouts } = server();
    await app.fetch(req("/api/backends/ollama/tags"), s);
    await app.fetch(req("/api/tags"), s);
    await app.fetch(req("/api/session"), s);
    expect(timeouts).toEqual([0, 0]);
  });
});

describe("relay failures", () => {
  test("an unreachable backend is a 502 naming it", async () => {
    const app = createApp(config(), {
      fetchFn: async () => {
        throw new Error("ECONNREFUSED");
      },
    });
    const r = await app.fetch(req("/api/backends/ollama/tags"));
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: "Ollama unreachable" });
  });

  test("streaming endpoints keep streaming through the relay", async () => {
    const app = createApp(config(), {
      fetchFn: async () => new Response('{"status":"pulling manifest"}\n{"status":"success"}\n'),
    });
    const r = await app.fetch(req("/api/backends/ollama/pull", { method: "POST", body: "{}" }));
    expect(await r.text()).toBe('{"status":"pulling manifest"}\n{"status":"success"}\n');
    expect(r.headers.get("cache-control")).toBe("no-store");
  });
});

describe("configuration", () => {
  test("invalid values fail with the variable's name", () => {
    expect(() => loadConfig({ PORT: "abc" })).toThrow(/PORT/);
    expect(() => loadConfig({ LITELLM_SYNC_INTERVAL: "-5" })).toThrow(/LITELLM_SYNC_INTERVAL/);
    expect(() => loadConfig({ OLLAYA_HOST: "ftp://x" })).toThrow(/OLLAYA_HOST/);
  });

  test("LiteLLM is enabled only with URL and key", () => {
    expect(loadConfig({ LITELLM_URL: "http://l/" }).litellm.enabled).toBe(false);
    expect(loadConfig({ LITELLM_URL: "http://l/", LITELLM_KEY: "k" }).litellm).toMatchObject({
      enabled: true,
      url: "http://l",
    });
  });
});
