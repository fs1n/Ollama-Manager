# Ollama Manager — Codebase Review

Reviewed at commit `4290ccf` (2026-07-20). Scope: full functionality and quality review of the
backend (`src/index.ts`), frontend (`public/index.html`), Docker/Compose setup, and CI workflow.

## Overall assessment

This is a well-built small project. The architecture is appropriate for its size: a single Bun
server with **zero runtime dependencies** that serves one static HTML file and transparently
proxies to Ollama, plus a handful of value-add endpoints (auth, registry catalog scraping,
LiteLLM sync, health, OpenAPI docs). `biome check` and `tsc --noEmit` both pass clean.

Notable strengths:

- Timing-safe master-key comparison, login rate limiting, session TTL with periodic cleanup,
  crypto-random 256-bit tokens.
- Robust library scraping: retry with exponential backoff, in-flight request deduplication,
  stale-cache fallback, multiple selector fallbacks for upstream HTML changes.
- Careful streaming UX: NDJSON reader, abort controllers with pull/chat/generate "Stop" buttons,
  rollback of chat history on failure.
- Real accessibility work: focus traps, focus return to trigger, skip link, `aria-label`s,
  `prefers-reduced-motion` support.
- Docker: non-root user, healthcheck, version injection via build arg.
- Structured JSON logging; `Cache-Control: no-store` on proxied/dynamic responses.

The findings below are ordered by severity. The two high-severity items are worth fixing soon;
the rest are hardening and polish.

---

## High severity

### H1. XSS in chat markdown rendering (`public/index.html` ~line 1899)

`renderMarkdown()` intends to escape the model output before converting markdown to HTML, but the
escape step is a no-op:

```js
const temp = document.createElement('div');
temp.textContent = el.textContent;
let text = temp.textContent;   // identical to el.textContent — nothing was escaped
...
el.innerHTML = text;           // raw model output injected as HTML
```

Writing to `textContent` and reading `textContent` back returns the same string (escaping would
only happen when reading `innerHTML`). Only fenced code blocks pass through `escHtml()`; all other
assistant text is injected into the DOM unescaped when the stream completes. A model response
containing e.g. `<img src=x onerror="fetch('/api/delete',…)">` executes in the authenticated
UI context — the session token in `sessionStorage` is readable, and every destructive proxied
endpoint (`/api/delete`, `/api/create`, …) is reachable. Since model output is influenced by
prompts, files, or a compromised/poisoned model, this is a genuine injection surface, not just
self-XSS.

**Fix:** escape first (`let text = escHtml(el.textContent);`), then run the markdown transforms
(the transforms themselves only insert trusted markup). Note the inline-code rule then needs no
change, but the link rule should also sanitize the URL scheme (`javascript:` URLs currently pass
through into `href`).

### H2. Connection status shows "connected" when Ollama is down (`public/index.html` ~line 1514)

`connect()` and `loadDashboard()` never check `r.ok`. When Ollama is unreachable, the proxy
returns **HTTP 502 with a JSON body** (`{"error":"Ollama unreachable"}`), so `r.json()` succeeds,
no exception is thrown, and:

- `connect()` runs `setStatus(true, 'unknown')` → the header shows a **green "connected" dot**
  and toasts "Connected to Ollama unknown".
- `loadDashboard()` renders `0 models / 0 running / —` as if that were real data.

The same happens for a 401 before login (the init sequence calls `connect()` even when
`checkSession()` has just shown the login overlay, producing a misleading status and toast behind
it).

**Fix:** `if (!r.ok) throw new Error(await httpErrorDetail(r))` in `connect()` and
`loadDashboard()`, and skip `connect()` in the init IIFE when unauthenticated (call it after
successful login instead — `doLogin()` already does).

---

## Medium severity

### M1. Login rate limiter trusts a spoofable header (`src/index.ts:712`)

The client IP is taken from `x-forwarded-for` **before** falling back to the socket address, for
every deployment. Any direct-connected attacker can send a different `X-Forwarded-For` value per
request and never hit the 5-attempts limit, reducing the brute-force protection to nothing unless
the app happens to sit behind a trusted proxy that overwrites the header. Related asymmetry: when
the IP resolves to `"unknown"`, failures are still recorded under that key but `isRateLimited` is
never consulted for it.

**Fix:** only honor `x-forwarded-for` when explicitly enabled (e.g. `TRUST_PROXY=1` env var);
default to `server.requestIP()`. Optionally also cap total attempts globally as a backstop.

