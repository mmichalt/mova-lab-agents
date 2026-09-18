# mova-lab-agents

An independent AI-assisted content-generation service for Mova-Lab, a Ukrainian
speech-therapy application. It is also a practical study of agent orchestration
built with explicit TypeScript functions instead of an orchestration framework.

The service turns a teacher's structured request into Ukrainian recording
exercises, validates the result, and holds it for human approval before import.
Workflows are persisted in SQLite, dispatched through Redis/BullMQ, and use a
local Ollama model; generated content is never published automatically.

## Run locally

Requires Node.js 24.12 or later and Docker for Redis.

```sh
cp .env.example .env
npm ci
docker compose up -d redis
npm run dev
```

Replace the example tokens in `.env` and point the Mova-Lab and Ollama URLs at
your local services. Start the worker in another terminal when exercising the
asynchronous workflow:

```sh
npm run worker
```

The API listens on `http://127.0.0.1:3001` by default. Check it with:

```sh
curl -sS http://127.0.0.1:3001/health
curl -sS http://127.0.0.1:3001/ready
```

Tests and static checks do not require Redis, Ollama, a GPU, or Mova-Lab:

```sh
npm test
npm run typecheck
npm run lint
```

## Documentation

- [Technical reference](docs/technical-reference.md) — configuration, API and
  workflow behavior, Docker, operations, smoke tests, and evaluation
- [Architecture and learning plan](docs/architecture-plan.md)
- [Implementation backlog](docs/backlog.md)
