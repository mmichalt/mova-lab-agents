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
| `WORKFLOW_TIMEOUT_MS` | `600000` | Overall run deadline (ten minutes). Each attempt uses the smaller of remaining workflow time and `LLM_ATTEMPT_TIMEOUT_MS`. Chosen deadline and the 20-provider-request budget are stored on the run and are not reset by retries. |

`GET /health` is unauthenticated process liveness and makes no external calls.
`POST /content-drafts` requires the service token, then runs a bounded workflow:
`selectVocabulary`, `generateExercises`, deterministic `validateCandidate`, and
when content checks pass, concurrent `reviewAge` and `reviewLanguage`. Application
code owns the next step and the serializable run state. The chat steps are LLM
operations, not agents: none of those functions observe results to choose a
different action, and there is no shared chat memory. Invalid teacher input is
rejected before any provider call. Invalid or failed vocabulary selection
prevents generation. Failed deterministic checks skip semantic review. When
content checks pass, `reviewAge` and `reviewLanguage` start independently with
the same immutable request and candidate; neither sees the other verdict.
`Promise.allSettled` keeps a successful review when the other fails. Concurrent
promises do not guarantee GPU speedup: this stack keeps `OLLAMA_NUM_PARALLEL=1`,
so the two reviews may queue and queue wait still consumes each attempt's
`LLM_ATTEMPT_TIMEOUT_MS`. Increase inference concurrency only after measurement.
Schema-valid generation or vocabulary refusals return `422 MODEL_REFUSED` and
do not start content revision. A schema-valid reviewer refusal is a failed named
check (`REVIEW_REFUSED`), not HTTP `422`; it cannot become a pass or trigger
revision. Malformed, truncated, or unexpected output during vocabulary still
returns `502`. The same failures during an exercise or revision call consume a
candidate version and, if revisions remain, regenerate with schema errors;
exhausted or repeated identical invalid candidates return `422`. A malformed
reviewer response is re-asked once, then becomes an `unavailable` check.
Operational review failures become `unavailable` checks, block approval, and do
not trigger revision. Missing models return `503 MODEL_UNAVAILABLE`; load/OOM
and rejected settings return `503 MODEL_CAPACITY`; unreachable or overloaded
Ollama returns `503 PROVIDER_UNAVAILABLE`; exhausted provider-call budget
returns `503 PROVIDER_BUDGET_EXHAUSTED`. Vocabulary/generation timeouts return
`504 PROVIDER_TIMEOUT` unless they occur on a review (unavailable check). The
workflow deadline returns `504 WORKFLOW_TIMEOUT` and aborts further attempts;
cancellation cannot guarantee that Ollama immediately stops GPU work. Temporary
network errors, HTTP 429, and 503 overload may retry once with jittered backoff
(honoring `Retry-After` only within remaining time). Missing models, invalid
settings, load/OOM, schema-valid refusals, and other 5xx responses do not retry;
there is no auto-pull or cloud fallback. At most two transport attempts occur
per operation, and every attempt counts toward a shared 20-provider-request
budget. Transport retries never consume a candidate version or reset the two
revision slots. A candidate that fails deterministic or semantic checks is
revised at most twice, with the original teacher request held fixed and fresh
checks on every changed candidate. `READY_FOR_REVIEW` returns `200` with
`requiresHumanApproval: true`; that flag is a checkpoint, not durable approval.
A required unavailable or refused review returns `200` with `status: "FAILED"`
and `requiresHumanApproval: false`. Exhausted revisions return `422
CONTENT_VALIDATION_EXHAUSTED`; an unchanged invalid candidate returns `422
IDENTICAL_INVALID_CANDIDATE`. A successful first-pass request makes four model
calls plus metadata fetches; a transport retry or reviewer re-ask adds another
provider attempt without changing revision limits.