### M2. 10-minute proxy timeout aborts large model pulls (`src/index.ts:95`)

`PROXY_TIMEOUT_MS = 600_000` applies to the *entire* response body, including streamed
`/api/pull` downloads. A 40 GB pull (70B-class model) needs a sustained ~530 Mbit/s to finish in
10 minutes — on typical connections the pull dies at the 10-minute mark with no clear reason
shown to the user. The same clock cuts off long chat/generate streams.

**Fix:** either exempt streaming endpoints (`/api/pull`, `/api/push`, `/api/chat`,
`/api/generate`, `/api/embed`) from the deadline and rely on `req.signal` (client disconnect)
alone, or replace the total-duration timeout with an idle/inactivity timeout between chunks.

### M3. Stale model `<select>`s: change detection by count only (`public/index.html:1764`)

`populateModelSelects()` short-circuits when `modelCache.length === lastModelCacheLen`. Delete one
model and pull another (count unchanged) and the Chat/Generate/Embeddings dropdowns keep showing
the old list — including a deleted model, which then 404s on use.

**Fix:** compare a joined key of names (`modelCache.map(m => m.name).join('\n')`) instead of the
length.

### M4. `host.docker.internal` does not resolve on Linux (`docker-compose.yml`)

The shipped compose file (and the README example) point at
`http://host.docker.internal:11434`, which only works out of the box on Docker Desktop
(macOS/Windows). On native Linux Docker the name doesn't resolve and the app starts permanently
"unreachable".

**Fix:** add to the compose service (and README):

