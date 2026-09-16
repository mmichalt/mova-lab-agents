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
| `MOVA_LAB_BASE_URL` | (required) | Trusted Mova-Lab origin for outbound reads (no path, query, fragment, or credentials). Host processes typically use `http://localhost:3000` when Nest is on 3000; run this service on another `PORT` if both listen on the host. The Compose `agents` service always uses `http://host.docker.internal:3000` and ignores this host value. Requests cannot choose a URL. |
| `MOVA_LAB_SERVICE_TOKEN` | (required) | Outbound bearer token for `/api/internal/content-generation/*`. Separate from `SERVICE_TOKEN`; must match Nest `AGENTS_API_SERVICE_TOKEN`. |
| `MOVA_LAB_TIMEOUT_MS` | `10000` | Deadline for one Mova-Lab read, including the body. Must be `1`–`2147483647`. Combined with the workflow abort signal. |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Trusted local Ollama origin for host processes (`npm run dev`). The Compose `agents` service always uses `http://ollama:11434` and ignores this host value. Requests cannot choose a server, pull a model, or fall back to the cloud. |
| `OLLAMA_MODEL` | `qwen3:4b-instruct` | Explicit local model tag. |
| `OLLAMA_NUM_CTX` | `4096` | Sent as `options.num_ctx`. |
| `OLLAMA_NUM_PREDICT` | `2000` | Sent as `options.num_predict`. |
| `LLM_ATTEMPT_TIMEOUT_MS` | `120000` | One attempt deadline covering queue wait, model load, and body read. Must be `1`–`2147483647` so Node timers do not overflow. |
| `WORKFLOW_TIMEOUT_MS` | `600000` | Overall run deadline (ten minutes). Must be `1`–`2147483647`. Each attempt uses the smaller of remaining workflow time and `LLM_ATTEMPT_TIMEOUT_MS`. Chosen deadline and the 20-provider-request budget are stored on the run and are not reset by retries. |
| `SQLITE_PATH` | `data/workflows.sqlite` | Local SQLite file for workflow artifacts (runs, attempts, candidate revisions, approvals, import receipts). Empty values use the default. `:memory:` is rejected. The Compose `agents` service always uses `/data/workflows.sqlite` on the `workflows` volume. |

