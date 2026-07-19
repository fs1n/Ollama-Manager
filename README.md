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
      # Optional: require master key to access the UI
      # - MASTER_KEY=your-secret-key-here
      # Optional: connect to LiteLLM instance for model syncing
      # - LITELLM_URL=http://litellm:4000
      # - LITELLM_KEY=your-secret-key-here
      # - LITELLM_SYNC_INTERVAL=30   # minutes, 0 = disable auto-sync
```

Then open [http://localhost:3000](http://localhost:3000).

If `MASTER_KEY` is set, a login screen is shown where you have to enter the defined Master Key.

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
| `LITELLM_URL` | No | Point to LiteLLM base-URL |
| `LITELLM_KEY` | No | Your LiteLLM Masterkey |
| `LITELLM_SYNC_INTERVAL` | No | Sync interval in minutes |

## License

[MIT](https://github.com/fs1n/Ollama-Manager/blob/main/LICENSE)
