import { describe, expect, test } from "bun:test";
import {
  type BackendInfo,
  backendPath,
  describeApiError,
  formatExpires,
  matchesBackend,
  modelKey,
  parseModelKey,
  statusSummary,
} from "./backends";

describe("backendPath", () => {
  test("builds the per-backend relay path", () => {
    expect(backendPath("ollaya", "/tags")).toBe("/api/backends/ollaya/tags");
    expect(backendPath("ollama", "show")).toBe("/api/backends/ollama/show");
    expect(backendPath("ollaya", "/v1/models")).toBe("/api/backends/ollaya/v1/models");
  });
});

describe("modelKey / parseModelKey", () => {
  test("round-trips names, including namespaced ones", () => {
    for (const name of ["llama3:latest", "acme/triage:latest", "laya:en"]) {
      expect(parseModelKey(modelKey("ollaya", name))).toEqual({ backend: "ollaya", name });
    }
  });

  test("rejects keys without a backend or name", () => {
    expect(parseModelKey("llama3")).toBeNull();
    expect(parseModelKey("/llama3")).toBeNull();
    expect(parseModelKey("ollama/")).toBeNull();
  });
});

describe("formatExpires", () => {
  const now = Date.parse("2026-09-29T12:00:00Z");

  test("null means kept loaded forever (Ollaya)", () => {
    expect(formatExpires(null, now)).toBe("forever");
  });

  test("far-future dates mean forever too (Ollama)", () => {
    expect(formatExpires("2318-01-01T00:00:00Z", now)).toBe("forever");
  });

  test("missing or broken values show a dash", () => {
    expect(formatExpires(undefined, now)).toBe("—");
    expect(formatExpires("", now)).toBe("—");
    expect(formatExpires("nope", now)).toBe("—");
  });

  test("near dates show a time", () => {
    const iso = "2026-09-29T12:05:00Z";
    expect(formatExpires(iso, now)).toBe(new Date(iso).toLocaleTimeString());
  });
});

describe("describeApiError", () => {
  test("Ollama-style body", () => {
    expect(describeApiError(404, { error: "model not found" })).toBe("HTTP 404 — model not found");
  });

  test("Ollaya adds its code", () => {
    expect(
      describeApiError(404, {
        error: 'model "laya:xl" not found, try pulling it first',
        code: "MODEL_NOT_FOUND",
      }),
    ).toBe('HTTP 404 — model "laya:xl" not found, try pulling it first (MODEL_NOT_FOUND)');
  });

  test("lists further validation issues with their location", () => {
    expect(
      describeApiError(422, {
        error: "questions.q.choice.criteria: at least 2 options",
        code: "INVALID_REQUEST",
        detail: [
          { loc: ["body", "questions", "q", "choice", "criteria"], msg: "at least 2 options" },
          { loc: ["body", "state"], msg: "field required" },
        ],
      }),
    ).toBe(
      "HTTP 422 — questions.q.choice.criteria: at least 2 options (INVALID_REQUEST) · state: field required",
    );
  });

  test("non-JSON or empty bodies", () => {
    expect(describeApiError(502, null)).toBe("HTTP 502");
    expect(describeApiError(500, "oops")).toBe("HTTP 500");
  });
});

describe("matchesBackend", () => {
  test("all matches everything, otherwise the id", () => {
    expect(matchesBackend("all", "ollaya")).toBe(true);
    expect(matchesBackend("ollama", "ollama")).toBe(true);
    expect(matchesBackend("ollama", "ollaya")).toBe(false);
  });
});

describe("statusSummary", () => {
  const b = (id: string, label: string, up: boolean, version: string | null): BackendInfo => ({
    id,
    kind: id === "ollaya" ? "ollaya" : "ollama",
    label,
    capabilities: [],
    status: up ? "connected" : "unreachable",
    version,
  });

  test("a single backend keeps the old badge text", () => {
    expect(statusSummary([b("ollama", "Ollama", true, "0.9.0")])).toEqual({
      state: "connected",
      text: "v0.9.0",
    });
    expect(statusSummary([b("ollama", "Ollama", false, null)])).toEqual({
      state: "error",
      text: "unreachable",
    });
  });

  test("several backends are named, partial outage is its own state", () => {
    expect(
      statusSummary([b("ollama", "Ollama", true, "0.9.0"), b("ollaya", "Ollaya", false, null)]),
    ).toEqual({ state: "partial", text: "Ollama v0.9.0 · Ollaya unreachable" });
  });

  test("no backends at all", () => {
    expect(statusSummary([])).toEqual({ state: "error", text: "unreachable" });
  });
});
