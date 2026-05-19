# Ollama Manager
[![Docker Image CI](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml/badge.svg)](https://github.com/fs1n/Ollama-Manager/actions/workflows/docker-image.yml)

A lightweight, single-file web UI for managing a local [Ollama](https://ollama.com) instance. No build step, no framework, no dependencies — just a static HTML file served alongside a small CORS proxy.

<img width="1552" height="982" alt="image" src="https://github.com/user-attachments/assets/3eaa76c3-f75a-4fc1-95ab-4804b022a748" />

## Quick start

### Docker Compose

```yaml
services:
  ollama-manager:
    image: ghcr.io/fs1n/ollama-manager:latest
    ports:
      - "3000:3000"   # Web UI
      - "8080:8080"   # CORS proxy
    environment:
      - PORT=8080
```

Then open [http://localhost:3000](http://localhost:3000) and set the Ollama URL to your instance (defaults to: `http://localhost:11434`).

## CORS

To get the Model Catalogue working I needed an Ollama endpoint to fetch the available models. Ollama blocks cross-origin requests. As its not really possible to handle CORS client side i've added a simple cors proxy.

## Development

```bash
# Serve locally
node proxy.js
npx serve
```

## License

MIT