JSON bodies are limited to 16 KiB.
Public errors use `{ error: { code, message, requestId } }` and omit stacks and
authorization values. Logs include the request ID, step (`vocabulary`,
`generation`, `revision`, `validation`, `age`, or `language`), prompt version,
candidate version, and revision count on workflow finish, and they redact
authorization fields. Refusal logs for vocabulary and generation may include a
clipped model reason. Reviewer refusal logs omit the reason so candidate phrases
are not echoed. Failed content checks log issue codes and paths without phrases.
Logs do not include vocabulary items or phrases.

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

Deterministic checks in `src/content/validation.ts` run after generation.
Recording type and field lengths are already enforced by the model-output
schema (`502` on violation). `validateCandidate` then checks requested count,
target-sound assignment, even distribution (remainder in request order),
duplicates, assigned-letter presence, and vocabulary use. Phrases are compared
with Unicode NFC, Ukrainian case folding (`toLocaleLowerCase('uk')`), collapsed
Unicode whitespace, stripped format characters, and apostrophe folding (`'` /
U+2019 / U+02BC / U+02B9). Vocabulary matching tokenizes that normalized string
after turning other punctuation into separators, then looks for the vocabulary
item as a contiguous whole-token sequence. Any selected item counts, even if its
associated sound differs from the exercise. Equivalent normalized token sequences
are duplicates. Each phrase must contain its assigned target letter; a longer
word that merely contains a vocabulary stem does not count. Other requested
letters may occur incidentally and do not satisfy assigned-sound coverage.
Passed checks include a `LETTER_PRESENCE_ONLY` warning: literal Cyrillic-letter
presence is not phonetic, hard/soft, or therapeutic validation. Age and language
reviews are model judgments of complexity/clarity and wording/theme; they are
not therapeutic validation either.

Documented examples: `docs/examples/content-request.json`,
`docs/examples/vocabulary-output.json`, `docs/examples/vocabulary-output.refused.json`,
`docs/examples/model-output.json`, `docs/examples/model-output.refused.json`,
`docs/examples/review-output.json`, `docs/examples/review-output.failed.json`,
`docs/examples/review-output.refused.json`,
`docs/examples/generation-result.json`.

Schema cases, content-validation, and provider-boundary tests run with
`npm test` (no GPU, Ollama, or live inference). Provider tests use a local fake
HTTP server plus synthetic Ollama chat fixtures in `tests/fixtures/ollama.ts`.
They script vocabulary and exercise step results, assert call order and that
generation receives the validated vocabulary, and verify that a failed
vocabulary step does not call generation. Invalid generated content skips
semantic review and starts a revision with structured feedback; a repeated
identical invalid candidate stops without a second revision. Passed content
starts both reviews before either settles; a blocking review finding revises
the candidate; a refused review stays failed and does not revise; an
operational review failure becomes `unavailable`, leaves the other review's
result in place, and does not revise. Controllable clocks and fake operations
cover jittered backoff, remaining-deadline checks, aborted calls, retry
exhaustion, and the shared provider-call budget; a 503 or 429 transport retry
does not consume a candidate version. They inspect
`/api/chat` path, messages, `format`/`options`, completion, refusal, errors,
aborts, and present or missing usage. Application attempt IDs are logged with step and prompt version; provider
request IDs are not fabricated. Do not treat those fixtures as quality evidence.

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
non-zero on HTTP failure, truncation (`PROVIDER_INCOMPLETE`), or when
`size_vram` is not exactly equal to `size` (partial CPU offload, including
values that would round to 100%). Property failures (for example missing target letters) are
recorded and do not fail the process. HTTP bodies omit usage; match `requestId`
and `step` to `llm attempt completed` logs. Record digest, quantization, Ollama
version, wall times, GPU percent, measured `nvidia-smi` hardware, and whether
4096 context / 2000 output sufficed in `evals/smoke-results.md`,
`evals/smoke-report.json`, and `evals/runtime.json`. A first-pass success still
makes four model calls (vocabulary, exercises, age, language). A content or
review failure may add a revision call and a second pair of reviews, still
serialized by `OLLAMA_NUM_PARALLEL=1`. Wall time is not comparable to earlier
baselines without noting those extra calls. If more capacity is needed,
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
