# Dev Environment Setup

This folder spins up the full local development stack:

- **Ollama Manager** on http://localhost:3000
- **LiteLLM Proxy** on http://localhost:4000/ui
- **Postgres** for LiteLLM on port 5432

## Start

```bash
cd .dev
docker compose -f docker-compose.dev.yml up -d --build
```

The first build of `ollama-manager` may take a moment.

## Environment

Create a `.env` (or let the compose use the defaults):

```bash
cat > .env <<EOF
LITELLM_MASTER_KEY=sk-litellm-dev
EOF
```

| Variable | Default | Purpose |
|----------|---------|---------|
| `LITELLM_MASTER_KEY` | `sk-litellm-dev` | LiteLLM admin UI + API key. Also used by Ollama Manager to sync. |

Ollama itself is expected to run on the host at `http://localhost:11434` (or wherever `host.docker.internal` resolves to).

The Ollama Manager dev container runs **without** `MASTER_KEY` for easy local testing. Do **not** expose this unauthenticated setup to a network.

## Access

- Ollama Manager: http://localhost:3000 — no login in dev mode
- LiteLLM UI: http://localhost:4000/ui — username `admin`, password = `LITELLM_MASTER_KEY`

## Stop

```bash
docker compose -f docker-compose.dev.yml down
```

To also remove the Postgres volume:

```bash
docker compose -f docker-compose.dev.yml down -v
```
