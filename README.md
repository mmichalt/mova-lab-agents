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
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Trusted local Ollama origin for host processes (`npm run dev`). The Compose `agents` service always uses `http://ollama:11434` and ignores this host value. Requests cannot choose a server, pull a model, or fall back to the cloud. |
| `OLLAMA_MODEL` | `qwen3:4b-instruct` | Explicit local model tag. |
| `OLLAMA_NUM_CTX` | `4096` | Sent as `options.num_ctx`. |
| `OLLAMA_NUM_PREDICT` | `2000` | Sent as `options.num_predict`. |
| `LLM_ATTEMPT_TIMEOUT_MS` | `120000` | One attempt deadline covering queue wait, model load, and body read. |

`GET /health` is unauthenticated process liveness and makes no external calls.
`POST /content-drafts` requires the service token, sends one structured chat
request to the configured Ollama server, and returns proposals with
`requiresHumanApproval: true`. Invalid teacher input is rejected before any
provider call. Schema-valid model refusals return `422`; malformed, truncated,
or unexpected model output returns `502`; missing models return `503`
`MODEL_UNAVAILABLE`; load/OOM and rejected settings return `503 MODEL_CAPACITY`;
unreachable or overloaded Ollama returns `503 PROVIDER_UNAVAILABLE`; attempt
timeouts return `504`. Content checks are empty until a later ticket. JSON
bodies are limited to 16 KiB.
Public errors use `{ error: { code, message, requestId } }` and omit stacks and
authorization values. Logs include the request ID and redact authorization
fields.

## Recording-proposal contracts

Runtime Zod schemas in `src/content/schemas.ts` validate teacher requests and
generated proposals. TypeScript types are inferred from those schemas; they do
not validate HTTP bodies or model JSON by themselves.

Requests accept only `easy` difficulty and target sounds **р** and **л**
(case-normalized, duplicates removed). `exerciseCount` defaults to 6, max 12,
and must be at least the number of requested sounds. Unknown fields are
rejected so patient records cannot enter the contract. Parsed proposals are not
saved Content Studio drafts: `localId` is assigned by application code, and the
model output schema cannot supply application IDs or publication controls.

Documented examples: `docs/examples/content-request.json`,
`docs/examples/model-output.json`, `docs/examples/model-output.refused.json`,
`docs/examples/generation-result.json`. Literal Cyrillic-letter presence in a
phrase is a mechanical check later; it does not establish phonetic correctness,
hard/soft realization, or therapeutic appropriateness.

Schema cases and provider-boundary tests run with `npm test` (no GPU, Ollama, or
live inference). Provider tests use a local fake HTTP server plus synthetic
Ollama chat fixtures in `tests/fixtures/ollama.ts`. They inspect `/api/chat`
path, messages, `format`/`options`, completion, refusal, errors, aborts, and
present or missing usage. Application attempt IDs are logged; provider request
IDs are not fabricated. Do not treat those fixtures as quality evidence.

Seeded request cases live in `evals/corpus.json` (Р, Л, both, and a 12-exercise
maximum). Expected qualities are properties (`ukrainian-script`, literal target
letter, count, assigned sounds), not exact generated strings. Prompt, model,
sampling, and hardware metadata are in `evals/runtime.json`.

Optional live generation (Ollama must already have the model):

```sh
curl -sS http://127.0.0.1:3000/content-drafts \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d @docs/examples/content-request.json
```

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
npm test            # node:test tests/**/*.test.ts (no Ollama)
npm run smoke:local # optional live GPU/model smoke; never part of CI
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

`GET /health` is process liveness only. Ordinary CI does not need a GPU,
Ollama, or an LLM API key. `POST /content-drafts` uses the configured local
Ollama URL and model; it never pulls models or falls back to a cloud provider.

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
`/root/.ollama`. From the host, `OLLAMA_BASE_URL` defaults to
`http://localhost:11434`; the Compose `agents` service always uses
`http://ollama:11434`, even if `.env` sets the host URL.

### Local generation smoke

Ordinary `npm test` never contacts Ollama. The optional smoke needs the Compose
`local-model` profile, a pulled `qwen3:4b-instruct`, and a running service.
It does not pull models, change context/output to hide truncation, or treat a
truncated envelope as success.

```sh
docker compose --profile local-model up -d ollama
docker compose exec ollama ollama pull qwen3:4b-instruct
npm run dev
npm run smoke:local
```

`SMOKE_BASE_URL` defaults to `http://127.0.0.1:$PORT`. The script unloads the
model and waits until it is gone from `/api/ps`, then records cold and warm
latency for the mixed Р/Л case, GPU share from `GET /api/ps`, structured-output
mapping for Р, Л, and both, and a 12-exercise maximum-size request. It exits
non-zero on HTTP failure, truncation (`PROVIDER_INCOMPLETE`), or GPU share
other than 100%. Property failures (for example missing target letters) are
recorded and do not fail the process. HTTP bodies omit usage; match `requestId`
to `llm attempt completed` logs. Record digest, quantization, Ollama version,
wall times, GPU percent, measured `nvidia-smi` hardware, and whether 4096
context / 2000 output sufficed in `evals/smoke-results.md`,
`evals/smoke-report.json`, and `evals/runtime.json`. If more capacity is needed,
measure 8192 context and a larger `num_predict`, then update this README and
the architecture plan. Wording is stochastic; do not expect identical phrases.

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
