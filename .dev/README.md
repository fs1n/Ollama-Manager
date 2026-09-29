# Dev Environment Setup

This folder spins up the full local development stack:

- **Ollama Manager** on http://localhost:3000
- **LiteLLM Proxy** on http://localhost:4000/ui
- **Postgres** for LiteLLM on port 5432
- **Ollaya** (decision models) on http://localhost:11435, reached by the manager directly and by
  LiteLLM through the manager's TypeSafe gateway

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
| `OLLAYA_API_KEY` | `ollaya-dev` | Key Ollaya requires; the manager sends it. |
| `OLLAYA_TYPESAFE_KEY` | `typesafe-dev` | Key of the manager's TypeSafe gateway; LiteLLM sends it as `TYPESAFE_API_KEY`. |

Ollama itself is expected to run on the host at `http://localhost:11434` (or wherever `host.docker.internal` resolves to).

The Ollama Manager dev container runs **without** `MASTER_KEY` for easy local testing. Do **not** expose this unauthenticated setup to a network.

## Access

- Ollama Manager: http://localhost:3000 — no login in dev mode
- LiteLLM UI: http://localhost:4000/ui — username `admin`, password = `LITELLM_MASTER_KEY`

## Decision models

Pull a model once (it is kept in the `ollaya_dev_models` volume), e.g. from the manager's
*Pull model* page with backend *Ollaya*, or:

```bash
curl -H "Authorization: Bearer ollaya-dev" http://localhost:11435/api/pull -d '{"model":"laya:en","stream":false}'
```

Then try it in the manager's *Decide* page, or through LiteLLM:

```bash
curl http://localhost:4000/typesafe/v1/systemone \
  -H "Authorization: Bearer sk-litellm-dev" -H "Content-Type: application/json" \
  -d '{"model":"laya:en","state":"I was charged twice.","questions":{"refund":{"type":"noul"}}}'
```

The manager's *LiteLLM* page shows whether LiteLLM reaches Ollaya and that it can't reach Ollaya's
management API.

## Stop

```bash
docker compose -f docker-compose.dev.yml down
```

To also remove the Postgres volume:

```bash
docker compose -f docker-compose.dev.yml down -v
```
