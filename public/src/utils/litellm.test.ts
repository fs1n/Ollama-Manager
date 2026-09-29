import { describe, expect, test } from "bun:test";
import {
  litellmCurlExample,
  litellmEnvSnippet,
  type TypesafeStatus,
  typesafeStateView,
} from "./litellm";

const status = (over: Partial<TypesafeStatus>): TypesafeStatus => ({
  state: "connected",
  detail: "",
  litellmModels: [],
  ollayaModels: [],
  managementApiExposed: false,
  gatewayEnabled: true,
  gatewayPath: "/api/typesafe",
  ...over,
});

describe("typesafeStateView", () => {
  test("connected is only ok while the management API stays closed", () => {
    expect(typesafeStateView(status({}))).toEqual({ label: "connected", tone: "ok" });
    expect(typesafeStateView(status({ managementApiExposed: true }))).toEqual({
      label: "connected, but unrestricted",
      tone: "err",
    });
  });

  test("every other state has a label and a tone", () => {
    for (const state of [
      "litellm-not-configured",
      "litellm-unreachable",
      "no-passthrough",
      "unauthorized",
      "upstream-error",
      "other-service",
    ] as const) {
      const v = typesafeStateView(status({ state }));
      expect(v.label.length).toBeGreaterThan(0);
      expect(["warn", "err"]).toContain(v.tone);
    }
  });
});

describe("snippets", () => {
  test("the env snippet points LiteLLM at the gateway", () => {
    expect(litellmEnvSnippet("http://ollama-manager:3000/", "/api/typesafe")).toContain(
      "TYPESAFE_API_BASE=http://ollama-manager:3000/api/typesafe",
    );
  });

  test("the curl example targets LiteLLM's /typesafe route", () => {
    const ex = litellmCurlExample("http://litellm:4000/", "laya:en");
    expect(ex).toStartWith("curl http://litellm:4000/typesafe/v1/systemone");
    expect(ex).toContain('"model":"laya:en"');
    expect(litellmCurlExample("", "x")).toContain("http://<litellm>:4000");
  });
});