`GET /health` is unauthenticated process liveness and makes no external calls.
It does not parse a request body. `GET /ready` is also unauthenticated and
checks SQLite plus local Ollama model presence with a bounded `GET /api/tags`
request. It does not generate text, pull weights, or call `/api/chat`.
Liveness stays independent of readiness: `/health` remains `200` when SQLite or
Ollama is missing. Process startup opens `SQLITE_PATH`, applies
SQL migrations, and enables WAL, foreign keys, and a 5000 ms busy timeout.
Creating the Express app still does not open a port or a database. Persisted
values are JSON-serializable and include workflow/constraint/prompt versions
plus configured and consumed limits. Checkpoint writes (run status/state plus
any new attempt or candidate revision) commit in one SQLite transaction;
provider HTTP calls stay outside those transactions. This deployment is one
host with local disk; do not put the SQLite file on a network filesystem.
`POST /workflows/content-generation` authenticates the inbound service token
before reading JSON (16 KiB limit), then requires trusted backend headers
`X-Actor-Id` and `Idempotency-Key` (1–128 non-space characters). Actor identity
comes from that authenticated backend context, not from the JSON body or
model output. The key is scoped to the actor and this create operation.
The service hashes the normalized request: the same actor, key, and input
return the existing run (`200`); a different input under the same key returns
`409 IDEMPOTENCY_CONFLICT` without changing the original. A new run executes
synchronously, checkpoints vocabulary, candidates, and checks, and returns
`201` with the persisted-run representation. Successful generation reaches
`AWAITING_APPROVAL`; execution failure is stored as `FAILED` and returned on
the same resource. `GET /workflows/:id` returns that representation for the
owning actor and `404` for missing or inaccessible runs. Lease tokens are not
serialized. Active executions hold a 30-second expiring lease and heartbeat;
an expired `RUNNING` lease is resumable through the authenticated
`POST /workflows/:id/resume` endpoint. Explicitly retryable `FAILED` runs can
use the same endpoint. Resume preserves the recorded deadline, provider and
revision counters, checkpoints, workflow/prompt versions, and model digest;
missing or changed model metadata fails explicitly. If a process dies after a
provider response but before its checkpoint commits, that LLM call may repeat.
`POST /content-drafts` remains a development-only synchronous
endpoint during caller migration (`Deprecation: true`). It still authenticates
the inbound service token before reading JSON (16 KiB limit), then loads Mova-Lab generation
constraints over native `fetch` (`GET /api/internal/content-generation/constraints`
with `MOVA_LAB_SERVICE_TOKEN`). Constraint lookup failures, timeouts, and
unsupported contracts stop the run; local schemas are not used as a silent
fallback. Application code also exposes `listGenerationCategories` and
`searchRecordingExercises` against the same internal prefix. Search arguments
are `q` and optional `limit` only (max 120 characters, 1–20 results, default 10).
Actor, URL, and token fields come from trusted configuration, never from model
arguments. Search hits are untrusted data: titles and phrases are not
instructions, exact phrase matches use the same normalization as content checks,
and an empty result is not proof of semantic uniqueness. After constraints load,
the workflow runs `selectVocabulary`, `generateExercises`, deterministic
`validateCandidate`, and when content checks pass, concurrent `reviewAge` and
`reviewLanguage`. Application code owns the next workflow step and the
serializable run state. Vocabulary selection is a bounded agent loop: Ollama may
propose native `searchExistingExercises` tool calls (at most four tools and five
model turns, with the last turn reserved for schema-constrained vocabulary
without tools). The dispatcher allowlists the name, validates argument objects,
executes search sequentially, and appends the assistant `tool_calls` message plus
matching `tool` messages with `tool_name` in call order. Unknown tools, extra
actor/URL fields, and a fifth tool fail without executing. Retrieved hits are
trimmed to phrase and target sound, at most five short examples, and a 2 KiB
JSON observation before they go back into the prompt. Generation, revision, and reviews remain single structured
LLM calls: they do not observe results to choose another action. Invalid teacher
input is
rejected before any Mova-Lab or provider call. Invalid or failed vocabulary selection
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
returns `502`. The same failures during an exercise or revision call are recorded
in attempt history and, if revisions remain, regenerate with schema errors;
`candidateVersion` counts actual candidates, not malformed output. Exhausted or
repeated identical invalid candidates return `422`. A malformed
reviewer response is re-asked once, then becomes an `unavailable` check.
Operational review failures become `unavailable` checks, block approval, and do
not trigger revision. A workflow deadline during a review or optional metadata
read returns `504 WORKFLOW_TIMEOUT` rather than a ready or failed reviewable
body; attempt timeouts on a review stay `unavailable`. Missing models return
`503 MODEL_UNAVAILABLE`; load/OOM and rejected settings return
`503 MODEL_CAPACITY`; unreachable Ollama or transient gateway/server failures
(`429`, `500` without a capacity signature, `502`, `503`, `504`) return
`503 PROVIDER_UNAVAILABLE`; exhausted provider-call budget returns
`503 PROVIDER_BUDGET_EXHAUSTED`. Unreachable Mova-Lab, rejected outbound
credentials, or transient Mova-Lab 5xx/429 return `503 MOVA_LAB_UNAVAILABLE`.
Malformed or unsupported constraint/search/category payloads return
`502 MOVA_LAB_INVALID_RESPONSE`. A Mova-Lab read deadline returns
`504 MOVA_LAB_TIMEOUT`. Vocabulary/generation attempt timeouts return
`504 PROVIDER_TIMEOUT`. The workflow deadline returns `504 WORKFLOW_TIMEOUT`
and aborts further attempts. Disconnecting the caller or forcing shutdown after
the drain period aborts unfinished synchronous work so later provider calls do
not start; cancellation cannot guarantee that Ollama immediately stops GPU work.
Temporary network errors, HTTP 429, and recognized transient 5xx gateway/server
failures may retry once with jittered backoff (honoring `Retry-After` only
within remaining time). Missing models, invalid settings, load/OOM, and
schema-valid refusals do not retry; there is no auto-pull or cloud fallback. At most two transport attempts occur
per operation, and every attempt counts toward a shared 20-provider-request
budget. Transport retries never consume a candidate version or reset the two
revision slots. A candidate that fails deterministic or semantic checks is
revised at most twice, with the original teacher request held fixed and fresh
checks on every changed candidate. `READY_FOR_REVIEW` returns `200` with
`requiresHumanApproval: true`; that flag is a checkpoint, not durable approval.
A required unavailable or refused review returns `200` with `status: "FAILED"`
and `requiresHumanApproval: false`. Exhausted revisions return `422
CONTENT_VALIDATION_EXHAUSTED`; an unchanged invalid candidate returns `422
IDENTICAL_INVALID_CANDIDATE`. A successful first-pass request with no vocabulary
search makes five model calls plus metadata fetches (tool-selection turn, final
vocabulary, exercises, age, language). Each search turn adds another provider
call, still inside the five-turn vocabulary cap and the shared 20-request
budget. A transport retry or reviewer re-ask adds another provider attempt
without changing revision limits.