```yaml
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### M5. Without `MASTER_KEY`, the app is an unauthenticated open proxy to Ollama

This is by design ("optional master-key auth"), but the consequence deserves an explicit README
warning: anyone with network access to port 3000 can delete models, pull arbitrary models to fill
the disk, create models, and run inference. The catch-all `forwardToOllama` also proxies *every*
`/api/*` path and method, so the exposure is the full Ollama API, not just what the UI uses.

**Fix:** a prominent "do not expose without MASTER_KEY" note; optionally log a startup warning
when `MASTER_KEY` is unset, and/or an allowlist of proxied Ollama paths.

### M6. LiteLLM sync is one-way and can report stale results

- Models deleted from Ollama are never de-registered from LiteLLM, so the proxy accumulates dead
  `ollama/...` entries that will error at request time.
- When a sync is already in progress, `syncOllamaToLiteLLM()` silently returns the *previous*
  `lastSync` (`src/index.ts:313-323`); a user clicking "Sync Now" during a scheduled run gets an
  old result presented as current, with no `inProgress` indication in the toast.

**Fix:** track models registered by this tool (the `ollama/` prefix is a usable marker) and offer
de-registration of ones no longer present; when a sync is in flight, return HTTP 409 or an
explicit "in progress" response instead of the stale result.

### M7. No CSP / security headers; runtime CDN dependencies

The UI loads fonts (Google Fonts), the icon font (jsDelivr), and Swagger UI (unpkg) from third
parties at runtime — an availability and supply-chain surface for what is an infrastructure admin
tool, often deployed in restricted networks where those CDNs are unreachable (icons and docs
silently break). No `Content-Security-Policy`, `X-Content-Type-Options`, or `X-Frame-Options`
headers are set; a CSP would also have mitigated H1.

**Fix:** vendor the assets into `public/` (they're small and versioned), then add a strict CSP.
At minimum add SRI (`integrity=`) attributes to the CDN tags.

---

## Low severity / polish

- **`toast(..., 'warning')` is unstyled** — `triggerLiteLLMSync()` uses type `warning`
  (`index.html:2059`) but the CSS defines only `success|error|info` and the icon map has no
  `warning` entry, so it renders as a border-less toast with the info icon.
- **`timingSafeCompare` can throw on multibyte input** (`src/index.ts:72`): the guard compares
  UTF-16 code-unit lengths, but `timingSafeEqual` needs equal *byte* lengths. A key like `"ää"`
  vs a 2-char ASCII master key passes the length check, differs in byte length, and throws —
  caught upstream as a 400 rather than a 401. Compare `aBuf.length !== bBuf.length` after
  `Buffer.from`.
- **`pullTag()` bypasses the router** (`index.html:2217`): it calls `activatePage('pull')`
  without setting `location.hash`, so URL and view diverge and the next hashchange misbehaves.
  Same for the inline "Pull your first model" empty-state button which duplicates the logic.
  Route everything through `nav()`/a shared helper.
- **`chatSystemSnapshot` is dead code** — written in two places, never read.
- **`firstInstalledMap` is actually "last installed"** (`index.html:2133`): `new Map()` keeps the
  final duplicate key, so the "Details" button on a catalog card opens the *last* matching tag.
  Misleading name at minimum; use a first-wins fill if first is intended.
- **Pull progress is per-layer, mislabeled** (`index.html:1707-1723`): `totalLayers` actually
  holds the current layer's byte total, and the percentage resets per layer. Rename, and consider
  aggregating `completed/total` across layers keyed by digest for a true overall percentage.
- **`connect()` toasts on every refresh** — clicking Dashboard → Refresh repeatedly spams
  "Connected to Ollama vX" toasts; reserve the toast for state transitions.
- **No Enter-to-submit** on the `#pull-model`, `#copy-*`, `#push-model` inputs (the login field
  has it; users will expect it on Pull especially).
- **`VERSION` fallback reads `./package.json` relative to CWD** (`src/index.ts:22`) while
  `STATIC_HTML` correctly uses `import.meta.dir`. Started from another directory, the version
  silently becomes `dev`. Use `path.join(import.meta.dir, "..", "package.json")`.
- **`cached`/`stale` flags are confusing** (`src/index.ts:284`): `cached: true` actually means
  "fetched within the last 5 s" (i.e. *not* served from cache), and the `stale` field is absent
  from the OpenAPI schema. Rename (`fresh`?) or document.
- **`Bun.serve` `error()` swallows the exception** (`src/index.ts:811`) — log it before returning
  the 500, otherwise genuine server bugs are invisible.
- **Redundant header dance** (`src/index.ts:102-103`): `headers.delete("host")` immediately
  followed by `headers.set("host", …)` — `set` alone suffices.
- **`escAttr` backslash-escaping is context-wrong for plain attributes** (`index.html:2306`): it
  was written for JS-string-inside-onclick (`pullTag('…')`) but is also used for `data-model="…"`
  attributes, where a model name containing `\` or `'` gets mangled (`\\`/`\'`) and no longer
  round-trips through `dataset.model`. Use `escHtml` for plain attributes and keep `escAttr` only
  for the one inline-handler case (or better, replace that last `onclick` with delegation like
  the rest of the file).
- **`recordAuthFailure` sliding-window quirk**: `resetAt` is set on the first failure only, so
  the 5-attempt budget resets exactly 60 s after the *first* failure regardless of subsequent
  attempts. Fine for a basic limiter, just noting the semantics.

---

## Process & tooling gaps

1. **No tests.** Nothing exercises the auth flow, the proxy behavior, the scraper parsing (which
   depends on fragile upstream HTML), or the LiteLLM sync logic. `bun test` is available at zero
   dependency cost; the scraper is especially testable against saved HTML fixtures, and the sync
   against a stubbed `fetch`.
2. **No CI for code quality.** The only workflow builds a Docker image on version tags. A small
   PR/push workflow running `bun install`, `bun run lint`, and `bunx tsc --noEmit` (both
   currently pass) would catch regressions — right now nothing enforces the clean state.
3. **Single-architecture image.** The build-push action has no `platforms:`; the published image
   is amd64-only, while Ollama self-hosters frequently run arm64 (Apple Silicon, Raspberry Pi,
   Ampere). Add QEMU + buildx with `linux/amd64,linux/arm64`.
4. **Frontend is a single 2 400-line HTML file.** Defensible at this size (zero build step is a
   feature), but it's near the threshold where splitting CSS and JS into separate static files —
   still build-free — would improve navigability and enable proper caching headers.
5. **`.dockerignore` lists `bun.lockb`** but the repo's lockfile is the newer text format
   `bun.lock` — harmless today (the image never runs `bun install`), but stale.

---

## Suggested priorities

| Priority | Items |
|---|---|
| Now | H1 (XSS), H2 (false "connected" status) |
| Next release | M1 (rate-limit bypass), M2 (pull timeout), M3 (stale selects), M4 (compose on Linux) |
| Hardening pass | M5–M7, CSP, vendored assets, CI quality gate, basic tests |
| Opportunistic | Low-severity polish list |
