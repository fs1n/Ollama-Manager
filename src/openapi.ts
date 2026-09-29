// The OpenAPI document served at /api/openapi.json and the Swagger UI shell
// served at /api/docs. Kept apart from the server code: it is only data.

export function buildOpenApiSpec(version: string) {
  return {
    openapi: "3.0.3",
    info: {
      title: "Ollama Manager API",
      description:
        "Lightweight web UI for managing Ollama and Ollaya. Each configured backend is reachable under `/api/backends/{id}/…`. Deprecated: `/api/*` paths not listed below are still relayed to Ollama as an alias for `/api/backends/ollama/*`.",
      version,
    },
    components: {
      securitySchemes: {
        sessionToken: {
          type: "apiKey",
          in: "header",
          name: "x-session-token",
          description: "Session token returned by POST /api/auth (for programmatic API clients)",
        },
        typesafeKey: {
          type: "http",
          scheme: "bearer",
          description: "OLLAYA_TYPESAFE_KEY — only for /api/typesafe/v1/*",
        },
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "om_session",
          description:
            "httpOnly session cookie set automatically by POST /api/auth (used by the web UI)",
        },
      },
    },
    security: [{ sessionToken: [] }, { sessionCookie: [] }],
    paths: {
      "/api/session": {
        get: {
          summary: "Session status",
          tags: ["Auth"],
          security: [],
          responses: {
            200: {
              description: "Auth configuration and current session state",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      authRequired: { type: "boolean" },
                      authenticated: { type: "boolean" },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/auth": {
        post: {
          summary: "Authenticate",
          tags: ["Auth"],
          security: [],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: { key: { type: "string" } },
                  required: ["key"],
                },
              },
            },
          },
          responses: {
            200: {
              description:
                "Authentication token. Also sets the httpOnly `om_session` cookie for browser clients; API clients can send the returned token via the x-session-token header instead.",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      token: { type: "string" },
                      expires: { type: "number" },
                    },
                  },
                },
              },
            },
            401: { description: "Invalid master key" },
            429: { description: "Too many failed attempts" },
          },
        },
      },
      "/api/logout": {
        post: {
          summary: "Invalidate session token",
          tags: ["Auth"],
          security: [],
          responses: {
            200: {
              description: "Logged out",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { ok: { type: "boolean" } } },
                },
              },
            },
          },
        },
      },
      "/api/app-version": {
        get: {
          summary: "App version",
          tags: ["Meta"],
          security: [],
          responses: {
            200: {
              description: "Version string",
              content: {
                "application/json": {
                  schema: { type: "object", properties: { version: { type: "string" } } },
                },
              },
            },
          },
        },
      },
      "/api/backends": {
        get: {
          summary: "Configured backends",
          description:
            "Every model server the manager relays to, probed live (2s timeout each). Ollama is always listed; Ollaya when OLLAYA_HOST is set.",
          tags: ["Backends"],
          responses: {
            200: {
              description: "Backend list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      backends: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string", example: "ollaya" },
                            kind: { type: "string", enum: ["ollama", "ollaya"] },
                            label: { type: "string", example: "Ollaya" },
                            capabilities: {
                              type: "array",
                              items: {
                                type: "string",
                                enum: [
                                  "chat",
                                  "generate",
                                  "embed",
                                  "create-modelfile",
                                  "decide",
                                  "create-questions",
                                ],
                              },
                            },
                            status: { type: "string", enum: ["connected", "unreachable"] },
                            version: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/backends/{id}/{path}": {
        summary: "Relay to one backend",
        description:
          "Relays the request to `{baseUrl}/api/{path}` of backend `{id}` (e.g. `/api/backends/ollaya/decide` → Ollaya `/api/decide`). For Ollaya, `v1/systemone`, `v1/decisions` and `v1/models` map to its TypeSafe-compatible `/v1/*`. Ollaya only accepts its documented endpoints (version, tags, ps, show, pull, delete, copy, create, decide); other paths and unknown ids return 404. Request and response bodies are the backend's own.",
        parameters: [
          {
            name: "id",
            in: "path",
            required: true,
            schema: { type: "string", pattern: "^[a-z0-9-]+$", example: "ollama" },
          },
          {
            name: "path",
            in: "path",
            required: true,
            schema: { type: "string", example: "tags" },
          },
        ],
        get: {
          summary: "Relay GET",
          tags: ["Backends"],
          responses: {
            200: { description: "Backend response" },
            404: { description: "Unknown backend, or path not available on it" },
            502: { description: "Backend unreachable" },
          },
        },
        post: {
          summary: "Relay POST",
          tags: ["Backends"],
          responses: {
            200: { description: "Backend response (NDJSON stream for pull/create)" },
            404: { description: "Unknown backend, or path not available on it" },
            502: { description: "Backend unreachable" },
          },
        },
        delete: {
          summary: "Relay DELETE",
          tags: ["Backends"],
          responses: {
            200: { description: "Backend response" },
            404: { description: "Unknown backend, or path not available on it" },
            502: { description: "Backend unreachable" },
          },
        },
      },
      "/api/catalog/ollaya": {
        get: {
          summary: "ollaya.dev catalog",
          description:
            "Models listed on ollaya.dev, read from its static /search.json index and cached in memory for 1h.",
          tags: ["Catalog"],
          responses: {
            200: {
              description: "Model list, in ollaya.dev's editorial order",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      models: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string", example: "laya" },
                            description: { type: "string" },
                            capabilities: { type: "array", items: { type: "string" } },
                            rank: { type: "number", nullable: true },
                            updated: { type: "string", nullable: true, example: "2026-09-23" },
                            tags: {
                              type: "array",
                              items: {
                                type: "object",
                                properties: {
                                  name: { type: "string", example: "laya:en" },
                                  summary: { type: "string" },
                                },
                              },
                            },
                          },
                        },
                      },
                      cached: { type: "boolean" },
                      stale: {
                        type: "boolean",
                        description: "True if the refresh failed and an older list is served.",
                      },
                    },
                  },
                },
              },
            },
            502: { description: "ollaya.dev unreachable and nothing cached" },
          },
        },
      },
      "/api/catalog/library": {
        get: {
          summary: "Registry catalog",
          description: "Scraped list of models from ollama.com/library.",
          tags: ["Catalog"],
          responses: {
            200: {
              description: "Model list",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      models: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string" },
                            description: { type: "string" },
                            capabilities: { type: "array", items: { type: "string" } },
                            sizes: {
                              type: "array",
                              items: { type: "string" },
                              description: 'Parameter-size badges, e.g. "7b", "8x22b"',
                            },
                            variants: {
                              type: "array",
                              items: { type: "string" },
                              description:
                                'Non-param size-slot badges, e.g. Gemma\'s "e2b"/"e4b" — kept separate from sizes so size filters stay correct',
                            },
                            isCloud: { type: "boolean" },
                            pulls: { type: "string", example: "649.2K" },
                            tagCount: { type: "number" },
                            updatedText: { type: "string", example: "1 week ago" },
                            updatedAt: {
                              type: "string",
                              nullable: true,
                              format: "date-time",
                              description: 'Parsed from the updated span title="… UTC"',
                            },
                          },
                        },
                      },
                      cached: {
                        type: "boolean",
                        description: "True if this response was scraped within the last 5 seconds.",
                      },
                      stale: {
                        type: "boolean",
                        description:
                          "True if a fresh scrape failed and this is a cache older than the normal 1h TTL, kept as a last-resort fallback.",
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/catalog/library/{name}": {
        get: {
          summary: "Registry model detail",
          description:
            "On-demand scrape of ollama.com/library/<name>: the real tag list with per-tag download size, context window and input type. Cached in memory for 6h per model name.",
          tags: ["Catalog"],
          parameters: [
            {
              name: "name",
              in: "path",
              required: true,
              schema: { type: "string", pattern: "^[a-z0-9][a-z0-9._-]*$" },
            },
          ],
          responses: {
            200: {
              description: "Model detail",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      tags: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            name: { type: "string", example: "8b" },
                            size: { type: "string", example: "4.9GB" },
                            context: { type: "string", example: "128K" },
                            input: { type: "string", example: "Text" },
                          },
                        },
                      },
                      pulls: { type: "string", example: "118.7M" },
                      updatedText: { type: "string" },
                      updatedAt: { type: "string", nullable: true, format: "date-time" },
                      cached: { type: "boolean" },
                      stale: { type: "boolean" },
                    },
                  },
                },
              },
            },
            404: { description: "Model not found in registry" },
            502: { description: "Detail scrape failed" },
          },
        },
      },
      "/api/typesafe/v1/{endpoint}": {
        summary: "TypeSafe gateway to Ollaya",
        description:
          "Restricted, TypeSafe-compatible entry point for LiteLLM's /typesafe pass-through (set TYPESAFE_API_BASE to `<manager>/api/typesafe` and TYPESAFE_API_KEY to OLLAYA_TYPESAFE_KEY). Relays only `systemone`, `decisions` and `models` to Ollaya's /v1/*, with Ollaya's own key. Authenticated with `Authorization: Bearer <OLLAYA_TYPESAFE_KEY>` instead of a manager session; failed attempts are rate limited. 404 when OLLAYA_TYPESAFE_KEY or OLLAYA_HOST is unset.",
        parameters: [
          {
            name: "endpoint",
            in: "path",
            required: true,
            schema: { type: "string", enum: ["systemone", "decisions", "models"] },
          },
        ],
        get: {
          summary: "Model list (models)",
          tags: ["TypeSafe gateway"],
          security: [{ typesafeKey: [] }],
          responses: {
            200: { description: "Ollaya's TypeSafe model list" },
            401: { description: "Missing or wrong gateway key" },
            404: { description: "Gateway not configured" },
            429: { description: "Too many failed attempts" },
          },
        },
        post: {
          summary: "Decide (systemone, decisions)",
          tags: ["TypeSafe gateway"],
          security: [{ typesafeKey: [] }],
          responses: {
            200: { description: "TypeSafe SystemOne response" },
            401: { description: "Missing or wrong gateway key" },
            404: { description: "Gateway not configured" },
            422: { description: "Validation error (Ollaya's error body)" },
            429: { description: "Too many failed attempts" },
          },
        },
      },
      "/api/litellm/ollaya-status": {
        get: {
          summary: "Ollaya through LiteLLM",
          description:
            "Checks whether LiteLLM's /typesafe pass-through reaches this Ollaya (by comparing model lists), and whether it also exposes Ollaya's native management API (it then points at Ollaya directly instead of the gateway).",
          tags: ["LiteLLM"],
          responses: {
            200: {
              description: "Probe result",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      state: {
                        type: "string",
                        enum: [
                          "litellm-not-configured",
                          "litellm-unreachable",
                          "no-passthrough",
                          "unauthorized",
                          "upstream-error",
                          "other-service",
                          "connected",
                        ],
                      },
                      detail: { type: "string" },
                      litellmModels: { type: "array", items: { type: "string" } },
                      ollayaModels: { type: "array", items: { type: "string" } },
                      managementApiExposed: { type: "boolean" },
                      gatewayEnabled: { type: "boolean" },
                      gatewayPath: { type: "string", example: "/api/typesafe" },
                    },
                  },
                },
              },
            },
            404: { description: "No Ollaya backend configured" },
          },
        },
      },
      "/api/litellm/status": {
        get: {
          summary: "LiteLLM sync status",
          tags: ["LiteLLM"],
          responses: {
            200: {
              description: "Sync configuration and last run",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      enabled: { type: "boolean" },
                      url: { type: "string" },
                      interval: { type: "number" },
                      inProgress: { type: "boolean" },
                      lastSync: {
                        type: "object",
                        nullable: true,
                        properties: {
                          time: { type: "number" },
                          success: { type: "number" },
                          failed: { type: "number" },
                          skipped: { type: "number" },
                          details: {
                            type: "array",
                            items: {
                              type: "object",
                              properties: {
                                status: {
                                  type: "string",
                                  enum: ["success", "skipped", "failed", "info"],
                                },
                                message: { type: "string" },
                              },
                            },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      "/api/litellm/sync": {
        post: {
          summary: "Trigger LiteLLM sync",
          description: "Registers all Ollama models with the configured LiteLLM proxy.",
          tags: ["LiteLLM"],
          responses: {
            200: {
              description: "Full status after sync",
              content: { "application/json": { schema: { type: "object" } } },
            },
            400: { description: "LiteLLM sync not configured" },
          },
        },
      },
      "/health": {
        get: {
          summary: "Health check",
          description:
            "Always 200 while the manager runs. Anonymous callers get `status` and `ollama` only; `ollamaVersion` and `backends` are included with a valid session, or when MASTER_KEY is not set. Backend probes are cached for 5 s.",
          tags: ["Meta"],
          security: [],
          responses: {
            200: {
              description: "Service health",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: {
                      status: { type: "string", example: "ok" },
                      ollama: { type: "string", enum: ["connected", "unreachable"] },
                      ollamaVersion: { type: "string", nullable: true },
                      backends: {
                        type: "array",
                        items: {
                          type: "object",
                          properties: {
                            id: { type: "string" },
                            status: { type: "string", enum: ["connected", "unreachable"] },
                            version: { type: "string", nullable: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
}

export const SWAGGER_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Ollama Manager API Docs</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui.css" integrity="sha384-9Q2fpS+xeS4ffJy6CagnwoUl+4ldAYhOs9pgZuEKxypVModhmZFzeMlvVsAjf7uT" crossorigin="anonymous">
  <link rel="icon" type="image/svg+xml" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f0f0f'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%23c8f060' stroke-width='2.5'/%3E%3Crect x='14.5' y='10' width='3' height='12' fill='%23c8f060' transform='rotate(25 16 16)'/%3E%3C/svg%3E">
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5.32.6/swagger-ui-bundle.js" integrity="sha384-EYdOaiRwn44zNjrw+Tfs06qYz9BGQVo2f4/pLY5i7VorbjnZNhdplAbTBk8FXHUJ" crossorigin="anonymous"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/openapi.json',
      dom_id: '#swagger-ui',
      deepLinking: true,
      presets: [SwaggerUIBundle.presets.apis]
    });
  </script>
</body>
</html>`;
