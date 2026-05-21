# Ollama Manager
[![Docker Image CI](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml/badge.svg)](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml)

A lightweight web UI for managing an [Ollama](https://ollama.com) instance. Bun backend + vanilla frontend — no framework, no build step.

Features:
- Browse the Ollama registry catalog and pull models
- View installed and running models
- Chat, generate, and embeddings testing
- Optional master-key authentication

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
      - OLLAMA_HOST=http://ollama:11434
      # Optional: require master key to access the UI
      # - MASTER_KEY=your-secret-key-here
```

Then open [http://localhost:3000](http://localhost:3000).

If `MASTER_KEY` is set, a login screen is shown. The session token is stored in `sessionStorage` (tab-only, cleared on close).

## How it works

The Bun backend serves the frontend and proxies all `/api/*` requests to your Ollama instance. No CORS issues — browser only talks to the backend, backend talks to Ollama. The Ollama endpoint is configured via the `OLLAMA_HOST` environment variable.

## Development

```bash
# Install Bun: curl -fsSL https://bun.sh/install | bash

# Start dev server with hot reload
bun run dev

# Or start without watch mode
bun run start
```

Requires Ollama running at `OLLAMA_HOST` (defaults to `http://localhost:11434`).

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OLLAMA_HOST` | No | Ollama API endpoint (default: `http://localhost:11434`) |
| `MASTER_KEY` | No | If set, requires login before accessing the UI |
| `PORT` | No | Server port (default: `3000`)

## License

MIT
