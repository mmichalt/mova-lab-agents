# Mova-Lab Agents implementation backlog

**Status:** AG-001 through AG-011 and AG-029 are complete. Remaining tickets are unstarted.

Read the [architecture and learning plan](architecture-plan.md) for the complete
design and rationale. Start with AG-001 and follow dependencies. Ticket numbers
are stable identifiers, not issue numbers from an external tracker.

## Working agreement

- Each ticket should leave a runnable increment or a focused, verifiable contract.
- Follow existing repository instructions in whichever repository a ticket targets.
- Update the relevant explanation and verification commands as behavior is implemented.
- Use explicit TypeScript functions and small modules. Add no generic repositories,
  dependency-injection containers, abstract agent classes, or orchestration frameworks.
- Use local Ollama in Docker with `qwen3:4b-instruct` as the initial model, via native Node `fetch`; no cloud fallback or provider SDK.
- Target the 14th-generation i7, 32 GB RAM, and RTX 5060 (assumed 8 GB VRAM) workstation; start with one loaded model and one inference at a time.
- Ordinary automated verification requires no GPU, downloaded models, running Ollama, or cloud credentials and must not invoke live inference.
- Local smoke tests and evaluations are separate, explicitly invoked activities; record actual results and model/runtime versions.
- Keep publication outside this service and outside all model-visible tools.
- Mark a ticket complete only after its acceptance criteria and verification pass.
- Suggested commit titles appear in the architecture plan. A ticket may need more
  than one commit; do not combine unrelated tickets merely to reduce commit count.
- Use ponytail skill to reduce LOC bloating
- After ticket is implemented, ask GPT-5.6-Sol high to review it, then fix the issues with the starting model (latest grok on High), create branch from main (name should include the ticket tag) and open a PR.

## Ticket index

### Milestone 1 — Standalone generator

