# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Ollama Manager is a lightweight web UI for managing an Ollama instance. It consists of a **Bun backend** (`src/`) and a **vanilla TypeScript frontend** (`public/src/`) that is bundled into `dist/public/` at build time. The backend serves the built frontend and proxies all `/api/*` requests to Ollama, eliminating CORS issues.

## Architecture

### Backend (`src/`)

- **`src/index.ts`** — entry point only: loads the config, builds the app, calls `Bun.serve()` and starts the timers — and only when run directly (`import.meta.main`). Importing it has no side effects.
- **`src/app.ts`** — `createApp(config, deps)`: the complete request handler as a **route table**. Each route declares `access: "public" | "session"`, so the auth gate is data, not statement order. Also static files, security headers and the legacy `/api/*` alias.
- **`src/config.ts`** — `loadConfig(env)`: all environment variables, validated; invalid values fail at startup naming the variable.
- **`src/backends.ts`** — backend registry (Ollama always, Ollaya when `OLLAYA_HOST` is set), host validation, the `/api/backends/{id}/…` path mapping + per-kind allowlist, request/response header hygiene, status probes (`createProbeAll()` with a 5 s TTL).
- **`src/relay.ts`** — `forwardToBackend()`: one relayed request, with connect and streaming idle timeouts.
- **`src/session.ts`** — `createSessions()`: request tokens, cookies, logout revocation (valid tokens only, capped) and the login rate limiter (capped).
- **`src/auth.ts`** — stateless HMAC-signed session tokens and cookie parsing. Tokens are signed with a secret derived from `MASTER_KEY`.
- **`src/catalogs.ts`** — ollama.com scrape (+ `/search` fallback, per-model details) and the ollaya.dev index, all through `src/cache.ts`.
- **`src/cache.ts`** — `createTtlCache()`: TTL, single-flight loads, stale fallback, entry cap.
- **`src/litellm.ts`** — `createLiteLLMSync()`: LiteLLM model sync, status and scheduler.
- **`src/openapi.ts`** — the OpenAPI document and the Swagger UI shell.
- **`src/http.ts`** — logging, JSON errors, size-limited body reads, the streaming idle-timeout wrapper, CSP/security headers.
- **`src/library.ts`** — HTML parsers for `ollama.com/library` and `ollama.com/search`, `parseLibraryDetailHtml()`, and the ollaya.dev index parser.

Key backend behaviors:

