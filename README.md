# Ollama Manager
[![Docker Image CI](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml/badge.svg)](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml)

Web UI for managing [Ollama](https://ollama.com) models, with automatic [LiteLLM](https://www.litellm.ai/) model sync

Features:
- Browse the Ollama registry catalog and pull models
- View installed and running models
- Chat, generate, and embeddings testing
- Simple Master-Key authentication
- Model Sync to LiteLLM
- API to interact with the manager programmatically with (Swagger UI) at `/api/docs`

<img width="1552" height="982" alt="image" src="https://github.com/user-attachments/assets/6f988347-27e0-4017-85ff-0afd83968291" />

More screenshots: [Screenshots.md](https://github.com/fs1n/Ollama-Manager/blob/main/screenshots.md)

> [!WARNING]
> **Set `MASTER_KEY` unless this is on a fully trusted, non-internet-facing network.**
> Without it, Ollama Manager is an **open, unauthenticated proxy to the entire Ollama
> API** - anyone who can reach the port can pull/delete/create models and run
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
      # Required unless this instance is on a fully trusted network - see warning above
      - MASTER_KEY=your-secret-key-here
      # Optional: connect to LiteLLM instance for model syncing
      # - LITELLM_URL=http://litellm:4000
      # - LITELLM_KEY=your-secret-key-here
      # - LITELLM_SYNC_INTERVAL=30   # minutes, 0 = disable auto-sync
    extra_hosts:
      # Needed on native Linux Docker - host.docker.internal resolves out of
      # the box only on Docker Desktop (macOS/Windows).
      - "host.docker.internal:host-gateway"
```

Then open [http://localhost:3000](http://localhost:3000).

## Development

### Install Bun:
```bash
curl -fsSL https://bun.sh/install | bash
```

### Install dependencies:
```bash
bun install
```

### Start dev server
```bash
bun run dev
```

Requires Ollama running at `OLLAMA_HOST` (defaults to `http://localhost:11434`).

The frontend (`public/index.html` + `public/src/**`) is bundled by Bun into
`dist/public/` — `bun run dev`/`bun run start` build it automatically first.
If you edit frontend files while `bun run dev` is already running, rebuild in
another terminal with `bun run dev:web` (watches and rebuilds on change) or a
one-off `bun run build:web`. `bun test` doesn't go through `bun run`, so run
`bun run build:web` once beforehand if `dist/public` doesn't exist yet.

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OLLAMA_HOST` | No | Ollama API endpoint (default: `http://localhost:11434`) |
| `PORT` | No | HTTP server port (default: `3000`) (very optional, DONOT CHANGE WITHOUT AN ACTUAL NEED) |
| `MASTER_KEY` | No | No, but consider Setting it for security |
| `TRUST_PROXY` | No | Set to `1`/`true` **only** if a reverse proxy in front of this instance overwrites `X-Forwarded-For` - otherwise the login rate limiter uses the real socket address (default: unset) |
| `LITELLM_URL` | No | Point to LiteLLM base-URL |
| `LITELLM_KEY` | No | Your LiteLLM Masterkey |
| `LITELLM_SYNC_INTERVAL` | No | Sync interval in minutes |

## Disclaimer

This is an independent project. It is not affiliated with,
endorsed by, or sponsored by Ollama or Ollama Inc. "Ollama" is used here only
to describe what this tool works with. All trademarks belong to their
respective owners.

## License

[MIT](https://github.com/fs1n/Ollama-Manager/blob/main/LICENSE)
