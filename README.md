# Ollama Manager

Web UI für Ollama mit CORS Proxy und Katalog-Support.

## Quick Start (Docker)

```bash
docker build -t ollama-manager .
docker run -p 3000:3000 -p 8080:8080 ollama-manager
```

Browser: http://localhost:3000

**Proxy**: http://localhost:8080/api/proxy?url=https://...

## Local Dev

Terminal 1:
```bash
node proxy.js
```

Terminal 2:
```bash
npx http-server . -p 3000
```

Browser: http://localhost:3000

## Features

- Local Ollama Management (pull/delete/run models)
- ollama.com Catalog (via CORS Proxy)
- Model Info, Chat, Generate, Embeddings
- Dark UI

## Configuration

Ollama URL: Input field in app (default: `http://localhost:11434`)
Proxy URL: Auto-detected (defaults to `http://localhost:8080`)
