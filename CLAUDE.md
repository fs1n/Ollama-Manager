# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Ollama Manager is a lightweight web UI for managing an Ollama instance. It consists of a **Bun backend** (`src/`) and a **vanilla TypeScript frontend** (`public/src/`) that is bundled into `dist/public/` at build time. The backend serves the built frontend and proxies all `/api/*` requests to Ollama, eliminating CORS issues.

## Architecture

### Backend (`src/`)

- **`src/index.ts`** — main `Bun.serve()` entry point. Handles routing, the Ollama proxy, registry scraping, LiteLLM sync, OpenAPI/Swagger, and security headers.
- **`src/auth.ts`** — stateless HMAC-signed session tokens, cookie parsing, and session helpers. Tokens are signed with a secret derived from `MASTER_KEY`; no in-memory session store is required, but revoked/logged-out tokens are remembered until expiry.
- **`src/library.ts`** — HTML parsers for `ollama.com/library` and `ollama.com/search`, plus `parseLibraryDetailHtml()` for per-model tag tables.

Key backend behaviors:

- **Static files**: at runtime the server reads the frontend from `dist/public/` (produced by `bun run build:web`). The authored `public/index.html` references TypeScript/CSS modules directly and cannot run in browsers without bundling.
- **API proxy**: all `/api/*` requests not handled explicitly are forwarded to `OLLAMA_HOST` via `forwardToOllama()`. Browser-originated `origin`, `referer`, and the manager's own `cookie` headers are stripped before the upstream request.
- **Registry catalog** (`/api/catalog/library`): scrapes `ollama.com/library`, falls back to HTMX-paginated `/search` if the markup changes, and caches results in memory for 1 hour. Per-model details are cached for 6 hours.
- **Authentication**: optional master-key auth. If `MASTER_KEY` is set, API routes (not static files or public endpoints) require a valid session token provided either as an httpOnly `om_session` cookie or an `x-session-token` header. Public endpoints (`/api/session`, `/api/auth`, `/api/logout`, `/api/app-version`, `/api/openapi.json`, `/api/docs`, `/health`) are checked *before* the auth gate.
- **LiteLLM sync**: optional background sync of local Ollama models to a LiteLLM proxy via `LITELLM_URL` + `LITELLM_KEY`.
- **Security headers**: CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy` are applied to every response. `/api/docs` gets a looser CSP for Swagger UI's external scripts.

### Frontend (`public/src/`)

A framework-less SPA built as ES modules:

- **`public/src/app.ts`** — entry point: imports page modules, registers page loaders, and boots auth + initial page.
- **`public/src/nav.ts`** — hash-based router (`/#chat`, `/#models`, etc.) and page activation.
- **`public/src/api.ts`** — session-aware fetch wrapper, `apiOk()` error-throwing variant, and `readNdjsonLines()` for streaming NDJSON responses.
- **`public/src/state/models.ts`** — shared in-memory cache of installed/running models used across pages.
- **`public/src/ui/{toast,modal,confirm}.ts`** — small reusable UI primitives.
- **`public/src/pages/*.ts`** — one module per nav tab (`dashboard`, `models`, `chat` which also covers generate/embed, `catalog`, `litellm`, `auth`).
- **`public/src/styles/*.css`** — `@layer`-based CSS modules, with `main.css` as the entry point imported from `public/index.html`.

Frontend patterns:

- State is in-memory only; page refresh resets it. The auth session is stored as an httpOnly cookie (and optionally returned as a token for API clients).
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

# Lint / format / fix (Biome)
bun run lint
bun run lint:fix
bun run format

# Run tests
bun test
```

`bun test` does not trigger the `predev`/`prestart` hooks, so `dist/public/` must already exist; run `bun run build:web` first if needed.

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `OLLAMA_HOST` | `http://localhost:11434` | Ollama API endpoint to proxy |
| `MASTER_KEY` | *(unset)* | If set, enables login screen + API auth gate |
| `PORT` | `3000` | HTTP server port |
| `OLLAMA_MANAGER_VERSION` | `package.json` version → `"dev"` | App version exposed to frontend |
| `TRUST_PROXY` | *(unset)* | Set to `1`/`true`/`yes` to trust `X-Forwarded-For` and `X-Forwarded-Proto` from a reverse proxy |
| `LITELLM_URL` | *(unset)* | LiteLLM proxy base URL for model sync |
| `LITELLM_KEY` | *(unset)* | LiteLLM API key |
| `LITELLM_SYNC_INTERVAL` | `30` | Background LiteLLM sync interval in minutes |

## Docker & CI

- **Dockerfile**: uses `oven/bun:1-alpine`. Copies `package.json` + `bun.lock`, installs dependencies, copies `src/` and `public/`, runs `bun run build:web`, then starts `bun run src/index.ts`. `BUILD_VERSION` build-arg sets `OLLAMA_MANAGER_VERSION`.
- **CI** (`.github/workflows/ci.yml`): runs lint, type-checks the server and frontend separately, builds the frontend, then runs tests.
- **Docker compose** (`docker-compose.yml`): present for local builds; points `OLLAMA_HOST` to `host.docker.internal:11434`.

## Key Patterns to Preserve

- **Lint before commit**: always run `bun run lint` after making changes. Do not commit unlinted code.
- **Frontend build required**: browsers cannot run the authored `public/src/**/*.ts` files directly. Any change to frontend code must be reflected in `dist/public/` via `bun run build:web` before runtime or Docker build.
- **Two tsconfigs**: `tsconfig.json` covers `src/`; `public/tsconfig.json` covers `public/src/`. Keep them separate so DOM globals and server globals do not collide.
- **In-memory caching only**: the backend has no database. Session revocation, catalog cache, catalog detail cache, and LiteLLM sync state live in process memory.
- **Auth gate ordering**: static files and public endpoints are checked *before* the `MASTER_KEY` auth gate. Do not accidentally move the auth check above public routes.
- **Ollama header stripping**: `forwardToOllama()` deletes `origin`, `referer`, and `cookie` from outgoing headers. This is required for CORS/origin validation and to avoid leaking the manager's session cookie upstream.
- **No inline scripts/handlers**: the frontend CSP relies on external ES modules. Avoid inline `<script>` tags and inline `onclick`/`onchange` attributes in `public/index.html` or dynamically generated markup; wire events via `addEventListener` in page modules.

## File Layout

```
src/
  index.ts          # Bun server — routing, proxy, scraper, sync, OpenAPI
  auth.ts           # Stateless HMAC-signed session tokens + cookies
  library.ts        # ollama.com library/search/detail parsers
  *.test.ts         # Backend unit tests
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
