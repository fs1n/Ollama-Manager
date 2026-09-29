import { describe, expect, test } from "bun:test";
import { createLiteLLMSync, probeTypesafe, typesafeModelNames } from "./litellm";

function fakeLiteLLM({
  ollamaModels,
  registered,
  info,
  failNew = [] as string[],
}: {
  ollamaModels: string[];
  registered: string[];
  info: { model_name: string; model_info: { id: string } }[];
  failNew?: string[];
}) {
  const calls: { url: string; body?: unknown; auth?: string | null }[] = [];
  const fetchFn = async (url: string, init: RequestInit = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body, auth: new Headers(init.headers).get("authorization") });
    if (url === "http://ollama/api/tags")
      return Response.json({ models: ollamaModels.map((name) => ({ name })) });
    if (url === "http://litellm/models")
      return Response.json({ data: registered.map((id) => ({ id })) });
    if (url === "http://litellm/model/info") return Response.json({ data: info });
    if (url === "http://litellm/model/new") {
      const name = (body as { model_name: string }).model_name;
      return failNew.includes(name) ? new Response("nope", { status: 500 }) : Response.json({});
    }
    if (url === "http://litellm/model/delete") return Response.json({});
    return new Response("", { status: 404 });
  };
  return { fetchFn, calls };
}

const base = { url: "http://litellm", key: "k", intervalMin: 30, ollamaHost: "http://ollama" };

describe("LiteLLM sync", () => {
  test("registers new models, skips known ones and removes only its own orphans", async () => {
    const { fetchFn, calls } = fakeLiteLLM({
      ollamaModels: ["llama3:latest", "qwen3:8b"],
      registered: ["ollama/llama3:latest"],
      info: [
        { model_name: "ollama/gone:latest", model_info: { id: "id-gone" } },
        { model_name: "gpt-4o", model_info: { id: "id-foreign" } },
        { model_name: "ollama/llama3:latest", model_info: { id: "id-llama" } },
      ],
    });
    const sync = createLiteLLMSync({ ...base, fetchFn });
    const result = await sync.sync();
    expect(result).toMatchObject({ success: 1, skipped: 1, failed: 0 });
    expect(calls.find((c) => c.url.endsWith("/model/new"))?.body).toEqual({
      model_name: "ollama/qwen3:8b",
      litellm_params: { model: "ollama/qwen3:8b", api_base: "http://ollama" },
    });
    const deletes = calls.filter((c) => c.url.endsWith("/model/delete")).map((c) => c.body);
    expect(deletes).toEqual([{ id: "id-gone" }]);
    expect(
      calls.filter((c) => c.url.startsWith("http://litellm")).every((c) => c.auth === "Bearer k"),
    ).toBe(true);
  });

  test("failures are reported per model, and Ollama being down fails the run", async () => {
    const { fetchFn } = fakeLiteLLM({
      ollamaModels: ["a:1"],
      registered: [],
      info: [],
      failNew: ["ollama/a:1"],
    });
    const sync = createLiteLLMSync({ ...base, fetchFn });
    expect(await sync.sync()).toMatchObject({ success: 0, failed: 1 });

    const down = createLiteLLMSync({
      ...base,
      fetchFn: async () => new Response("", { status: 502 }),
    });
    const r = await down.sync();
    expect(r.details[0]?.message).toContain("Ollama unreachable");
    expect(down.status().lastSync?.time).toBeGreaterThan(0);
  });

  test("is disabled without URL and key", () => {
    expect(createLiteLLMSync({ ...base, url: "" }).enabled).toBe(false);
  });
});

describe("probeTypesafe (Ollaya behind LiteLLM's /typesafe pass-through)", () => {
  const probe = (
    respond: (url: string) => Response | Promise<Response>,
    ollayaModels = ["laya:en"],
  ) =>
    probeTypesafe({
      litellmUrl: "http://litellm",
      litellmKey: "k",
      ollayaModels,
      fetchFn: async (url) => respond(url),
    });
  const models = (...names: string[]) => Response.json({ models: names.map((name) => ({ name })) });

  test("not configured without URL and key", async () => {
    const r = await probeTypesafe({ litellmUrl: "", litellmKey: "", ollayaModels: [] });
    expect(r.state).toBe("litellm-not-configured");
  });

  test("the states LiteLLM's answers map to", async () => {
    expect((await probe(() => new Response("", { status: 404 }))).state).toBe("no-passthrough");
    expect((await probe(() => new Response("", { status: 401 }))).state).toBe("unauthorized");
    expect((await probe(() => new Response("", { status: 500 }))).state).toBe("upstream-error");
    expect(
      (
        await probe(() => {
          throw new Error("ECONNREFUSED");
        })
      ).state,
    ).toBe("litellm-unreachable");
  });

  test("same models: connected; other models: a different TypeSafe service", async () => {
    const ok = await probe((url) =>
      url.endsWith("/v1/models") ? models("laya:en") : new Response("", { status: 401 }),
    );
    expect(ok).toMatchObject({ state: "connected", managementApiExposed: false });
    const cloud = await probe((url) =>
      url.endsWith("/v1/models") ? models("jev-latest") : new Response("", { status: 404 }),
    );
    expect(cloud).toMatchObject({ state: "other-service", litellmModels: ["jev-latest"] });
  });

  test("flags a pass-through that also reaches Ollaya's management API", async () => {
    const r = await probe((url) =>
      url.endsWith("/api/tags") ? models("laya:en") : models("laya:en"),
    );
    expect(r).toMatchObject({ state: "connected", managementApiExposed: true });
  });

  test("model names from either TypeSafe list shape", () => {
    expect(typesafeModelNames({ models: [{ name: "a" }, {}] })).toEqual(["a"]);
    expect(typesafeModelNames({ data: [{ id: "b" }] })).toEqual(["b"]);
    expect(typesafeModelNames(null)).toEqual([]);
  });
});
