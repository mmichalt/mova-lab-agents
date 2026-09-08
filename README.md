# mova-lab-agents

An independent AI-assisted content-generation service for Mova-Lab, a Ukrainian
speech-therapy application. The project also serves as a practical introduction
to agent orchestration using explicit Node.js, TypeScript, and Express functions.

Requires Node.js 24.12 or later. Development and tests run TypeScript sources
directly; production runs the compiled JavaScript in `dist/`. Constructing the
Express app (`createApp`) does not open a network port; only `src/server.ts`
listens. Invalid configuration exits before the process binds a port.

## Configuration

Copy `.env.example` to `.env` for local use. `npm run dev` and `npm start` load
it through Node's `--env-file-if-exists=.env`. Do not commit `.env`.

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Empty values use the default. `0` binds an ephemeral port. |
| `LOG_LEVEL` | `info` | Pino level: `fatal` … `silent`. |
| `SERVICE_TOKEN` | (required) | Shared inbound token; `Authorization: Bearer <token>`. |

`GET /health` is unauthenticated process liveness and makes no external calls.
Business routes require the service token. JSON bodies are limited to 16 KiB.
Public errors use `{ error: { code, message, requestId } }` and omit stacks and
authorization values. Logs include the request ID and redact authorization
fields.

SIGTERM/SIGINT stop accepting connections, drain for **10 seconds**, then abort
remaining in-flight work.

## Commands

```sh
npm install
npm run dev         # native TypeScript: node --env-file-if-exists=.env src/server.ts
npm run typecheck   # tsc --noEmit
npm test            # node:test tests/**/*.test.ts
npm run build       # tsc -p tsconfig.build.json
npm start           # node --env-file-if-exists=.env dist/server.js
```

Ordinary automated tests do not need GPU, models, Ollama, or cloud credentials.

## Planning documents

- [Architecture and learning plan](docs/architecture-plan.md)
- [Implementation backlog](docs/backlog.md)