- **Static files**: at runtime the server reads the frontend from `dist/public/` (produced by `bun run build:web`). The authored `public/index.html` references TypeScript/CSS modules directly and cannot run in browsers without bundling.
- **Backend relay**: `/api/backends/{id}/{path}` is forwarded to `{baseUrl}/api/{path}` of that backend via `forwardToBackend()` (Ollaya additionally exposes `v1/systemone|decisions|models`). Ollaya only accepts its documented endpoints; unknown ids and disallowed paths return 404 without an upstream call. `GET /api/backends` lists backends with live status and capabilities.
- **Legacy proxy**: all other `/api/*` requests not handled explicitly are still forwarded to Ollama (deprecated alias for `/api/backends/ollama/*`).
- **Upstream headers**: `origin`, `referer`, `cookie` and `x-session-token` are stripped before every upstream request; for Ollaya the caller's `authorization` is replaced by `OLLAYA_API_KEY`.
- **Ollaya catalog** (`/api/catalog/ollaya`): reads ollaya.dev's static `/search.json` index, cached for 1 hour; a failed refresh serves the previous list marked `stale`.
- **Registry catalog** (`/api/catalog/library`): scrapes `ollama.com/library`, falls back to HTMX-paginated `/search` if the markup changes, and caches results in memory for 1 hour. Per-model details are cached for 6 hours.
- **Authentication**: optional master-key auth. If `MASTER_KEY` is set, API routes (not static files or public endpoints) require a valid session token provided either as an httpOnly `om_session` cookie or an `x-session-token` header. Public routes (`/api/session`, `/api/auth`, `/api/logout`, `/api/app-version`, `/api/openapi.json`, `/api/docs`, `/health`) are marked `access: "public"` in the route table of `src/app.ts`; everything else is gated. Wrong methods on known routes get `405` with `Allow`.
- **Login hardening**: `/api/auth` checks the rate limit before reading the body, reads at most 4 KB, and counts every failed attempt (wrong key, non-string key, bad JSON, oversized body). `/api/logout` only revokes tokens that verify.
- **`/health`**: public and always 200; versions and the backend list only with a session (or without `MASTER_KEY`).
- **Timeouts**: `Bun.serve` keeps `idleTimeout: 60`; routes marked `slow` (backend relay, legacy alias, LiteLLM sync) call `server.timeout(req, 0)` because a model cold start can take longer than that before the first byte.
- **Dot segments**: Bun resolves `.`/`..` in `req.url` before the handler runs, so `/api/backends/x/../../tags` is routed (and gated) as `/api/tags`.
- **LiteLLM sync**: optional background sync of local Ollama models to a LiteLLM proxy via `LITELLM_URL` + `LITELLM_KEY`.
- **TypeSafe gateway** (`/api/typesafe/v1/{systemone,decisions,models}`): the restricted entry point for LiteLLM's `/typesafe` pass-through. Enabled by `OLLAYA_TYPESAFE_KEY`, authenticated with that bearer key instead of a session (`access: "public"` + own check, failures rate limited), relays with Ollaya's key. Never add other Ollaya paths here: LiteLLM forwards every `/typesafe/*` path, so this allowlist is what keeps Ollaya's management API away from LiteLLM key holders.
- **`/api/litellm/ollaya-status`**: probes LiteLLM's `/typesafe/v1/models` against Ollaya's `/v1/models` and `/typesafe/api/tags` to detect a pass-through that points at Ollaya directly (`managementApiExposed`).
- **Security headers**: CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` are applied to every response. `/api/docs` gets a looser CSP for Swagger UI's external scripts.

### Frontend (`public/src/`)

A framework-less SPA built as ES modules:

- **`public/src/app.ts`** — entry point: imports page modules, registers page loaders, and boots auth + initial page.
- **`public/src/nav.ts`** — hash-based router (`/#chat`, `/#models`, etc.) and page activation.
- **`public/src/api.ts`** — session-aware fetch wrapper, `apiOk()` error-throwing variant, and `readNdjsonLines()` for streaming NDJSON responses.
- **`public/src/state/backends.ts`** — the backend list from `GET /api/backends` (id, kind, label, capabilities, live status).
- **`public/src/state/models.ts`** — shared in-memory cache of installed/running models across **all** backends. Every model carries `backend` and `key` (`"{backend}/{name}"`); a failing backend only records an entry in `backendErrors`.
- **`public/src/ui/backend.ts`** — backend badge, backend filter chips, "could not load" banner and backend `<select>` helper; all render nothing while only one backend exists.
- **`public/src/utils/backends.ts`** — pure helpers (`backendPath()`, model keys, `expires_at` formatting, error descriptions) + tests.
- **`public/src/ui/{toast,modal,confirm}.ts`** — small reusable UI primitives.
- **`public/src/pages/*.ts`** — one module per nav tab (`dashboard`, `models`, `chat` which also covers generate/embed, `decide`, `catalog`, `litellm`, `auth`).
- **`public/src/pages/decide.ts`** + **`public/src/utils/decide.ts`** — the Decide playground for decision models (Ollaya `/api/decide`): question editor ↔ JSON, built-in questions from `/api/show`, presets, probability bars, 422 issues mapped to their question, "save as model" via `/api/create`. All schema logic lives in the pure, tested `utils/decide.ts`.
- Nav items with `data-requires="<capability>"` are shown only when some backend has that capability (`applyCapabilityNav()` in `ui/backend.ts`).
- **`public/src/styles/*.css`** — `@layer`-based CSS modules, with `main.css` as the entry point imported from `public/index.html`.

Frontend patterns:

- State is in-memory only; page refresh resets it. The auth session is stored as an httpOnly cookie (and optionally returned as a token for API clients).
- Pages talk to backends only through `backendPath(backendId, "/tags")` → `/api/backends/{id}/tags`, never the legacy `/api/*` alias. Models are addressed by their key, so the same name on two backends stays distinct.
- Features are gated by backend **capabilities** (`chat`, `generate`, `embed`, `decide`, …), not by backend name; with only Ollama configured the UI looks as before.
- Event delegation is preferred: most click handlers live on parent containers and use `data-action` / `data-page` attributes.
- Chat/generate/pull streams use `readNdjsonLines()` and can be aborted with the same button that starts them.

## Commands

```bash
# Install dependencies
bun install

# Build the frontend (produces dist/public/)
bun run build:web

# Watch rebuild while editing frontend files
bun run dev:web

# Dev server with hot reload (builds frontend first)
bun run dev

# Production start (builds frontend first)
bun run start

# Type-check server + frontend (strict tsconfigs)
bun run typecheck

# Lint / format / fix (Biome; also lints public/index.html)
bun run lint
bun run lint:fix
bun run format

# Run tests (add --coverage to enforce the per-file thresholds from bunfig.toml)
bun test
```

`bun test` does not trigger the `predev`/`prestart` hooks, so `dist/public/` must already exist; run `bun run build:web` first if needed.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint to proxy |
| `OLLAYA_HOST` | *(unset)* | Ollaya endpoint; enables the `ollaya` backend (`http://` and port `11435` assumed) |
| `OLLAYA_API_KEY` | *(unset)* | Bearer key the manager sends to Ollaya (server-side only) |
| `OLLAYA_TYPESAFE_KEY` | *(unset)* | Enables the TypeSafe gateway for LiteLLM; its callers' bearer key |
| `MASTER_KEY` | *(unset)* | If set, enables login screen + API auth gate |
| `PORT` | `3000` | HTTP server port |
| `OLLAMA_MANAGER_VERSION` | `package.json` version → `"dev"` | App version exposed to frontend |
| `TRUST_PROXY` | *(unset)* | Set to `1`/`true`/`yes` to trust `X-Forwarded-For` and `X-Forwarded-Proto` from a reverse proxy |
| `LITELLM_URL` | *(unset)* | LiteLLM proxy base URL for model sync |
| `LITELLM_KEY` | *(unset)* | LiteLLM API key |
| `LITELLM_SYNC_INTERVAL` | `30` | Background LiteLLM sync interval in minutes |

