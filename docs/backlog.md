# Mova-Lab Agents implementation backlog

**Status:** All 28 tickets are unstarted. This backlog describes future work;
the service has not been implemented.

Read the [architecture and learning plan](architecture-plan.md) for the complete
design and rationale. Start with AG-001 and follow dependencies. Ticket numbers
are stable identifiers, not issue numbers from an external tracker.

## Working agreement

- Each ticket should leave a runnable increment or a focused, verifiable contract.
- Follow existing repository instructions in whichever repository a ticket targets.
- Update the relevant explanation and verification commands as behavior is implemented.
- Use explicit TypeScript functions and small modules. Add no generic repositories,
  dependency-injection containers, abstract agent classes, or orchestration frameworks.
- Ordinary automated verification must not call a paid LLM API.
- Paid smoke tests and evaluations are separate, explicitly invoked activities.
- Keep publication outside this service and outside all model-visible tools.
- Mark a ticket complete only after its acceptance criteria and verification pass.
- Suggested commit titles appear in the architecture plan. A ticket may need more
  than one commit; do not combine unrelated tickets merely to reduce commit count.

## Ticket index

### Milestone 1 — Standalone generator

- [ ] [AG-001 — Bootstrap TypeScript and Express](#ag-001)
- [ ] [AG-002 — Configuration, authentication, logging, and lifecycle](#ag-002)
- [ ] [AG-003 — Docker support and CI](#ag-003)
- [ ] [AG-004 — Recording-proposal contracts](#ag-004)
- [ ] [AG-005 — One structured LLM generation operation](#ag-005)
- [ ] [AG-006 — Provider tests and baseline examples](#ag-006)
- [ ] [AG-007 — Sequential vocabulary and exercise generation](#ag-007)
- [ ] [AG-008 — Deterministic content validation](#ag-008)
- [ ] [AG-009 — Concurrent semantic reviews](#ag-009)
- [ ] [AG-010 — Workflow state and bounded content revision](#ag-010)
- [ ] [AG-011 — Retries, deadlines, and execution budgets](#ag-011)

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
**Status:** Unstarted

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
**Status:** Unstarted

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
**Status:** Unstarted

**Problem and learning objective:** Make the service reproducible outside the
development shell and understand build-time versus runtime dependencies.

**Implementation scope:** Add a multi-stage Debian-slim Dockerfile, non-root runtime,
production-only dependencies, Docker ignore rules, environment documentation,
and CI for offline tests, type-checking, and production build.

**Acceptance criteria:**

- The image builds from the committed lockfile and serves health.
- Runtime runs as non-root and does not contain the local `.env`.
- CI succeeds without an LLM API key.
- README explains local and Docker startup and the expected environment variables.

**Verification:** Build and run the image, inspect its runtime user, request health,
and execute the CI commands locally.

**Out of scope:** Deployment, Kubernetes, database containers, Redis, and changes
to Mova-Lab deployment.

### AG-004

**Title:** Define recording-proposal request and output contracts  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-002](#ag-002)  
**Status:** Unstarted

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

**Out of scope:** Paid generation, new exercise types, phonetic transcription,
application categories, and patient data.

### AG-005

**Title:** Implement one structured LLM generation operation  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-004](#ag-004)  
**Status:** Unstarted

**Problem and learning objective:** Observe exactly what messages and parameters
are sent to a model and how its response becomes trusted application data.

**Implementation scope:** Add OpenAI's SDK and `POST /content-drafts`. Use the
planned model baseline, versioned prompts, strict structured output, local
validation, a 30-second attempt timeout, `store: false`, and disabled SDK retries.
Capture model, provider request ID, prompt version, timing, and reported usage.

**Acceptance criteria:**

- Valid requests produce proposals with `requiresHumanApproval: true`.
- System instructions and teacher task data are visibly separate.
- Refusals, incomplete output, invalid JSON, and schema failures have explicit
  safe outcomes; there is no permissive text-repair parser.
- Only the provider module depends on provider response types.

**Verification:** Use a fake transport for a successful response and malformed or
refused response; confirm invalid user input makes no provider call.

**Out of scope:** Provider switching, streaming, decomposition, automatic retries,
revision, persistence, and approval endpoints.

### AG-006

**Title:** Test the provider boundary and establish baseline examples  
**Stage:** 2  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-005](#ag-005)  
**Status:** Unstarted

**Problem and learning objective:** Distinguish testing the integration protocol
from evaluating whether generated content is useful.

**Implementation scope:** Add synthetic Responses API fixtures and fake SDK
HTTP transport coverage. Seed a small synthetic request corpus, prompt/model
version metadata, and a documented optional paid smoke-test procedure.

**Acceptance criteria:**

- Tests inspect messages and schema settings and cover valid output, wrong shape,
  invalid JSON, refusal, truncation, timeout, credentials failure, and usage parsing.
- Normal tests work without credentials and do not contact the real provider.
- Initial examples cover Р, Л, and both; expected qualities are properties rather
  than exact generated strings.
- The single-call baseline remains reproducible through recorded versions.

**Verification:** Run the suite with provider credentials absent and inspect
transport-call assertions. The separately documented real API smoke test is
optional and explicitly paid.

**Out of scope:** Full evaluation runner, model leaderboard, and fabricated
live-provider results.

### AG-007

**Title:** Split generation into vocabulary and exercise steps  
**Stage:** 3  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-006](#ag-006)  
**Status:** Unstarted

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

### AG-008

**Title:** Add deterministic content validation  
**Stage:** 3  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-007](#ag-007)  
**Status:** Unstarted

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

### AG-009

**Title:** Add concurrent age and language reviews  
**Stage:** 4  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-008](#ag-008)  
**Status:** Unstarted

**Problem and learning objective:** Learn independent I/O concurrency, fan-out/fan-in,
and the difference between negative feedback and operational failure.

**Implementation scope:** Add age/instruction and language/theme review operations
after deterministic checks. Use `Promise.allSettled`, immutable inputs, structured
verdicts, and explicit result aggregation.

**Acceptance criteria:**

- Both reviews start independently and neither sees the other's verdict.
- Invalid deterministic input skips semantic review.
- Successful feedback survives another review's failure.
- A required unavailable review blocks success and cannot be treated as content
  feedback or silently changed to a pass.

**Verification:** Use controlled promises to prove concurrency without wall-clock
thresholds; cover one rejection, both rejections, negative verdicts, and aborts.

**Out of scope:** Worker threads, queues, reviewer voting, and model-based schema validation.

### AG-010

**Title:** Introduce workflow state and bounded content revision  
**Stage:** 5  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-009](#ag-009)  
**Status:** Unstarted

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

### AG-011

**Title:** Add explicit retries, deadlines, and execution budgets  
**Stage:** 5  
**Repository:** `mova-lab-agents`  
**Dependencies:** [AG-010](#ag-010)  
**Status:** Unstarted

**Problem and learning objective:** Learn why transport retries, content revision,
and cancellation are separate mechanisms with separate limits.

**Implementation scope:** Add retry classification, jittered backoff, bounded
`Retry-After` handling, shared provider-call accounting, abort propagation, and
the 180-second generation deadline. Keep SDK retries disabled.

**Acceptance criteria:**

- At most two transport attempts occur per operation; every attempt consumes the
  overall 20-provider-request allowance.
- Temporary network, 429, and 5xx errors can retry; credentials/configuration
  failures and refusals cannot.
- A malformed reviewer response permits one bounded re-ask and otherwise fails.
- Transport retries never consume a new candidate version or reset revision limits.
- No attempt starts after the deadline or call budget is exhausted.

**Verification:** Use controllable clocks/delays and fake operations for backoff,
remaining-deadline checks, aborted calls, retry exhaustion, and cumulative budgets.

**Out of scope:** Distributed rate limiting, queues, durable resumption, and
claims of zero billing after cancellation.

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
using explicit function-call definitions and a small dispatcher. Preserve tool-call
identifiers and return validated observations to the model.

**Acceptance criteria:**

- Only allowlisted tool names and schema-valid arguments execute.
- At most four tools and five model turns occur in vocabulary selection, within
  the overall workflow budget.
- Unknown tools, injected actor/URL arguments, and exhausted limits fail safely.
- Final vocabulary still passes runtime validation.
- Mutation, approval, publication, shell, filesystem, and generic HTTP tools are absent.

**Verification:** Script tool-call sequences, malformed arguments, mismatched or
missing call identifiers, malicious retrieved text, tool errors, and exhaustion.
Assert actual dispatcher decisions without paid API access.

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
- Incompatible workflow versions fail explicitly.
- A missing checkpoint may cause a repeated LLM call; this limitation is documented.

**Verification:** Use two database connections and controlled time to exercise
claim races, heartbeat expiry, stale writes, restart after every checkpoint,
unsupported versions, and exhausted budgets.

**Out of scope:** Queue-driven resumption, budget resets, unrestricted terminal-run
restarts, and exactly-once provider billing guarantees.

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
and import jobs. Begin with one worker process and two concurrent runs.

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
Keep external paid APIs disabled.

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
links, queue-wait and step metrics, a versioned model-price table, aggregate
reporting, and explicit opt-in diagnostic capture. Apply documented retention
and redaction to persisted artifacts and logs.

**Acceptance criteria:**

- HTTP, jobs, workflow steps, provider attempts, and imports can be correlated.
- Human approval links separate executions rather than leaving a span open indefinitely.
- Reported token categories are accounted for without double counting; absent usage
  or pricing stays unknown rather than zero.
- Cost estimates retain price/model versions and identify incomplete accounting.
- Sensitive payload capture is off by default; retention preserves pending reviews
  and minimal idempotency tombstones as specified.

**Verification:** Use an in-memory trace exporter, known usage/price fixtures,
missing-data cases, redaction probes, and retention tests with controlled time.

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
runner with three repetitions per case, call/spend limits, and versioned reports.

**Acceptance criteria:**

- Reports include per-case schema/content outcomes, target coverage, duplicates,
  revisions, failures, latency, usage, and cost.
- Comparisons use the same inputs and identify workflow, prompt, schema, and model versions.
- Acceptable wording is assessed by properties/rubric rather than exact-string equality.
- Paid execution is opt-in and separate from ordinary CI.
- The runner stops before initiating work beyond its configured budget; incomplete
  runs remain visible in reports.

**Verification:** Test report calculations and budget enforcement with deterministic
fake runs. Perform real paid evaluation only through the documented explicit
command and record actual results without inventing missing samples.

**Out of scope:** Continuous paid CI, production patient data, automatic model
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
subset with the evaluation runner, and document actual human review. Paid runs
are explicit; an offline dry run does not satisfy the real-quality comparison.

**Out of scope:** Automatic default changes, claims of clinical validation,
unrequested provider migration, and implementing every proposed follow-up.
