import { describe, expect, test } from "bun:test";
import { createLiteLLMSync } from "./litellm";

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