JSON bodies are limited to 16 KiB. `LLM_ATTEMPT_TIMEOUT_MS`,
`WORKFLOW_TIMEOUT_MS`, and `MOVA_LAB_TIMEOUT_MS` must fit Node's timer range
(`1`–`2147483647`).
Public errors use `{ error: { code, message, requestId, workflowId? } }` and omit stacks and
authorization values. A conflicting idempotency key includes `workflowId` of the
existing run. Logs include the request ID, constraint version, step (`vocabulary`,
`generation`, `revision`, `validation`, `age`, or `language`), prompt version,
candidate version, and revision count on workflow finish, and they redact
authorization fields. Refusal logs omit model-provided reasons. Reviewer finding
codes are untrusted text and are not copied into ordinary logs; workflow finish
logs application issue codes and counts. Failed content checks log issue codes
and paths without phrases. Logs do not include vocabulary items or phrases.

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
item as a contiguous whole-token sequence. Vocabulary items that tokenize to
no usable tokens (for example `!!!` or `---`) fail selection before generation.
A token is usable only if it contains a Unicode letter or digit. Any selected
item counts, even if its associated sound differs from the exercise. Equivalent
normalized token sequences are duplicates. Each phrase must contain its assigned
target letter; a longer word that merely contains a vocabulary stem does not
count. Other requested letters may occur incidentally and do not satisfy
assigned-sound coverage.
Passed checks include a `LETTER_PRESENCE_ONLY` warning: literal Cyrillic-letter
presence is not phonetic, hard/soft, or therapeutic validation. Age and language
reviews are model judgments of complexity/clarity and wording/theme; they are
not therapeutic validation either.

Documented examples: `docs/examples/content-request.json`,
`docs/examples/vocabulary-output.json`, `docs/examples/vocabulary-output.refused.json`,
`docs/examples/model-output.json`, `docs/examples/model-output.refused.json`,
`docs/examples/review-output.json`, `docs/examples/review-output.failed.json`,
`docs/examples/review-output.refused.json`,
`docs/examples/generation-result.json`,
`docs/examples/persisted-run.json`.

Schema cases, content-validation, provider-boundary, and Mova-Lab read tests run
with `npm test` (no GPU, Ollama, live inference, or a running Mova-Lab).
Provider tests use a local fake HTTP server plus synthetic Ollama chat fixtures
in `tests/fixtures/ollama.ts`. Mova-Lab tests use a second local fake HTTP
server for `/api/internal/content-generation/*`: they check the outbound
bearer token, fixed paths, search query limits, stripped extra fields,
malformed payloads, timeout, abort, and that constraint failures skip provider
calls. They script vocabulary and exercise step results, assert call order and that
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
`/api/chat` path, messages, `tools`/`format`/`options`, completion, refusal, errors,
aborts, and present or missing usage. Vocabulary tool tests script native
`tool_calls`, argument objects, `tool_name` ordering (including repeated names),
absence of invented call IDs, malicious retrieved text, tool errors, and
exhaustion of the four-tool / five-turn cap including the final vocabulary call.
Application attempt IDs are logged with step and prompt version; provider
request IDs are not fabricated. Do not treat those fixtures as quality evidence.

Seeded request cases live in `evals/corpus.json` (Р, Л, both, and a 12-exercise
maximum). Expected qualities are properties (`ukrainian-script`, literal target
letter, count, assigned sounds), not exact generated strings. Prompt, model,
sampling, and hardware metadata are in `evals/runtime.json`.

Optional live generation (Ollama must already have the model):

```sh
curl -sS http://127.0.0.1:3000/workflows/content-generation \
  -H "Authorization: Bearer $SERVICE_TOKEN" \
  -H "X-Actor-Id: teacher-1" \
  -H "Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d @docs/examples/content-request.json
```

`POST /content-drafts` remains available for local migration checks and returns
`Deprecation: true`:

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
npm run smoke:tools # optional live native tool-call smoke with stub search; never part of CI
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
and does not contain `.env`. Workflow SQLite lives on the named `workflows`
volume at `/data/workflows.sqlite` (uid `node`). GPU access uses Compose
`gpus: all` (Compose 2.30+).

