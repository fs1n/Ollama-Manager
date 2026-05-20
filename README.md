# Ollama Manager
[![Docker Image CI](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml/badge.svg)](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml)

A lightweight web UI for managing an [Ollama](https://ollama.com) instance. Bun backend + vanilla frontend — no framework, no build step.

<img width="1552" height="982" alt="image" src="https://github.com/user-attachments/assets/3eaa76c3-f75a-4fc1-95ab-4804b022a748" />

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
```

Then open [http://localhost:3000](http://localhost:3000).

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

## License

MIT
