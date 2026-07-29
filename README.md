# Ollama Manager
[![Docker Image CI](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml/badge.svg)](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml)

A lightweight web UI for managing an [Ollama](https://ollama.com) instance.

Features:
- Browse the Ollama registry catalog and pull models
- View installed and running models
- Chat, generate, and embeddings testing
- Optional master-key authentication
- LiteLLM Model Sync including built-in sync scheduling
- Interactive API documentation (Swagger UI) at `/api/docs`

<img width="1552" height="982" alt="image" src="https://github.com/user-attachments/assets/6f988347-27e0-4017-85ff-0afd83968291" />

More screenshots: [Screenshots.md](https://github.com/fs1n/Ollama-Manager/blob/main/screenshots.md)

> **⚠️ Set `MASTER_KEY` unless this is on a fully trusted, non-internet-facing network.**
> Without it, Ollama Manager is an **open, unauthenticated proxy to the entire Ollama
> API** — anyone who can reach the port can pull/delete/create models and run
> inference, with no login required. The manager logs a warning on startup if
> `MASTER_KEY` is unset.

## Quick start

### Docker Compose

```yaml
services:
  ollama-manager:
    image: ghcr.io/fs1n/ollama-manager:latest
    ports:
      - "3000:3000"
    environment:
      - OLLAMA_HOST=http://host.docker.internal:11434
      # Required unless this instance is on a fully trusted network — see warning above
      # - MASTER_KEY=your-secret-key-here
      # Optional: connect to LiteLLM instance for model syncing
      # - LITELLM_URL=http://litellm:4000
      # - LITELLM_KEY=your-secret-key-here
      # - LITELLM_SYNC_INTERVAL=30   # minutes, 0 = disable auto-sync
    extra_hosts:
      # Needed on native Linux Docker — host.docker.internal resolves out of
      # the box only on Docker Desktop (macOS/Windows).
      - "host.docker.internal:host-gateway"
```

Then open [http://localhost:3000](http://localhost:3000).

If `MASTER_KEY` is set, a login screen is shown where you have to enter the defined Master Key.

### How authentication works

- The web UI authenticates via an **httpOnly session cookie** (`om_session`,
  `SameSite=Strict`), so the token is never readable from JavaScript. The
  `Secure` flag is added automatically when the request arrives over HTTPS
  (directly, or via a reverse proxy with `TRUST_PROXY=1` set).
- Programmatic API clients can instead send the token returned by
  `POST /api/auth` in the `x-session-token` header.
- Session tokens are **HMAC-signed and stateless** (derived from
  `MASTER_KEY`), so logins survive container restarts. Rotating `MASTER_KEY`
  invalidates all sessions at once; logout revokes the individual token.

## Development

### Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Install dependencies:
```bash
bun install
```

### Start dev server with hot reload
```bash
bun run dev
```

Requires Ollama running at `OLLAMA_HOST` (defaults to `http://localhost:11434`).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OLLAMA_HOST` | No | Ollama API endpoint (default: `http://localhost:11434`) |
| `PORT` | No | HTTP server port (default: `3000`) (very optional, DONOT CHANGE WITHOUT AN ACTUAL NEED) |
| `MASTER_KEY` | No | If set, requires login before accessing the UI |
| `TRUST_PROXY` | No | Set to `1`/`true` **only** if a reverse proxy in front of this instance overwrites `X-Forwarded-For` — otherwise the login rate limiter uses the real socket address (default: unset) |
| `LITELLM_URL` | No | Point to LiteLLM base-URL |
| `LITELLM_KEY` | No | Your LiteLLM Masterkey |
| `LITELLM_SYNC_INTERVAL` | No | Sync interval in minutes |

## License

[MIT](https://github.com/fs1n/Ollama-Manager/blob/main/LICENSE)