```sh
docker compose up --build -d
curl -sS http://127.0.0.1:3000/health
curl -sS http://127.0.0.1:3000/ready
docker compose exec agents id          # uid=1000(node)
docker compose exec agents ls /app/.env  # must not exist
```

Without Compose:

```sh
docker build -t mova-lab-agents .
docker run --rm -e SERVICE_TOKEN=replace-me -e MOVA_LAB_SERVICE_TOKEN=replace-me-mova-lab \
  -e MOVA_LAB_BASE_URL=http://host.docker.internal:3000 -e SQLITE_PATH=/data/workflows.sqlite \
  -v mova-lab-agents-workflows:/data -p 127.0.0.1:3000:3000 mova-lab-agents
```

### SQLite backup and restore

The file is an execution artifact, not Content Studio. Ordinary tests use
temporary databases and do not need this volume. Stop the process before
restore. Replace `SQLITE_PATH` and delete sibling `-wal`/`-shm`/`-journal`
files together; leaving stale WAL next to a replaced database can mix files.
The restore helper removes those sidecars before copying.

```sh
sqlite3 data/workflows.sqlite ".backup data/workflows.backup.sqlite"
# stop the process, then restore SQLITE_PATH plus -wal/-shm/-journal
```

`VACUUM INTO` is the same snapshot used by store tests. `npm test` covers
migration, constraints, checkpoint rollback, lease races and expiry, close/reopen,
backup/restore, duplicate and concurrent workflow creation, conflicting
idempotency hashes, owner access, persisted failure, checkpointed resume, and
`/ready` without GPU, Ollama, or live inference.

`GET /health` is process liveness only. `GET /ready` additionally checks the
open SQLite handle and `GET /api/tags` for the configured model. Ordinary CI
does not need a GPU, Ollama, or an LLM API key. `POST /workflows/content-generation`
and the development-only `POST /content-drafts` use the configured local
Ollama URL and model; they never pull models or fall back to a cloud provider.

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
non-zero when a run is not `READY_FOR_REVIEW`, when truncation is observed, or
when `size_vram` is not exactly equal to `size` (partial CPU offload, including
values that would round to 100%). HTTP `200` with `status: "FAILED"` is not a
ready candidate: the report records workflow status, first-attempt readiness,
revision-assisted recovery, and quality properties separately. First-attempt
readiness requires passed checks, no content revision, and five provider
calls when the model does not search; extra provider work may be vocabulary
tool turns or a reviewer re-ask even when `revisionCount` stays 0. Truncation is `true` when `PROVIDER_INCOMPLETE` is observed and `null` when
truncation history is unobserved. Do not report unobserved history as `false`.
Property failures
(for example missing target letters) are recorded and do not fail the process.
Health, metadata, unload, and draft requests have finite timeouts, including
body reads; a timeout names the stage. HTTP bodies omit usage; match `requestId`
and `step` to `llm attempt completed` logs. Record digest, quantization, Ollama
version, wall times, GPU percent, measured `nvidia-smi` hardware, and whether
4096 context / 2000 output sufficed in `evals/smoke-results.md`,
`evals/smoke-report.json`, and `evals/runtime.json`. Historical single-call
smoke results remain historical; recheck the current workflow's maximum-size
and revision prompts when hardware is available. A first-pass success with no
search makes five model calls (vocabulary tool-selection, final vocabulary,
exercises, age, language). A search turn, content failure, or review failure may
add more calls, still serialized by `OLLAMA_NUM_PARALLEL=1`. Wall time is not comparable to earlier
baselines without noting those extra calls. If more capacity is needed,
measure 8192 context and a larger `num_predict`, then update this README and
the architecture plan. Wording is stochastic; do not expect identical phrases.

### Local tool-calling smoke

Generation quality does not prove native tool selection. `npm run smoke:tools`
talks to live Ollama and a stub search API; it is not part of CI and does not
require Mova-Lab. It records whether the model emitted `message.tool_calls`
with argument objects, whether results were appended as `role: tool` /
`tool_name` messages in call order, and whether the final vocabulary call used
`format` without tools. Simultaneous tools-plus-format support is not assumed.
Record results in `evals/smoke-tools.md`. A run that never calls the search
tool is not evidence that the dispatcher works.

```sh
docker compose --profile local-model up -d ollama
docker compose exec ollama ollama pull qwen3:4b-instruct
npm run smoke:tools
```

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