## Docker & CI

- **Dockerfile**: uses `oven/bun:1-alpine`. Copies `package.json` + `bun.lock`, installs dependencies, copies `src/` and `public/`, runs `bun run build:web`, then starts `bun run src/index.ts`. `BUILD_VERSION` build-arg sets `OLLAMA_MANAGER_VERSION`.
- **CI** (`.github/workflows/ci.yml`): lint, typecheck, frontend build, tests with per-file coverage thresholds, a jscpd duplicate ratchet (2 %), a non-blocking `bun audit`, and a Docker build + `/health` smoke test. Actions are pinned to commit SHAs (Dependabot keeps them current); Bun is pinned to the version in `package.json` `packageManager` and the Dockerfile.
- **Release** (`.github/workflows/docker-image.yml`): on `v*` tags, runs the full CI via `workflow_call` first and refuses tags that don't match `package.json` `version`.
- **Docker compose** (`docker-compose.yml`): present for local builds; points `OLLAMA_HOST` to `host.docker.internal:11434`.

## Key Patterns to Preserve

- **Lint before commit**: always run `bun run lint` and `bun run typecheck` after making changes. Do not commit unlinted code. `noExplicitAny` is an error.
- **Frontend DOM tests** use happy-dom via `GlobalRegistrator.register()` in `beforeAll` and `unregister()` in `afterAll` of that test file only, so server tests keep Bun's own `fetch`/`Response`.
- **Frontend build required**: browsers cannot run the authored `public/src/**/*.ts` files directly. Any change to frontend code must be reflected in `dist/public/` via `bun run build:web` before runtime or Docker build.
- **Two tsconfigs**: `tsconfig.json` covers `src/`; `public/tsconfig.json` covers `public/src/`. Keep them separate so DOM globals and server globals do not collide.
- **In-memory caching only**: the backend has no database. Session revocation, catalog caches and LiteLLM sync state live in process memory — every map that unauthenticated input can grow has an upper bound, keep it that way.
- **No side effects on import**: only `src/index.ts` may start servers or timers, and only under `import.meta.main`. Tests build apps with `createApp(config, { fetchFn })`.
- **Auth gate as data**: a new API route must be added to the route table in `src/app.ts` with an explicit `access`. Only mark it `"public"` if it must work without a session.
- **Upstream header stripping**: `upstreamHeaders()` (used by `forwardToBackend()`) deletes `origin`, `referer`, `cookie`, `x-session-token`, hop-by-hop headers (incl. names listed in `Connection`) and the `x-forwarded-*` family. `downstreamHeaders()` drops `Set-Cookie`, hop-by-hop headers and any header echoing the backend's API key.
- **Backend allowlist**: new Ollaya endpoints must be added to the allowlist in `src/backends.ts` explicitly; never relay arbitrary paths to Ollaya.
- **No inline scripts/handlers**: the frontend CSP relies on external ES modules. Avoid inline `<script>` tags and inline `onclick`/`onchange` attributes in `public/index.html` or dynamically generated markup; wire events via `addEventListener` in page modules.

## File Layout

```
src/
  index.ts          # Entry point (Bun.serve under import.meta.main)
  app.ts            # createApp(): route table, auth gate, static files
  config.ts         # Environment → validated Config
  backends.ts       # Backend registry, path mapping, header hygiene, probes
  relay.ts          # forwardToBackend()
  session.ts        # Sessions, revocation, login rate limit
  auth.ts           # Stateless HMAC-signed session tokens + cookies
  catalogs.ts       # ollama.com + ollaya.dev catalogs
  cache.ts          # TTL cache with single-flight + stale fallback
  litellm.ts        # LiteLLM sync
  openapi.ts        # OpenAPI spec + Swagger shell
  http.ts           # Logging, errors, idle timeout, security headers
  library.ts        # ollama.com library/search/detail + ollaya.dev parsers
  *.test.ts         # Unit and in-process tests; server.test.ts runs the real process
public/
  index.html        # SPA shell (imports bundled TS/CSS sources)
  src/              # Frontend source modules
    app.ts          # Entry point
    nav.ts          # Hash router
    api.ts          # Fetch wrapper + NDJSON stream reader
    state/models.ts # Installed/running model cache
    ui/             # toast, modal, confirm
    pages/          # One module per nav tab
    styles/         # CSS modules with @layer
    utils/          # Pure format/escape helpers + tests
    render/         # Markdown renderer + tests
  tsconfig.json     # Frontend-only TypeScript config
tsconfig.json     # Server-only TypeScript config
package.json        # Scripts + dependencies (node-html-parser, biome, bun-types)
biome.json          # Linter/formatter config
dist/public/        # Build output (generated; not committed)
```
