// End-to-end tests for the backend relay: the real server (src/index.ts) runs
// as a child process against two mock upstreams standing in for Ollama and
// Ollaya, so routing order, the auth gate and header handling are exercised
// exactly as deployed. Needs dist/public (bun run build:web), like index.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

function mockUpstream(name: string, handle: (req: Request, url: URL) => Response | undefined) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      seen.push({
        method: req.method,
        path: url.pathname + url.search,
        headers: req.headers,
        body: await req.text(),
      });
      return handle(req, url) ?? Response.json({ error: `${name}: not found` }, { status: 404 });
    },
  });
  return { server, seen, url: `http://127.0.0.1:${server.port}` };
}

function freePort(): number {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port as number;
  s.stop(true);
  return port;
}

async function startManager(env: Record<string, string>) {
  const port = freePort();
  const proc = Bun.spawn(["bun", "run", path.join(import.meta.dir, "index.ts")], {
    env: { ...process.env, ...env, PORT: String(port), LITELLM_URL: "", LITELLM_KEY: "" },
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/app-version`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      proc.kill();
      throw new Error("manager did not start");
    }
    await Bun.sleep(50);
  }
  return { base, stop: () => proc.kill() };
}

const ollama = mockUpstream("ollama", (req, url) => {
  if (url.pathname === "/api/version") return Response.json({ version: "0.9.0" });
  if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "llama3:latest" }] });
  if (url.pathname === "/api/pull" && req.method === "POST") {
    return new Response('{"status":"pulling manifest"}\n{"status":"success"}\n', {
      headers: { "Content-Type": "application/x-ndjson" },
    });
  }
});

const OLLAYA_KEY = "ollaya-secret";
const ollaya = mockUpstream("ollaya", (req, url) => {
  if (req.headers.get("authorization") !== `Bearer ${OLLAYA_KEY}`) {
    return Response.json({ error: "unauthorized", code: "UNAUTHORIZED" }, { status: 401 });
  }
  if (url.pathname === "/api/version") return Response.json({ version: "0.4.0" });
  if (url.pathname === "/api/tags") return Response.json({ models: [{ name: "laya:en" }] });
  if (url.pathname === "/api/decide") return Response.json({ model: "laya:en", answers: {} });
  if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "laya:en" }] });
});

afterAll(() => {
  ollama.server.stop(true);
  ollaya.server.stop(true);
});

const lastSeen = (u: { seen: Seen[] }) => u.seen[u.seen.length - 1];

describe("with MASTER_KEY and both backends", () => {
  let manager: Awaited<ReturnType<typeof startManager>>;
  let session = "";
  const authed = (init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { ...(init.headers as Record<string, string>), Cookie: `om_session=${session}` },
  });

  beforeAll(async () => {
    manager = await startManager({
      MASTER_KEY: "master",
      OLLAMA_HOST: ollama.url,
      OLLAYA_HOST: ollaya.url,
      OLLAYA_API_KEY: OLLAYA_KEY,
    });
    const r = await fetch(`${manager.base}/api/auth`, {
      method: "POST",
      body: JSON.stringify({ key: "master" }),
    });
    session = ((await r.json()) as { token: string }).token;
  });
  afterAll(() => manager.stop());

  test("auth gate covers the registry and every backend route", async () => {
    const before = ollama.seen.length + ollaya.seen.length;
    for (const p of ["/api/backends", "/api/backends/ollaya/tags", "/api/backends/ollama/tags"]) {
      expect((await fetch(`${manager.base}${p}`)).status).toBe(401);
    }
    expect(ollama.seen.length + ollaya.seen.length).toBe(before);
  });

  test("GET /api/backends lists both backends with live status", async () => {
    const r = await fetch(`${manager.base}/api/backends`, authed());
    expect(r.status).toBe(200);
    const { backends } = (await r.json()) as { backends: Record<string, unknown>[] };
    expect(backends).toEqual([
      {
        id: "ollama",
        kind: "ollama",
        label: "Ollama",
        capabilities: ["chat", "generate", "embed", "create-modelfile"],
        status: "connected",
        version: "0.9.0",
      },
      {
        id: "ollaya",
        kind: "ollaya",
        label: "Ollaya",
        capabilities: ["decide", "create-questions"],
        status: "connected",
        version: "0.4.0",
      },
    ]);
    // The key is used upstream but never shown to the client.
    expect(JSON.stringify(backends)).not.toContain(OLLAYA_KEY);
  });

  test("relays to Ollaya with the server-side key and without manager credentials", async () => {
    const r = await fetch(
      `${manager.base}/api/backends/ollaya/tags?x=1`,
      authed({
        headers: {
          Origin: "https://manager.example.com",
          "x-session-token": session,
          Authorization: "Bearer from-browser",
        },
      }),
    );
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ models: [{ name: "laya:en" }] });
    const req = lastSeen(ollaya);
    expect(req?.path).toBe("/api/tags?x=1");
    expect(req?.headers.get("authorization")).toBe(`Bearer ${OLLAYA_KEY}`);
    expect(req?.headers.get("cookie")).toBeNull();
    expect(req?.headers.get("x-session-token")).toBeNull();
    expect(req?.headers.get("origin")).toBeNull();
  });

  test("relays POST bodies and Ollaya's /v1 API", async () => {
    const body = JSON.stringify({ model: "laya", state: "hi", questions: {} });
    const r = await fetch(
      `${manager.base}/api/backends/ollaya/decide`,
      authed({ method: "POST", body }),
    );
    expect(r.status).toBe(200);
    expect(lastSeen(ollaya)).toMatchObject({ method: "POST", path: "/api/decide", body });

    const v1 = await fetch(`${manager.base}/api/backends/ollaya/v1/models`, authed());
    expect(await v1.json()).toEqual({ data: [{ id: "laya:en" }] });
    expect(lastSeen(ollaya)?.path).toBe("/v1/models");
  });

  test("relays to Ollama under the same scheme, streams included", async () => {
    const tags = await fetch(`${manager.base}/api/backends/ollama/tags`, authed());
    expect(await tags.json()).toEqual({ models: [{ name: "llama3:latest" }] });
    expect(lastSeen(ollama)?.path).toBe("/api/tags");

    const pull = await fetch(
      `${manager.base}/api/backends/ollama/pull`,
      authed({ method: "POST", body: '{"model":"llama3"}' }),
    );
    expect(await pull.text()).toBe('{"status":"pulling manifest"}\n{"status":"success"}\n');
  });

  test("legacy /api/* still reaches Ollama", async () => {
    const r = await fetch(`${manager.base}/api/tags`, authed());
    expect(await r.json()).toEqual({ models: [{ name: "llama3:latest" }] });
    expect(lastSeen(ollama)?.path).toBe("/api/tags");
    expect(lastSeen(ollama)?.headers.get("cookie")).toBeNull();
  });

  test("unknown backends and disallowed paths never reach upstream", async () => {
    const before = ollama.seen.length + ollaya.seen.length;
    const cases: [string, string][] = [
      ["/api/backends/nope/tags", "Unknown backend"],
      ["/api/backends/Ollaya/tags", "Unknown backend"],
      ["/api/backends/ollaya/chat", "Not available on Ollaya"],
      ["/api/backends/ollaya/v1/chat/completions", "Not available on Ollaya"],
      ["/api/backends/ollama/v1/chat/completions", "Not available on Ollama"],
      // URL parsing resolves %2e%2e to ".." before routing, leaving no backend id
      ["/api/backends/ollama/%2e%2e/version", "Not found"],
      ["/api/backends/ollama/.hidden", "Not available on Ollama"],
      ["/api/backends/", "Not found"],
    ];
    for (const [p, error] of cases) {
      const r = await fetch(`${manager.base}${p}`, authed());
      expect({ p, status: r.status, body: await r.json() }).toEqual({
        p,
        status: 404,
        body: { error },
      });
    }
    expect(ollama.seen.length + ollaya.seen.length).toBe(before);
  });

  test("the registry route is read-only and never falls through to Ollama", async () => {
    const before = ollama.seen.length;
    const r = await fetch(`${manager.base}/api/backends`, authed({ method: "POST" }));
    expect(r.status).toBe(405);
    expect(ollama.seen.length).toBe(before);
  });

  test("/health reports every backend and keeps the old fields", async () => {
    const r = await fetch(`${manager.base}/health`);
    expect(await r.json()).toEqual({
      status: "ok",
      ollama: "connected",
      ollamaVersion: "0.9.0",
      backends: [
        { id: "ollama", status: "connected", version: "0.9.0" },
        { id: "ollaya", status: "connected", version: "0.4.0" },
      ],
    });
  });
});

describe("without Ollaya, and with an unreachable one", () => {
  test("Ollaya routes do not exist when OLLAYA_HOST is unset", async () => {
    const manager = await startManager({
      MASTER_KEY: "",
      OLLAMA_HOST: ollama.url,
      OLLAYA_HOST: "",
    });
    try {
      const list = await fetch(`${manager.base}/api/backends`);
      const { backends } = (await list.json()) as { backends: { id: string }[] };
      expect(backends.map((b) => b.id)).toEqual(["ollama"]);
      const r = await fetch(`${manager.base}/api/backends/ollaya/tags`);
      expect(r.status).toBe(404);
    } finally {
      manager.stop();
    }
  });

  test("an unreachable Ollaya is reported, not fatal", async () => {
    const manager = await startManager({
      MASTER_KEY: "",
      OLLAMA_HOST: ollama.url,
      OLLAYA_HOST: `127.0.0.1:${freePort()}`,
    });
    try {
      const list = await fetch(`${manager.base}/api/backends`);
      const { backends } = (await list.json()) as { backends: { id: string; status: string }[] };
      expect(backends.map((b) => [b.id, b.status])).toEqual([
        ["ollama", "connected"],
        ["ollaya", "unreachable"],
      ]);
      const r = await fetch(`${manager.base}/api/backends/ollaya/tags`);
      expect(r.status).toBe(502);
      expect(await r.json()).toEqual({ error: "Ollaya unreachable" });
      const ok = await fetch(`${manager.base}/api/backends/ollama/tags`);
      expect(ok.status).toBe(200);
    } finally {
      manager.stop();
    }
  });
});