- [x] [AG-001 — Bootstrap TypeScript and Express](#ag-001)
- [x] [AG-002 — Configuration, authentication, logging, and lifecycle](#ag-002)
- [x] [AG-003 — Docker support and CI](#ag-003)
- [x] [AG-004 — Recording-proposal contracts](#ag-004)
- [x] [AG-005 — One structured LLM generation operation](#ag-005)
- [x] [AG-006 — Provider tests and baseline examples](#ag-006)
- [x] [AG-007 — Sequential vocabulary and exercise generation](#ag-007)
- [x] [AG-008 — Deterministic content validation](#ag-008)
- [x] [AG-009 — Concurrent semantic reviews](#ag-009)
- [x] [AG-010 — Workflow state and bounded content revision](#ag-010)
- [x] [AG-011 — Retries, deadlines, and execution budgets](#ag-011)
- [x] [AG-029 — Milestone 1 review follow-up: security, failures, and verification](#ag-029)

### Milestone 2 — Tools and durable human approval

- [ ] [AG-012 — Internal read APIs in Mova-Lab](#ag-012)
- [ ] [AG-013 — Validated Mova-Lab HTTP functions](#ag-013)
- [ ] [AG-014 — Bounded model-selected tool calling](#ag-014)
- [ ] [AG-015 — SQLite persistence and migrations](#ag-015)
- [ ] [AG-016 — Persisted workflow creation and retrieval](#ag-016)
- [ ] [AG-017 — Claims and interrupted-run recovery](#ag-017)
- [ ] [AG-018 — Idempotent draft import in Mova-Lab](#ag-018)
- [ ] [AG-019 — Durable approval and rejection](#ag-019)
- [ ] [AG-020 — Approved draft import and partial recovery](#ag-020)
- [ ] [AG-021 — Generation and review UI in Mova-Lab](#ag-021)

### Milestone 3 — Asynchronous execution

- [ ] [AG-022 — Redis/BullMQ producer and worker](#ag-022)
- [ ] [AG-023 — Reconciliation and bounded redelivery](#ag-023)
- [ ] [AG-024 — Worker recovery tests and asynchronous UI](#ag-024)

### Milestone 4 — Dynamic orchestration and measurement

- [ ] [AG-025 — Experimental constrained supervisor](#ag-025)
- [ ] [AG-026 — Distributed tracing and cost reporting](#ag-026)
- [ ] [AG-027 — Budgeted evaluation runner](#ag-027)
- [ ] [AG-028 — Workflow comparison and findings](#ag-028)

## Milestone 1: standalone recording-proposal generator

**Exit criteria:** A structured teacher request produces reviewable Ukrainian
recording proposals for Р/Л or a clear failure. No content is persisted, imported,
or published automatically.

### AG-001

**Title:** Bootstrap TypeScript and Express  
**Stage:** 1  
**Repository:** `mova-lab-agents`  
**Dependencies:** None  
**Status:** Complete

**Problem and learning objective:** Establish the execution environment while
understanding the distinction between an Express app, a listening process,
TypeScript checking, and JavaScript execution.

**Implementation scope:** Configure npm, a lockfile, Node 24, strict TypeScript,
ESM, native TypeScript development execution, and production compilation.
Separate application construction from the server entry point. Use the built-in
Node test runner.

**Acceptance criteria:**

- Development startup, type-checking, tests, production build, and production
  startup have documented commands.
- Importing the app does not open a network port.
- Production execution uses compiled JavaScript; source imports compile correctly.
- No NestJS, orchestration framework, or speculative feature directories are added.

**Verification:** Run type-checking, one app-construction test, and a production
build/start check without provider credentials.

**Out of scope:** LLM calls, persistence, business endpoints, queues, and Docker.

### AG-002

**Title:** Add configuration, authentication, logging, and lifecycle handling  
**Stage:** 1  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-001](#ag-001)  
**Status:** Complete

**Problem and learning objective:** Understand trust boundaries and process
lifecycle before adding slow external operations.

**Implementation scope:** Parse configuration once using Zod, configure Pino
redaction, assign request IDs, add `GET /health`, service-token middleware,
a 16 KiB JSON limit, and centralized sanitized error responses. Support bounded
graceful shutdown and environment-file loading without committing secrets.

**Acceptance criteria:**

- Invalid configuration prevents listening; health makes no external calls.
- Protected routes reject invalid tokens before business work starts.
- Errors and logs include correlation IDs and omit authorization values and stacks
  from public responses.
- Shutdown stops new work and has a documented finite drain period.

**Verification:** Exercise configuration failures, unauthorized requests against
a test-only protected route, oversized/malformed JSON, sanitized errors, and
shutdown behavior.

**Out of scope:** Teacher login, browser CORS, provider credentials, and readiness
checks for infrastructure that does not yet exist.

### AG-003

**Title:** Add Docker support and CI  
**Stage:** 1  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-002](#ag-002)  
**Status:** Complete

**Problem and learning objective:** Make the service reproducible outside the
development shell and understand build-time versus runtime dependencies.

**Implementation scope:** Add a multi-stage Debian-slim Dockerfile, non-root runtime,
production-only dependencies, Docker ignore rules, environment documentation,
and CI for offline tests, type-checking, Biome, and production build. Add `compose.yaml`
with the service and an optional `local-model` profile containing the official
Ollama image, a persistent `/root/.ollama` volume, and NVIDIA GPU access.

**Acceptance criteria:**

- The image builds from the committed lockfile and serves health.
- Runtime runs as non-root and does not contain the local `.env`.
- CI and standalone service health/startup work without a GPU, Ollama, downloaded models, or an LLM API key.
- CI runs `biome ci` (lint, format, and import sorting), `npm run typecheck`, `npm test`, and `npm run build`. Do not add ESLint or Prettier.
- README explains local and Docker startup and the expected environment variables.
- Document host-specific GPU prerequisites (Linux NVIDIA Container Toolkit or
  Windows Docker/WSL2 setup), a tested Ollama image version/digest, explicit model
  pull, and `ollama ps` verification. This workstation is Ubuntu 26.04 LTS on
  WSL2; do not assume GPU passthrough is already configured.
- Ollama uses `OLLAMA_NUM_PARALLEL=1`, `OLLAMA_MAX_LOADED_MODELS=1`, and
  `OLLAMA_NO_CLOUD=1`; publish its API only on `127.0.0.1:11434` for host access.
- Document host URL `http://localhost:11434` versus Compose URL
  `http://ollama:11434`; model downloads happen outside image builds and CI.

**Verification:** Build and run the image, inspect its runtime user, request health,
and execute the CI commands locally. Validate Compose configuration without a
GPU. Separately verify local GPU access and model-volume persistence when the
profile is exercised; record unavailable hardware checks rather than claiming
they passed. Generation smoke coverage belongs to AG-006.

Recorded on Ubuntu 26.04 LTS / WSL2, Node 24.19, Docker Desktop 4.87.0:
image built from the lockfile; runtime user `node`; no `.env` or TypeScript in
the image; `GET /health` returned `{"status":"ok"}`; `biome ci`, typecheck,
tests, build, and `docker compose config` passed. GPU: RTX 5060 Laptop visible
to `nvidia-smi` and inside the Ollama container; `/root/.ollama` survived
restart. Host `11434` was already bound by another stack; Compose-network
`http://ollama:11434/api/tags` returned 200. `qwen3:4b-instruct` was not pulled.

**Out of scope:** Deployment, Kubernetes, database containers, Redis, and changes
to Mova-Lab deployment.

### AG-004

**Title:** Define recording-proposal request and output contracts  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-002](#ag-002)  
**Status:** Complete

**Problem and learning objective:** Learn why TypeScript types cannot validate
HTTP or model data and why generated proposals differ from saved application content.

**Implementation scope:** Add Zod schemas and inferred types for requests,
recording proposals, validation issues, check results, and usage metadata.
Apply the architecture plan's field limits and defaults. Keep local proposal IDs
application-assigned and application content IDs absent.

**Acceptance criteria:**

- Requests normalize Р/Л case, remove repeated sounds, enforce counts and limits,
  reject unknown fields, and accept only the initial `easy` difficulty.
- Output schemas enforce recording fields and existing application length limits.
- The model output contract cannot supply publication controls or application IDs.
- Example JSON documents the contract and its phonetic-validation limitations.

**Verification:** Table-driven valid, missing, oversized, unknown-field, wrong-type,
unsupported-sound, and count-boundary cases.

Recorded: schema tests cover those cases plus model-output rejection of
publication/application IDs; documented examples parse; `npm test`,
`npm run typecheck`, and `npx biome ci .` pass without GPU, Ollama, or live
inference.

**Out of scope:** Live generation, new exercise types, phonetic transcription,
application categories, and patient data.

### AG-005

**Title:** Implement one structured LLM generation operation  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-004](#ag-004)  
**Status:** Complete

**Problem and learning objective:** Observe exactly what messages and parameters
are sent to a model and how its response becomes trusted application data.

**Implementation scope:** Add `POST /content-drafts` using native `fetch` to
Ollama's `POST /api/chat`. Send `qwen3:4b-instruct`, versioned messages,
`stream: false`, and `format: z.toJSONSchema(...)`; parse and validate the native
response envelope and `message.content`. Use the architecture's model-facing
generated/refused union and map generated proposals to the existing domain result.
Add validated `OLLAMA_BASE_URL`, `OLLAMA_MODEL`, `OLLAMA_NUM_CTX` (4096),
`OLLAMA_NUM_PREDICT` (2000), and `LLM_ATTEMPT_TIMEOUT_MS` (120000). Send context,
output, and temperature (0.3) under `options`. Make one attempt with no retries.
Capture application attempt ID, model tag/digest, Ollama version, prompt version,
wall/load timing, and reported usage; leave unmeasured local cost null.

**Acceptance criteria:**

- Valid requests produce proposals with `requiresHumanApproval: true`.
- System instructions and teacher task data are visibly separate.
- Schema-valid refusals are terminal; free-text refusals follow invalid-output
  handling. Do not assume a dedicated provider refusal field or detect refusal
  through guessed keywords.
- HTTP errors, missing model, incomplete/truncated output, unexpected tool calls,
  invalid JSON, and schema failures have explicit outcomes; no permissive repair.
- Timeout/abort covers queue wait, model loading, and response-body reading.
- The server URL/model come from trusted configuration; requests cannot choose
  endpoints, pull models, or trigger a cloud fallback. No provider API key is needed.
- Only the provider module depends on provider response types.

**Verification:** Use a local fake HTTP server for successful, malformed, and
schema-valid refused responses; assert native request fields and confirm invalid
user input makes no provider call.

**Out of scope:** Provider switching, streaming, decomposition, automatic retries,
revision, persistence, and approval endpoints.

Recorded: `POST /content-drafts` sends one native Ollama `/api/chat` attempt
(`stream: false`, `format` from `z.toJSONSchema`, temperature 0.3, configured
ctx/predict). Fake HTTP coverage includes generated output, schema-valid
refusal, free-text/invalid JSON/schema/truncated/tool-call failures, 404/503,
queue-wait and stalled-body timeouts, and unreachable Ollama. Invalid input and
missing tokens make no provider call. `npm test` (91), `npm run typecheck`,
`npx biome ci .`, `npm run build`, and `docker compose config` pass without GPU,
Ollama, or live inference.

### AG-006

**Title:** Test the provider boundary and establish baseline examples  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-005](#ag-005), [AG-003](#ag-003)  
**Status:** Complete

**Problem and learning objective:** Distinguish testing the integration protocol
from evaluating whether generated content is useful.

**Implementation scope:** Add synthetic Ollama chat fixtures and local fake HTTP
transport coverage. Seed a small synthetic request corpus and prompt/model/runtime
metadata. Document an optional local smoke-test procedure using AG-003's Compose
setup, without making GPU/model availability a dependency of ordinary tests.

**Acceptance criteria:**

- Tests inspect path, messages, format/options, and cover valid output, wrong shape,
  invalid JSON, explicit/free-text refusal, truncation, stalled response bodies,
  aborts, missing model (404), overload (503), model load/OOM errors, unreachable
  Ollama, and present/missing usage. Provider request IDs must not be fabricated.
- Normal tests work without GPU/models/credentials and do not contact Ollama.
- Initial examples cover Р, Л, and both; expected qualities are properties rather
  than exact generated strings.
- Record model tag/digest/quantization, Ollama version, context/output/sampling
  settings, and hardware so the baseline can be reproduced without implying
  identical stochastic wording.
- Local smoke checks cover `100% GPU`, cold/warm latency, structured output,
  Ukrainian quality, and maximum-size/12-exercise requests. Record whether the
  initial 4096-context/2000-output settings suffice; if more capacity is needed,
  measure adjusted settings and update both planning documents. Never silently
  drop requirements to fit context or label truncated output a success.

**Verification:** Run the suite without Ollama or provider credentials and inspect
transport-call assertions. Invoke the local model smoke test separately; record
actual quality/latency/GPU results, or clearly state that it was not run.

**Out of scope:** Full evaluation runner, model leaderboard, and fabricated
live-provider results.

Recorded: `npm test` (96), `npm run typecheck`, `npx biome ci .`, `npm run build`,
and `docker compose config` pass without GPU, Ollama, or live inference. Fake HTTP
coverage includes generated output, missing usage, wrong shape, invalid JSON,
explicit/free-text refusal, truncation, stalled bodies, aborts, 404/503,
load/OOM, and unreachable Ollama; chat payloads have no fabricated provider IDs.
Local smoke (`npm run smoke:local`, 2026-09-08): `qwen3:4b-instruct` digest
`0edcdef34593…`, Q4_K_M, Ollama 0.33.3, RTX 5060 Laptop 8151 MiB, 100% GPU,
cold 14.3 s / warm 12.8 s, 12-exercise 21.3 s / 1452 output tokens, no truncation;
4096/2000 sufficed. Л-only failed literal target-letter presence. Details in
`evals/smoke-results.md`.

### AG-007

**Title:** Split generation into vocabulary and exercise steps  
**Stage:** 3  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-006](#ag-006)  
**Status:** Complete

**Problem and learning objective:** Learn sequential orchestration and make
intermediate content decisions inspectable.

**Implementation scope:** Introduce validated vocabulary output and explicit
`selectVocabulary` and `generateExercises` functions, called in sequence by
the workflow. Pass request and vocabulary directly; extract repeated provider
transport only when the duplication now exists.

**Acceptance criteria:**

- Invalid or failed vocabulary selection prevents generation.
- Generation receives exactly the validated vocabulary and original requirements.
- Logs identify the step and prompt version without exposing raw content by default.
- Documentation explains why these functions are LLM operations rather than autonomous agents.

**Verification:** Script both step results, assert arguments and order, and verify
that downstream calls do not occur after upstream failure.

**Out of scope:** Generic workflow engines, agent classes, parallel steps,
tool calling, and hidden shared chat memory.

Recorded: `POST /content-drafts` calls `selectVocabulary` then `generateExercises`.
The second user payload is `{ request, vocabulary }` from the validated first-step
object, not the raw model string. Failed vocabulary (refusal, invalid JSON, or
sounds that do not cover the request) makes one `/api/chat` call. Logs include
`step` and prompt version (`vocabulary/v1`, `exercises/v1`) and omit raw words
and phrases. Transport lives in `src/llm/ollama.ts`. `npm test` (104),
`npm run typecheck`, `npx biome ci .`, `npm run build`, and
`docker compose config` pass without GPU, Ollama, or live inference.

### AG-008

**Title:** Add deterministic content validation  
**Stage:** 3  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-007](#ag-007)  
**Status:** Complete

**Problem and learning objective:** Separate exact application rules from
probabilistic model judgments.

**Implementation scope:** Check required fields, count, recording type, sound
distribution, duplicates, target-letter presence, and selected vocabulary usage.
Define Unicode/case/whitespace normalization and normalized token matching.
Produce structured issues with codes and affected paths.

**Acceptance criteria:**

- Both single-sound and mixed-sound requests enforce the documented distribution.
- Equivalent normalized phrases are reported as duplicates.
- Invalid content never becomes a successful reviewable result.
- Documentation states that letter matching is not phonetic or therapeutic validation.

**Verification:** Use table-driven valid and invalid candidates, including mixed
case, Unicode normalization, spacing, missing vocabulary, and incidental sound
occurrence versus assigned target coverage.

**Out of scope:** LLM reviewers, linguistic inflection engines, embeddings,
clinical suitability claims, and automatic correction.

Recorded: `validateCandidate` runs after `generateExercises`. Phrases use NFC,
Ukrainian case folding, and collapsed Unicode whitespace; vocabulary matching
is whole-token after stripping surrounding punctuation. Mixed requests require
even assigned-sound distribution with remainder in request order; incidental
letters do not count. Equivalent normalized phrases are `DUPLICATE_PHRASE`.
Failed checks return `200` with `status: "failed"` and are not a passed
reviewable result. Passed checks include `LETTER_PRESENCE_ONLY`. `npm test` (118),
`npm run typecheck`, `npx biome ci .`, `npm run build`, and
`docker compose config` pass without GPU, Ollama, or live inference.

### AG-009

**Title:** Add concurrent age and language reviews  
**Stage:** 4  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-008](#ag-008)  
**Status:** Complete

**Problem and learning objective:** Learn independent I/O concurrency, fan-out/fan-in,
and the difference between negative feedback and operational failure.

**Implementation scope:** Add age/instruction and language/theme review operations
after deterministic checks. Use `Promise.allSettled`, immutable inputs, structured
verdicts, and explicit result aggregation.
Reuse the same local model for both prompts. Keep Ollama inference concurrency at
one: requests may queue even though both application operations have started.
Structured operation schemas retain an explicit refused branch; a refused review
cannot become a pass or trigger candidate revision.

**Acceptance criteria:**

- Both reviews start independently and neither sees the other's verdict.
- Document that concurrent promises do not guarantee GPU speedup; queue wait
  consumes attempt deadlines. Increase inference concurrency only after measurement.
- Invalid deterministic input skips semantic review.
- Successful feedback survives another review's failure.
- A required unavailable review blocks success and cannot be treated as content
  feedback or silently changed to a pass.

**Verification:** Use controlled promises to prove concurrency without wall-clock
thresholds; cover one rejection, both rejections, negative verdicts, and aborts.

**Out of scope:** Worker threads, queues, reviewer voting, and model-based schema validation.

Recorded: After a passed `content` check, `reviewAge` and `reviewLanguage` start
with the same request and candidate and neither user payload includes the other
verdict. `settleReviews` uses `Promise.allSettled`. Failed content skips both
reviews. A negative or schema-valid refused review is a failed named check
(`REVIEW_REFUSED` cannot become a pass). Operational review failures become
`unavailable` with the provider error code and keep the other review. README
documents that `OLLAMA_NUM_PARALLEL=1` means concurrent promises do not imply
GPU speedup and that queue wait consumes attempt timeouts. `npm test` (132),
`npm run typecheck`, `npx biome ci .`, `npm run build`, and
`docker compose config` pass without GPU, Ollama, or live inference.

### AG-010

**Title:** Introduce workflow state and bounded content revision  
**Stage:** 5  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-009](#ag-009)  
**Status:** Complete

**Problem and learning objective:** Understand explicit state, conditional
branches, and a finite correction loop.

**Implementation scope:** Add serializable generation state, candidate versions,
attempt history, a revision prompt with structured feedback, and terminal
`READY_FOR_REVIEW`/`FAILED` outcomes. The orchestrator alone owns state mutation.

**Acceptance criteria:**

- Allow one initial candidate plus at most two revisions.
- Each changed candidate receives fresh deterministic and semantic checks.
- Original requirements remain fixed; refusals and unavailable reviews do not
  trigger content revision.
- Identical invalid candidates and exhausted revisions stop explicitly.
- Output remains a proposal requiring human approval; no durable approval is implied.

**Verification:** Script first-pass success, correction success, malformed
generation, repeated invalid output, unavailable review, refusal, and exhaustion;
assert version and attempt counts.

**Out of scope:** Persistence, queues, publication, unlimited repair, and
transport backoff beyond the existing timeout behavior.

Recorded: `runContentWorkflow` owns a serializable `GenerationState`. One initial
candidate plus at most two `revision/v1` calls. Fresh `validateCandidate` and
reviews run on each changed candidate; the original request is passed through
unchanged. Schema-valid refusals and unavailable reviews do not revise. Repeated
identical invalid candidates return `422 IDENTICAL_INVALID_CANDIDATE`; exhausted
revisions return `422 CONTENT_VALIDATION_EXHAUSTED`. `READY_FOR_REVIEW` is `200`
with `requiresHumanApproval: true` and is not durable approval. `npm test` (139),
`npm run typecheck`, `npx biome ci .`, `npm run build`, and
`docker compose config` pass without GPU, Ollama, or live inference.

### AG-011

**Title:** Add explicit retries, deadlines, and execution budgets  
**Stage:** 5  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-010](#ag-010)  
**Status:** Complete

**Problem and learning objective:** Learn why transport retries, content revision,
and cancellation are separate mechanisms with separate limits.

**Implementation scope:** Add retry classification, jittered backoff, bounded
`Retry-After` handling, shared provider-call accounting, abort propagation, and
configurable `WORKFLOW_TIMEOUT_MS` (initially 600000, ten minutes). Use the smaller
of remaining workflow time and the configured 120000-ms attempt timeout; include
queue wait/loading and preserve chosen deadlines during recovery.

**Acceptance criteria:**

- At most two transport attempts occur per operation; every attempt consumes the
  overall 20-provider-request allowance.
- Temporary network, 429, and transient 5xx overload errors can retry; missing
  models, invalid settings, model load/OOM failures, and schema-valid refusals
  cannot. No auto-pull or cloud fallback; do not treat every 5xx as transient.
- A malformed reviewer response permits one bounded re-ask and otherwise fails.
- Transport retries never consume a new candidate version or reset revision limits.
- No attempt starts after the deadline or call budget is exhausted.

**Verification:** Use controllable clocks/delays and fake operations for backoff,
remaining-deadline checks, aborted calls, retry exhaustion, and cumulative budgets.

**Out of scope:** Distributed rate limiting, queues, durable resumption, and
claims that cancellation immediately stops all GPU computation.

Recorded: Transport retries (network/429/503, at most two attempts) are separate
from content revision and from one reviewer re-ask on malformed output. Chosen
`WORKFLOW_TIMEOUT_MS` (default 600000) and the 20-provider-request budget are
stored on the run; each attempt uses remaining workflow time together with
`LLM_ATTEMPT_TIMEOUT_MS`. Missing models, capacity/OOM, and schema-valid refusals
do not retry. Fake clocks cover backoff, deadline, abort, retry exhaustion, and
budget. `npm test` (156), `npm run typecheck`, `npx biome ci .`, `npm run build`,
and `docker compose config` pass without GPU, Ollama, or live inference.

### AG-029

**Title:** Milestone 1 review follow-up: security, failures, and verification

**Stage:** 5, Milestone 1 follow-up

**Repository:** `mova-lab-agents`

**Dependencies:** [AG-011](#ag-011)

**Status:** Complete

**Priority:** High; address P1 findings before relying on the milestone's guarantees.

**Problem and learning objective:** The happy path and existing tests pass, but
several failure paths violate deadline, logging, state, and evaluation guarantees.
Repair the existing boundaries and add focused regression coverage before building
durable execution on top of them. AG-029 preserves the existing ticket numbers.

**Review findings:** P1 means high priority, P2 normal priority, and P3 low priority.
Paths below are relative to the repository root; line numbers refer to the reviewed
implementation, before remediation.

1. **P1 — Provider error bodies bypass the response-size limit.**
   `src/llm/ollama.ts:200` uses `response.text()` before slicing to 4096 characters.
   Non-2xx responses therefore bypass the 1 MiB streaming limit used for successful
   responses. A fake provider streamed a complete 2 MiB error body and the adapter
   consumed it all, returning `MODEL_CAPACITY`. A large or continuously streaming
   failure can exhaust service memory before its timeout. Use bounded reading on
   error responses too, cancel the stream at the limit, and consume or cancel
   ignored non-2xx metadata bodies in `readRuntime`.

2. **P1 — An expired workflow can still become ready for review.**
   `src/llm/ollama.ts:135–155` swallows cancellation during optional metadata reads;
   `src/content/workflow.ts:163–170` accepts passed checks without checking the
   deadline again. With successful chat responses and stalled metadata during the
   final reviews, a 180 ms workflow returned `READY_FOR_REVIEW` after `deadlineAt`.
   Separately, a deadline during a review chat becomes an unavailable check and
   HTTP `200 FAILED`, through `settleReviews` and `present`, despite the documented
   `504 WORKFLOW_TIMEOUT` contract. Optional metadata failure may remain nonfatal,
   but overall cancellation must win over success and retain its public error code.

3. **P2 — Error-body cancellation loses its cause.**
   `src/llm/ollama.ts:200–210` catches every body-read error and returns an empty
   hint. A stalled `503` body exceeding its attempt deadline becomes retryable
   `PROVIDER_UNAVAILABLE`, instead of `PROVIDER_TIMEOUT`; a stalled `500` can be
   mislabeled `MODEL_CAPACITY`. Preserve timeout, workflow cancellation, and body
   transport errors instead of reclassifying them from the original HTTP status.

4. **P2 — Disconnected synchronous requests continue spending provider capacity.**
   `src/app.ts:46–55` does not propagate client disconnects to the workflow's
   private controller (`src/content/workflow.ts:106`). Disconnecting during
   vocabulary selection still allowed all four chat calls to run. Since this
   milestone has no durable acceptance or retrieval, the result is lost while
   queued work continues for up to ten minutes. Abort unfinished synchronous work
   on disconnect and propagate cancellation through backoff and provider reads;
   cover forced shutdown as well. This must prevent subsequent calls, without
   claiming immediate cancellation of computation already running on the GPU.

5. **P2 — Raw model content reaches ordinary logs.**
   `src/content/generate.ts:156–165` logs a clipped refusal reason. A schema-valid
   refusal containing a synthetic private teacher-text marker copied that marker
   into the default info log. Clipping is not redaction. Model-provided review
   codes also flow into `issueCodes` logs without an application allowlist
   (`src/content/review.ts:133`, `src/content/workflow.ts:204`). Remove raw refusal
   text from ordinary logs and treat arbitrary reviewer codes as untrusted text;
   log safe application classifications and counts. Test markers in both fields.

6. **P2 — Authentication runs after JSON parsing.**
   `src/app.ts:39–45` installs the JSON parser globally before service-token
   authentication. An unauthenticated malformed request to `/content-drafts`
   returns `400 MALFORMED_JSON`, showing it reached the parser. Unauthorized
   callers can occupy body-reading and decompression resources before rejection;
   the decoded-size limit does not eliminate that work. Put authentication before
   protected-route parsing, retain the 16 KiB limit, and keep health independent
   of request-body parsing. This is a resource-boundary issue, not a demonstrated
   bypass of the token check or access to generation.

7. **P2 — Transient HTTP failures are not classified consistently.**
   `src/llm/ollama.ts:176–189` makes plain `502` and `504` responses nonretryable
   and labels every `500` without an overload keyword as `MODEL_CAPACITY`.
   Fake responses with `temporary upstream failure` made one attempt for each
   status; the `500` incorrectly claimed a capacity problem. Retry recognized
   transient gateway/server failures within existing limits; keep explicit
   missing-model, invalid-setting, load, and OOM failures terminal. Do not require
   an English overload keyword to recognize an HTTP gateway failure.

8. **P2 — Operational failures bypass terminal workflow state and logging.**
   `src/content/workflow.ts:130–208` has a `finally` but no failure transition for
   exceptions from vocabulary, generation, or revision. A missing model throws
   out of `runContentWorkflow` and never emits `workflow finished`; accumulated
   history and counters are inaccessible to its caller. Vocabulary refusal also
   follows this path, unlike generation refusal. Record a sanitized terminal
   failure and final counters for all exits, preserving the intended HTTP status
   and distinguishing provider failure from content feedback.

9. **P2 — Candidate versions can refer to stale content and checks.**
   `src/content/workflow.ts:143–148` increments `candidateVersion` on malformed
   output while retaining the previous candidate and checks. One invalid initial
   candidate followed by two malformed revisions left version 3 paired with
   version 1's phrases and duplicate findings. Keep attempted-output history
   separate from the version of an actual candidate, or explicitly version the
   retained candidate/checks. Final state must identify which output was checked,
   including malformed revisions and terminal refusals.

10. **P2 — Usage and transport-attempt records are incomplete.**
    `src/content/workflow.ts:120` initializes `usage` but never populates it;
    `completeStructured` returns only parsed content. A successful four-call run
    with reported tokens returned `usage: []`. Also, `src/llm/complete.ts:38–79`
    allocates its attempt ID and start time outside the transport retry loop.
    A generation retry produced five provider calls but only four completed
    records, with no separate ID/timing for the failed transport attempt. Record
    each actual attempt and retain available usage in workflow state, including
    unsuccessful outputs; leave unavailable measurements null and avoid counting
    retries or cached tokens twice.

11. **P2 — Unusable vocabulary passes the upstream validation gate.**
    `src/content/generate.ts:147–152` checks only sound labels and coverage;
    `src/content/schemas.ts:66–69` accepts any nonempty word. Vocabulary containing
    `!!!` for р and `...` for л passed selection and reached generation/revision,
    but `src/content/validation.ts` tokenizes both items to empty arrays, so no
    candidate can satisfy vocabulary use. The reproduction wasted three calls
    before `IDENTICAL_INVALID_CANDIDATE`. Reject vocabulary unusable by the shared
    token matcher before generation. Exercise revisions cannot repair a fixed,
    invalid vocabulary selection.

12. **P2 — Smoke results can falsely report successful settings and no truncation.**
    `tests/smoke-local.ts:142–147,195–213` derives success from HTTP `response.ok`.
    A required review failure returns HTTP 200, and
    `tests/properties.ts:27–51` can mark every quality property passed for that
    `FAILED` result. The smoke command can therefore exit successfully without a
    ready candidate. Truncation detection also checks only the top-level error:
    truncation handled by a revision, or retained in an unavailable review, is
    missed. Validate result shape, workflow status, and required checks; distinguish
    eventual success from first-attempt capacity sufficiency, and retain observed
    truncations. Never report an unobserved truncation history as definitely false.

13. **P2 — Smoke-test I/O has no explicit deadline.**
    `tests/smoke-local.ts:43–46,74–93,195–200` calls `fetch` without an abort signal.
    The 15-second unload polling deadline is checked only between awaited requests,
    so a stalled fetch/body read defeats that bound. Bound health, metadata,
    unloading, and draft requests, including body reads, and report which stage
    timed out. Keep the longer generation allowance separate from metadata waits.

14. **P3 — Configuration accepts timeout values that overflow Node timers.**
    `src/config.ts:18–29` validates positive integers without timer bounds.
    `WORKFLOW_TIMEOUT_MS=2147483648` was accepted, but Node warned that the value
    overflowed and set the timer to 1 ms; a hanging provider immediately failed.
    Validate both timeout settings against the supported timer range at startup
    and test boundary values. A configured long timeout must not silently become
    an almost-immediate deadline.

**Implementation scope:** Resolve these findings in the existing HTTP, provider,
workflow, configuration, and smoke-test modules. Update README contracts where
needed and add regression cases to the existing offline harness. Keep this as one
follow-up ticket; do not introduce another workflow framework or persistence.

**Acceptance criteria:**

- Every finding above has a focused regression check and a fix, or an explicitly
  documented resolution supported by evidence.
- Expired/cancelled work cannot become ready or start another provider call;
  timeout codes remain accurate across metadata, error bodies, and semantic review.
- Provider bodies are bounded and cleaned up, authentication precedes protected
  body processing, and synthetic private-content markers never enter normal logs.
- Terminal state, candidate/check versions, attempt records, and reported usage
  remain consistent on successful and failed runs.
- Smoke reports distinguish HTTP success, workflow success, quality findings,
  revision-assisted recovery, and known versus unknown truncation history; all
  external waits have finite deadlines.
- Existing offline checks pass. Recheck the current workflow's maximum-size and
  revision prompts through the explicitly invoked local smoke procedure when
  hardware is available; retain historical single-call results as historical.

**Verification recorded during review (2026-09-09):** All 156 existing tests,
`npm run typecheck`, `npx --no-install biome ci .`, and `npm run build` passed.
Fourteen additional temporary checks against local fake HTTP servers reproduced
the deadline, oversized/stalled error-body, disconnect, refusal-log, retry,
state/accounting, invalid-vocabulary, smoke-classification, authentication-order,
and timer-overflow behaviors described above. These assert the current defects;
remediation must add permanent regression tests asserting corrected behavior.
`npm audit --json` reported zero known vulnerabilities across production and
development dependencies. No live inference, new GPU measurements, container
rebuild, or container-image vulnerability scan was performed in this review.

Recorded after remediation (2026-09-10): `npm test` (169), `npm run typecheck`,
`npx biome ci .`, and `npm run build` pass without GPU, Ollama, or live inference.
Docker CLI was unavailable in this WSL session, so `docker compose config` was
not re-run; `compose.yaml` is unchanged. Local smoke was not re-run; historical
single-call results in `evals/` remain historical.

**Out of scope:** Implementing Milestone 2, distributed rate limiting, publication,
clinical validation, automatic live inference, and treating a clean dependency
audit as proof that the service has no security issues.

## Milestone 2: tools and durable human approval

**Exit criteria:** A run survives restart, pauses for a human decision, and imports
the approved revision as unpublished drafts. Existing Content Studio publication
permissions remain authoritative.

### AG-012

**Title:** Add internal generation-constraint and search APIs in Mova-Lab  
**Stage:** 6  
**Repository:** `mova-lab` — companion backend work  
**Dependencies:** [AG-011](#ag-011)  
**Status:** Unstarted

**Problem and learning objective:** Learn an explicit service boundary that
provides authoritative application information without database access.

**Implementation scope:** Inspect current Content Studio contracts and add narrow,
service-authenticated internal endpoints for supported generation constraints,
category options, and bounded recording-exercise search. Reuse existing backend
services and document the new request/response contracts for AG-013.

**Acceptance criteria:**

- Returned constraints include their version and the authoritative supported limits.
- Search bounds, actor scope, and response fields are enforced server-side.
- Existing cookie/CSRF browser routes and content permissions remain intact.
- No database credentials or generic CMS access are given to the agent service.
- There is no vocabulary database or invented vocabulary-specific endpoint.

**Verification:** Run companion-repository contract and authorization tests for
valid service access, invalid credentials, forged scope, oversized queries, and
empty search results.

**Out of scope:** Content mutation, publication, semantic duplicate detection,
and importing the agent service into the Mova-Lab monorepo.

### AG-013

**Title:** Add validated Mova-Lab HTTP functions  
**Stage:** 6  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-012](#ag-012)  
**Status:** Unstarted

**Problem and learning objective:** Understand deterministic service calls before
letting a model request tools.

**Implementation scope:** Use native `fetch` for the documented internal read
contracts. Fix the base URL and routes in trusted configuration/code; validate
arguments and responses, bound results, and propagate cancellation.
Load required constraints deterministically before generation.

**Acceptance criteria:**

- Outbound authentication is separate from inbound authentication.
- Actor context cannot come from model-generated arguments.
- Required constraint failures stop the workflow rather than selecting a silent fallback.
- Search results are treated as data and never as instructions.
- Exact phrase matches can be identified, without interpreting no matches as
  proof of semantic uniqueness.

**Verification:** A local fake HTTP server checks URL construction, headers,
query limits, response validation, malformed payloads, timeout, and abort behavior.

**Out of scope:** Model-selected calls, arbitrary HTTP tools, direct database access,
and a universal API client framework.

### AG-014

**Title:** Introduce bounded model-selected tool calling  
**Stage:** 6  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-013](#ag-013)  
**Status:** Unstarted

**Problem and learning objective:** Build the first agent loop: the model chooses
an allowed action, observes its result, and chooses whether more work is needed.

**Implementation scope:** Expose read-only exercise search to vocabulary selection
using Ollama's native `tools`/`message.tool_calls` and a small dispatcher. Validate
argument objects, append the assistant tool-call message, then matching `tool`
messages with `tool_name` in call order. Preserve supplied identifiers/indexes
and use local audit IDs as needed; do not require an OpenAI-style `call_id`.
After tool selection finishes, make a separate schema-constrained final vocabulary
call without tools; reserve the last of the five allowed turns for it and count
it within the existing request budget.

**Acceptance criteria:**

- Only allowlisted tool names and schema-valid arguments execute.
- At most four tools and five model turns occur in vocabulary selection, within
  the overall workflow budget.
- Unknown tools, injected actor/URL arguments, and exhausted limits fail safely.
- Final vocabulary still passes runtime validation.
- Mutation, approval, publication, shell, filesystem, and generic HTTP tools are absent.
- An explicit local smoke procedure evaluates native tool selection and result
  handling with stub search data; generation quality alone does not prove tool
  reliability, and simultaneous tools-plus-format support is not assumed.

**Verification:** Script single/multiple tool calls, argument objects, result/name
ordering (including repeated tool names), absence of optional call IDs, malicious
retrieved text, tool errors, and exhaustion including the final vocabulary call.
Assert dispatcher decisions without live inference; run the local tool smoke
separately and record its results.

**Out of scope:** MCP, parallel tool execution, a supervisor, and automatic API discovery.

### AG-015

**Title:** Add SQLite workflow persistence and migrations  
**Stage:** 7  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-011](#ag-011)  
**Status:** Unstarted

**Problem and learning objective:** Understand transactions and the difference
between an execution artifact and authoritative application content.

**Implementation scope:** Add `better-sqlite3`, explicit SQL migrations, WAL,
foreign keys, bounded busy handling, and a durable Docker volume. Store runs,
step attempts, immutable candidate revisions, approval metadata, and import progress.
Write only workflow-specific persistence functions.

**Acceptance criteria:**

- Checkpoint output and its state transition commit atomically.
- Network/model work occurs outside database transactions.
- Stored values are serializable and include execution versions and consumed limits.
- Backup/restore is documented and works on a temporary database.
- The deployment contract specifies one host and local storage.

**Verification:** Use real temporary SQLite databases for migration, constraint,
transaction rollback, close/reopen, and backup/restore checks.

**Out of scope:** ORM, generic repositories, main-app database access, network
filesystems, multi-host deployment, and queue infrastructure.

### AG-016

**Title:** Add persisted workflow creation and retrieval  
**Stage:** 7  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-015](#ag-015), [AG-014](#ag-014)  
**Status:** Unstarted

**Problem and learning objective:** Turn a request-scoped operation into a durable
resource and learn creation idempotency.

**Implementation scope:** Add persisted creation and authorized retrieval endpoints.
Require a scoped idempotency key and normalized request hash. Save versions,
step outputs, candidate history, and check results while retaining synchronous
active execution. Add infrastructure readiness.

**Acceptance criteria:**

- Same actor/key/input returns the existing run; conflicting input returns `409`.
- Retrieval exposes safe workflow state and hides inaccessible runs.
- A completed generation reaches `AWAITING_APPROVAL`; execution failure is persisted.
- Creation returns the documented persisted-run representation.
- The old synchronous endpoint is marked development-only during caller migration.
- Readiness checks SQLite and local model availability via bounded metadata
  requests, without generation or model pulls; liveness stays independent.

**Verification:** Test duplicate and concurrent creation, conflicting hashes,
owner access, safe serialization, persisted failure, and reopening before retrieval.

**Out of scope:** Automatic background execution, human decisions, import,
queue retries, and in-memory substitutes for persistence.

### AG-017

**Title:** Implement claims and interrupted-run recovery  
**Stage:** 7  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-016](#ag-016)  
**Status:** Unstarted

**Problem and learning objective:** Learn leases, stale-writer protection, and
the limits of exactly-once execution after a crash.

**Implementation scope:** Add atomic claims, heartbeats, expiring leases,
claim-token-checked checkpoints, interrupted-run identification, and an authorized
resume endpoint. Resume only interrupted or explicitly retryable work under the
recorded workflow version and remaining limits.

**Acceptance criteria:**

- Concurrent claims produce a single current owner.
- Expired owners cannot save results after another owner claims the run.
- Resume skips committed successful work and preserves counters and generation deadline.
- Incompatible workflow versions or unavailable/changed recorded model digests
  fail explicitly instead of silently substituting code or weights.
- A missing checkpoint may cause a repeated LLM call; this limitation is documented.

**Verification:** Use two database connections and controlled time to exercise
claim races, heartbeat expiry, stale writes, restart after every checkpoint,
unsupported versions, and exhausted budgets.

**Out of scope:** Queue-driven resumption, budget resets, unrestricted terminal-run
restarts, and exactly-once LLM execution guarantees.

### AG-018

**Title:** Add idempotent unpublished-draft import in Mova-Lab  
**Stage:** 7  
**Repository:** `mova-lab` — companion backend/CMS work  
**Dependencies:** [AG-012](#ag-012), [AG-015](#ag-015)  
**Status:** Unstarted

**Problem and learning objective:** Understand why receiver-side idempotency must
cover content creation, not just the caller's record of a request.

**Implementation scope:** Add a narrow internal import API for recording drafts.
Validate current Content Admin authority, category, and application constraints.
Associate a unique source-import key and payload hash atomically with created
CMS content. Force unpublished draft status.

**Acceptance criteria:**

- Repeating an identical import returns the same content ID, including after a
  lost response or concurrent duplicate request.
- Reusing a key with different content fails without changing the prior draft.
- A lookup followed by unprotected creation is not considered sufficient.
- Current permissions and constraints are enforced; submitted publication controls
  cannot cause publication.
- Contract and durable source-key behavior are documented for the importer.

**Verification:** Exercise receiver concurrency, content-created/response-lost
recovery, payload conflict, invalid category, revoked permission, and attempted
publication using real persistence behavior.

**Out of scope:** General CMS administration, batch distributed transactions,
auto-publication, and agent access to the CMS database.

### AG-019

**Title:** Add durable approval and rejection  
**Stage:** 7  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-017](#ag-017)  
**Status:** Unstarted

**Problem and learning objective:** Build a human checkpoint that remains correct
under simultaneous requests, delayed review, and changing candidate versions.

**Implementation scope:** Add approve/reject endpoints and durable decision records.
Accept trusted Mova-Lab authorization context. Bind approval to an exact candidate
revision, real category, and immutable payload hash; record actor and timestamp.

**Acceptance criteria:**

- Only `AWAITING_APPROVAL` can accept a new decision.
- Same approval payload is repeatable; stale versions and conflicting decisions
  return `409`.
- Approval freezes the import payload; rejection terminates without an import.
- Concurrent approve/reject has one winner.
- No model call can approve, and a passed validator is not human approval.

**Verification:** Test simultaneous decisions, unauthorized context, repeated
approval, stale revisions, payload mutation, and persistence across restart.

**Out of scope:** Publication, editing approved content, a new user identity store,
and executing imports before AG-020.

### AG-020

**Title:** Import approved proposals and recover partial imports  
**Stage:** 7  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-018](#ag-018), [AG-019](#ag-019)  
**Status:** Unstarted

**Problem and learning objective:** Coordinate a local checkpoint and a remote
side effect without pretending they form one transaction.

**Implementation scope:** Implement a deterministic sequential importer for the
frozen approval payload. Use stable per-proposal import keys, store returned
content IDs as receipts, expose partial progress, and resume missing items only.

**Acceptance criteria:**

- Unapproved or changed payloads cannot import.
- `COMPLETED` requires confirmed receipts for all approved proposals.
- Lost responses and crashes after remote creation do not duplicate drafts.
- Partial failure retains imported unpublished drafts and confirmed receipts.
- Import recovery never calls generation or alters approved content.

**Verification:** Fake the API's documented idempotent behavior for orchestration
tests and run companion contract checks. Inject failure before request, after
creation, before local receipt, and between items.

**Out of scope:** Distributed rollback, automatic content repair after approval,
publication, and model-visible mutation tools.

### AG-021

**Title:** Add generation and review integration in Mova-Lab  
**Stage:** 7, product integration  
**Repository:** `mova-lab` — companion backend and client work  
**Dependencies:** [AG-020](#ag-020)  
**Status:** Unstarted

**Problem and learning objective:** Make the human checkpoint usable while keeping
the browser behind Mova-Lab's existing authentication and authorization boundary.

**Implementation scope:** Add a structured generation form and backend proxy,
review proposals and check findings, select a real category, approve or reject,
show import progress, and link confirmed drafts into Content Studio. Follow the
sibling app's existing Ukrainian UI conventions and permission rules.

**Acceptance criteria:**

- The browser never receives service credentials or calls the agent service directly.
- Teachers can request and inspect their permitted runs; only authorized Content
  Admins can approve imports.
- Generated strings render as text, and operational failures are distinguishable
  from content feedback.
- Imported content remains draft; editing and publication use existing Content Studio.

**Verification:** Run existing sibling checks plus focused UI/API integration tests
for owner access, Content Admin restrictions, successful import, rejection,
failure display, and safe text rendering.

**Out of scope:** A new design system, patient selection/data transfer, publication
automation, streaming, and WebSockets.

## Milestone 3: asynchronous execution

**Exit criteria:** HTTP connection lifetime no longer controls execution.
Accepted work is recoverable, and repeated delivery does not duplicate imports.

### AG-022

**Title:** Add Redis/BullMQ producer and worker entry points  
**Stage:** 8  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-020](#ag-020)  
**Status:** Unstarted

**Problem and learning objective:** Separate durable acceptance from execution
and learn producers, consumers, and acknowledgements.

**Implementation scope:** Add Redis/BullMQ, API and worker entry points in the same
image, run-ID-only jobs, asynchronous workflow submissions, and separate generation
and import jobs. Begin with one worker process and one active run, using the same
Ollama instance with one inference at a time. Increase run concurrency only after
measuring queue wait, memory, and latency.

**Acceptance criteria:**

- Mutation endpoints return `202` only after durable acceptance.
- Workers load and claim persisted runs; checkpoints commit before a job completes.
- `AWAITING_APPROVAL` completes its execution job and consumes no worker capacity.
- Approval schedules import; polling reads SQLite rather than queue payloads.
- Worker shutdown drains or interrupts work within a bounded period.

**Verification:** Use local Redis and temporary SQLite with fake model/API calls
to exercise submission, consumption, persisted status, approval pause, import
dispatch, and graceful shutdown.

**Out of scope:** Multiple hosts, BullMQ Flow graphs, separate service repositories,
queue payload copies of content, and exactly-once delivery.

### AG-023

**Title:** Add reconciliation and bounded redelivery  
**Stage:** 8  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-022](#ag-022)  
**Status:** Unstarted

**Problem and learning objective:** Close the persist-before-enqueue failure window
and understand why queue locks do not replace workflow idempotency.

**Implementation scope:** Reconcile runnable pending runs and expired claims,
schedule stable job identifiers, retain failed jobs, and persist a maximum of
three deliveries per execution phase. Document bounded operator re-drive and
Redis-outage behavior.

**Acceptance criteria:**

- A committed run missing its job is eventually scheduled.
- Duplicate messages and stale jobs cannot overwrite a newer checkpoint.
- Re-enqueueing does not reset delivery, provider-call, revision, or deadline limits.
- Exhausted execution becomes a visible persisted failure.
- Reconciliation skips human-review checkpoints and terminal runs.

**Verification:** Interrupt enqueueing before/after acknowledgement, duplicate jobs,
expire claims, delete/recreate queue jobs, exhaust attempts, and verify persisted
limits remain authoritative.

**Out of scope:** Transactional outbox, automatic unlimited re-drive, separate
dead-letter infrastructure, and distributed provider rate limiting.

### AG-024

**Title:** Verify worker recovery and update the integrated UI  
**Stage:** 8  
**Repositories:** `mova-lab-agents` and `mova-lab` — separate changes per repository  
**Dependencies:** [AG-021](#ag-021), [AG-023](#ag-023)  
**Status:** Unstarted

**Problem and learning objective:** Prove that accepted work is independent of
HTTP connections and make asynchronous states understandable to a teacher.

**Implementation scope:** Add subprocess/Redis-backed recovery tests and update
Mova-Lab's proxy/UI for `202`, polling, pending work, retryable interruption,
approval, import progress, and terminal failure. Remove the deployed legacy
synchronous endpoint after callers migrate.

**Acceptance criteria:**

- Killing workers around checkpoints does not lose committed work or duplicate imports.
- Redis interruption and acknowledgement loss recover through the documented policy.
- Disconnecting the browser does not cancel accepted work.
- Polling stops or changes appropriately at terminal and human-review checkpoints.
- The UI never represents queue acceptance as successful content generation.

**Verification:** Run a failure-injection integration suite with fake LLM calls,
then sibling UI/API tests for asynchronous responses, refresh/reopen, and failures.
Keep live model inference disabled.

**Out of scope:** WebSocket notifications, multi-host load testing, and broader
Teacher UI redesign.

## Milestone 4: dynamic orchestration and measurement

**Exit criteria:** Architecture changes can be assessed against repeatable
quality and operational measurements; the deterministic workflow remains the default.

### AG-025

**Title:** Add an experimental constrained supervisor  
**Stage:** 9  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-024](#ag-024)  
**Status:** Unstarted

**Problem and learning objective:** Compare code-selected steps with model-selected
actions while keeping business guarantees outside model control.

**Implementation scope:** Add a feature-flagged supervisor with the planned action
union, deterministic dispatcher, prerequisite validation, observations, and a
maximum of eight decisions. Record action history and enforce existing budgets.

**Acceptance criteria:**

- Search, vocabulary selection, generation, revision, and finish are the only actions.
- Missing prerequisites, unknown actions, and repeated ineffective actions stop safely.
- Finishing still invokes required checks and the human approval checkpoint.
- The supervisor cannot approve, publish, reset limits, or override failed checks.
- The deterministic path remains default; planner failure does not silently launch
  an additional full workflow.

**Verification:** Script action sequences for successful execution, invalid
arguments, premature finish, repeated actions, budget exhaustion, and attempted
approval bypass.
Separately evaluate the local model on bounded action sequences before enabling
real supervisor experiments; record unsupported or unreliable behavior explicitly.

**Out of scope:** Autonomous production rollout, unrestricted planning, graph
frameworks, and model-written executable code.

### AG-026

**Title:** Add distributed tracing and cost reporting  
**Stage:** 10  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-024](#ag-024)  
**Status:** Unstarted

**Problem and learning objective:** Understand how execution traces and usage
metadata explain slow, failed, and expensive runs across asynchronous boundaries.

**Implementation scope:** Extend existing metadata with OpenTelemetry spans and
links, queue-wait and step metrics, Ollama loading/generation timing, aggregate
usage reporting, and explicit opt-in diagnostic capture. Apply documented retention
and redaction to persisted artifacts and logs.

**Acceptance criteria:**

- HTTP, jobs, workflow steps, provider attempts, and imports can be correlated.
- Human approval links separate executions rather than leaving a span open indefinitely.
- Reported token categories are accounted for without double counting; absent usage
  or pricing stays unknown rather than zero.
- Local API calls have no per-token bill; unmeasured electricity/hardware cost
  stays `estimatedCostUsd: null` and is labeled as unmeasured. Defer price tables
  and billing reconciliation until a paid provider exists.
- Reports retain model digest/quantization, Ollama version, runtime settings, and
  hardware; cold/warm timing and duration units are explicit.
- Sensitive payload capture is off by default; retention preserves pending reviews
  and minimal idempotency tombstones as specified.

**Verification:** Use an in-memory trace exporter, known token/duration fixtures,
missing-data and null-cost cases, redaction probes, and controlled retention time.

**Out of scope:** Logging hidden model reasoning, billing guarantees, indefinite
raw-payload retention, and new monitoring microservices.

### AG-027

**Title:** Build the budgeted evaluation runner  
**Stage:** 10  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-006](#ag-006), [AG-011](#ag-011), [AG-026](#ag-026)  
**Status:** Unstarted

**Problem and learning objective:** Measure stochastic output quality separately
from deterministic program correctness.

**Implementation scope:** Expand the synthetic corpus to 20 cases, define expected
properties and a therapist rubric, retain a holdout subset, and build an explicit
runner with three repetitions per case, call/generated-token/elapsed-time limits,
and versioned reports. Reserve call/token allowances before concurrent submissions
and cap each request's output/timeout by the remaining budget;
stop if missing usage prevents establishing the remaining token allowance.

**Acceptance criteria:**

- Reports include per-case schema/content outcomes, target coverage, duplicates,
  revisions, failures, latency, usage, and cost.
- Comparisons use the same inputs and identify workflow/prompt/schema versions,
  model digest/quantization, Ollama version, hardware, context/output settings,
  and inference concurrency.
- Acceptable wording is assessed by properties/rubric rather than exact-string equality.
- Live local execution is opt-in and separate from ordinary CI; paid-provider
  support and a spend budget are deferred until a paid provider is introduced.
- The runner stops before initiating work beyond its configured budget; incomplete
  runs remain visible in reports.

**Verification:** Test report calculations and budget enforcement with deterministic
fake runs. Perform real local evaluation only through the documented explicit
command and record actual results without inventing missing samples.

**Out of scope:** Live inference in CI, production patient data, automatic model
promotion, and an uncalibrated LLM judge as the sole quality authority.

### AG-028

**Title:** Compare single-call, deterministic, and supervisor workflows  
**Stage:** 10, learning review  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-025](#ag-025), [AG-027](#ag-027)  
**Status:** Unstarted

**Problem and learning objective:** Determine whether additional orchestration
earns its complexity rather than assuming more agents improve results.

**Implementation scope:** Run the agreed evaluation protocol against recorded
single-call, deterministic, and supervisor versions. Collect therapist rubric
ratings, analyze failure classes and costs, and write a comparison with limits
and follow-up recommendations.

**Acceptance criteria:**

- Results distinguish initial success, revision-assisted success, refusal,
  operational failure, and human-rated usefulness.
- Quality, latency, token/cost, and action counts are compared on the same corpus.
- Holdout performance and missing/incomplete runs are reported.
- The supervisor remains experimental unless evidence supports a separate promotion decision.
- Findings identify what should be retained, simplified, or deferred.

**Verification:** Audit recorded versions and report arithmetic, reproduce a
subset with the evaluation runner, and document actual human review. Local model runs
are explicit; an offline dry run does not satisfy the real-quality comparison.

**Out of scope:** Automatic default changes, claims of clinical validation,
unrequested provider migration, and implementing every proposed follow-up.
