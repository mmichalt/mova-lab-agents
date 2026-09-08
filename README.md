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
it through Node's `--env-file-if-exists=.env`. Compose interpolates the same
file on the host and does not copy it into the image. Do not commit `.env`.

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
npm run lint        # biome check .
npm run format      # biome check --write .
npx biome ci .      # CI: lint, format, and import sorting
npm run typecheck   # tsc --noEmit
npm test            # node:test tests/**/*.test.ts
npm run build       # tsc -p tsconfig.build.json
npm start           # node --env-file-if-exists=.env dist/server.js
```

CI runs `npx biome ci .`, `npm run typecheck`, `npm test`, `npm run build`, and
`docker compose config`. Ordinary automated tests and CI do not need GPU,
models, Ollama, or cloud credentials, and they do not pull models or invoke
live inference.

## Docker

Copy `.env.example` to `.env` first. Compose interpolates `SERVICE_TOKEN` from
that file even for `config` and the `local-model` profile.

The image is a multi-stage Debian slim build: TypeScript compiles in the first
stage; the runtime has production `npm ci` from the lockfile, runs as `node`,
and does not contain `.env`. GPU access uses Compose `gpus: all` (Compose 2.30+).

```sh
docker compose up --build -d
curl -sS http://127.0.0.1:3000/health
docker compose exec agents id          # uid=1000(node)
docker compose exec agents ls /app/.env  # must not exist
```

Without Compose:

```sh
docker build -t mova-lab-agents .
docker run --rm -e SERVICE_TOKEN=replace-me -p 127.0.0.1:3000:3000 mova-lab-agents
```

`GET /health` is process liveness only. The service does not need a GPU,
Ollama, or an LLM API key.

### Local Ollama (`local-model` profile)

Ollama is optional. Validate Compose without starting it:

```sh
docker compose --profile local-model config
```

Pinned image: `ollama/ollama:0.33.3@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2`.
The container publishes `127.0.0.1:11434` only. If that host port is taken, set
`OLLAMA_HOST_PORT` to a free port; the Compose-network URL stays
`http://ollama:11434`. Use `http://localhost:11434` from the host (or
`http://localhost:$OLLAMA_HOST_PORT`). Pull models explicitly; never during an
image build, CI, or an HTTP generation request.

```sh
docker compose --profile local-model up -d ollama
docker compose exec ollama ollama pull qwen3:4b-instruct
docker compose exec ollama ollama run qwen3:4b-instruct
docker compose exec ollama ollama ps
```

After a prompt, `ollama ps` should show `100% GPU`. Record CPU offload instead
of assuming GPU acceleration. Models persist in the `ollama` volume at
`/root/.ollama`. Generation smoke coverage belongs to later tickets.

### GPU prerequisites

This workstation is Ubuntu 26.04 LTS on WSL2. Use the Windows/WSL2 path; do not
install the NVIDIA Container Toolkit inside the WSL distro.

- **Windows / WSL2:** Docker Desktop with the WSL2 backend, current NVIDIA
  drivers that support WSL2 GPU-PV, and GPU support in Docker Desktop.
  Enable WSL integration for this distro. See
  [Docker Desktop GPU support](https://docs.docker.com/desktop/features/gpu/).
- **Native Linux:** current NVIDIA driver plus the
  [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html),
  then `nvidia-ctk runtime configure --runtime=docker`.

Confirm GPU access before relying on the `local-model` profile:

```sh
docker run --rm --gpus all --entrypoint nvidia-smi ollama/ollama:0.33.3
```

## Planning documents

- [Architecture and learning plan](docs/architecture-plan.md)
- [Implementation backlog](docs/backlog.md)
