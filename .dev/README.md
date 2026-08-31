# Dev Environment Setup

This folder contains local development companions that are **not** part of the production build.

## LiteLLM Dev Proxy

Start a local LiteLLM proxy with Postgres for testing the Manager's LiteLLM sync integration:

```bash
cd .dev
docker compose -f docker-compose.dev.yml up -d
```

The UI is available at http://localhost:4000/ui.

- Username: `admin`
- Password: the value of `LITELLM_MASTER_KEY` in `.env` (default: `sk-litellm-dev`)

Make sure your `.env` exists; copy from the project root if needed:

```bash
cp ../.env .env 2>/dev/null || echo "LITELLM_MASTER_KEY=sk-litellm-dev" > .env
```

To stop:

```bash
docker compose -f docker-compose.dev.yml down
```
