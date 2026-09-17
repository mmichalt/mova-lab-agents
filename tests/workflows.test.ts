import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { PROMPT_VERSIONS } from '../src/content/runs.ts';
import { LETTER_PRESENCE_ISSUE } from '../src/content/validation.ts';
import type { Clock } from '../src/llm/execution.ts';
import { createLogger } from '../src/logger.ts';
import {
  CONSTRAINTS_VERSION,
  hashNormalizedInput,
  openWorkflowStore,
  WORKFLOW_VERSION,
  type WorkflowStore,
} from '../src/persist/store.ts';
import { shutDown } from '../src/server.ts';
import { EXPECTED_CONSTRAINTS } from '../src/tools/mova-lab.ts';
import {
  chatCalls,
  fakeMovaLab,
  fakeOllama,
  instantClock,
  listen,
  type MovaLabCall,
  type OllamaReply,
  runtimeReply,
  scriptedChats,
  sequentialReply,
  teacherRequest,
  testEnv,
} from './drafts-harness.ts';
import { chatEnvelope, generatedContent, vocabularyContent } from './fixtures/ollama.ts';

const logger = createLogger('silent');

function tempStore(t: TestContext): WorkflowStore {
  const dir = mkdtempSync(path.join(tmpdir(), 'ag-016-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openWorkflowStore(path.join(dir, 'workflows.sqlite'));
  t.after(() => {
    try {
      store.close();
    } catch {
      // already closed
    }
  });
  return store;
}

async function startService(
  t: TestContext,
  options: {
    store?: WorkflowStore;
    reply?: Parameters<typeof fakeOllama>[1];
    movaLabReply?: Parameters<typeof fakeMovaLab>[1];
    ollamaUrl?: string;
    clock?: Clock;
  } = {},
) {
  const store = options.store ?? tempStore(t);
  const ollama =
    options.ollamaUrl === undefined
      ? await fakeOllama(t, options.reply ?? sequentialReply())
      : undefined;
  const movaLab = await fakeMovaLab(t, options.movaLabReply);
  const config = loadConfig(
    testEnv({
      OLLAMA_BASE_URL: options.ollamaUrl ?? ollama?.url ?? 'http://127.0.0.1:9',
      MOVA_LAB_BASE_URL: movaLab.url,
    }),
  );
  const { server, url } = await listen(
    createApp({ config, logger, store, clock: options.clock ?? instantClock() }),
  );
  t.after(() => shutDown(server, 50));
  return { store, url, ollama, movaLab, config };
}

test('resume reuses a committed vocabulary checkpoint and remaining limits', async (t) => {
  const store = tempStore(t);
  const run = store.createRun({
    ownerId: 'teacher-1',
    idempotencyKey: 'resume-1',
    normalizedInput: teacherRequest,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions: PROMPT_VERSIONS,
    modelTag: 'qwen3:4b-instruct',
    modelDigest: 'sha256:abc',
    limits: {
      maxProviderRequests: 20,
      maxRevisions: 2,
      workflowTimeoutMs: 600_000,
      attemptTimeoutMs: 120_000,
      deadlineAt: 100_000,
      ollamaNumCtx: 4096,
      ollamaNumPredict: 2000,
    },
    now: 1_000,
  });
  const token = store.claimRun({
    runId: run.id,
    owner: 'crashed-worker',
    now: 1_000,
    leaseMs: 100,
  });
  assert.ok(token);
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: {
      request: teacherRequest,
      phase: 'generation',
      status: 'RUNNING',
      candidateVersion: 0,
      revisionCount: 0,
      constraintsVersion: CONSTRAINTS_VERSION,
      vocabulary: JSON.parse(vocabularyContent),
      candidate: null,
      checks: [],
      history: [],
      usage: [],
      error: null,
      providerRequests: 1,
      modelTag: 'qwen3:4b-instruct',
      modelDigest: 'sha256:abc',
    },
    now: 1_050,
    claimToken: token,
    modelTag: 'qwen3:4b-instruct',
    modelDigest: 'sha256:abc',
  });
  const ollama = await fakeOllama(t, sequentialReply());
  const { url } = await startService(t, {
    store,
    ollamaUrl: ollama.url,
    clock: instantClock({ now: () => 2_000 }),
  });
  const response = await fetch(`${url}/workflows/${run.id}/resume`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'AWAITING_APPROVAL');
  assert.equal(body.consumed.providerRequests, 4);
  assert.equal(chatCalls(ollama.calls).length, 3);
  assert.equal(store.getRun(run.id)?.leaseToken, null);
});

test('resume preserves limits for an unstarted pending run', async (t) => {
  const store = tempStore(t);
  const run = store.createRun({
    ownerId: 'teacher-1',
    idempotencyKey: 'pending-resume-1',
    normalizedInput: teacherRequest,
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions: PROMPT_VERSIONS,
    modelTag: 'qwen3:4b-instruct',
    modelDigest: null,
    limits: {
      maxProviderRequests: 20,
      maxRevisions: 2,
      workflowTimeoutMs: 600_000,
      attemptTimeoutMs: 120_000,
      deadlineAt: 1_500,
      ollamaNumCtx: 4096,
      ollamaNumPredict: 2000,
    },
    now: 1_000,
  });
  const ollama = await fakeOllama(t, sequentialReply());
  const { url } = await startService(t, {
    store,
    ollamaUrl: ollama.url,
    clock: instantClock({ now: () => 2_000 }),
  });

  const response = await fetch(`${url}/workflows/${run.id}/resume`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.result.error.code, 'WORKFLOW_TIMEOUT');
  assert.equal(chatCalls(ollama.calls).length, 0);
});

function headers(actor = 'teacher-1', key = 'key-1') {
  return {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'x-actor-id': actor,
    'idempotency-key': key,
  };
}

async function createRun(
  url: string,
  options: { actor?: string; key?: string; body?: unknown } = {},
) {
  return fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(options.actor, options.key),
    body: JSON.stringify(options.body ?? teacherRequest),
  });
}

function assertSafe(body: Record<string, unknown>) {
  assert.equal('leaseToken' in body, false);
  assert.equal('leaseOwner' in body, false);
  assert.equal('leaseExpiresAt' in body, false);
  assert.equal(JSON.stringify(body).includes('test-token'), false);
}

function adminHeaders(actor = 'admin-1') {
  return {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'x-actor-id': actor,
    'x-content-admin': 'true',
  };
}

function categoriesReply(call: MovaLabCall): OllamaReply | undefined {
  return call.url === '/api/internal/content-generation/categories'
    ? {
        status: 200,
        json: {
          version: CONSTRAINTS_VERSION,
          items: [{ id: 'cat-1', name: 'Артикуляція' }],
        },
      }
    : undefined;
}

function categoryReply(call: MovaLabCall): OllamaReply {
  if (call.method === 'POST' && call.url === '/api/internal/content-generation/recording-drafts') {
    return { status: 200, json: { id: 'draft-1' } };
  }
  return categoriesReply(call) ?? { status: 200, json: EXPECTED_CONSTRAINTS };
}

test('POST /content-drafts stays available and is marked development-only', async (t) => {
  const { url } = await startService(t);
  const response = await fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('deprecation'), 'true');
  assert.equal((await response.json()).status, 'READY_FOR_REVIEW');
});

test('creating a persisted run reaches AWAITING_APPROVAL and is retrievable', async (t) => {
  const { url, store } = await startService(t);
  const response = await createRun(url);
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, 'AWAITING_APPROVAL');
  assert.equal(body.phase, 'finished');
  assert.equal(body.result.requiresHumanApproval, true);
  assert.equal(body.result.candidateVersion, 1);
  assert.equal(body.result.proposals[0].localId, 'proposal-1');
  assert.deepEqual(body.result.checks[0].issues, [LETTER_PRESENCE_ISSUE]);
  assert.equal(body.candidates.length, 1);
  assert.equal(body.modelTag, 'qwen3:4b-instruct');
  assert.equal(body.modelDigest, 'sha256:abc');
  assertSafe(body);

  const fetched = await fetch(`${url}/workflows/${body.id}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal(fetched.status, 200);
  const again = await fetched.json();
  assert.equal(again.id, body.id);
  assert.equal(again.status, 'AWAITING_APPROVAL');
  assert.equal(store.getRun(body.id)?.status, 'AWAITING_APPROVAL');
});

test('Content Admin approval freezes the exact candidate and survives retrieval', async (t) => {
  const { url, ollama, movaLab } = await startService(t, {
    movaLabReply: categoryReply,
  });
  const created = await (await createRun(url)).json();
  const response = await fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const frozenPayload = {
    candidateVersion: 1,
    categoryId: 'cat-1',
    proposals: created.result.proposals,
  };
  assert.equal(body.status, 'COMPLETED');
  assert.equal(body.phase, 'import');
  assert.equal(body.resumable, false);
  assert.equal(body.importProgress.status, 'completed');
  assert.equal(body.importProgress.imported, body.importProgress.total);
  assert.deepEqual(body.approval.frozenPayload, frozenPayload);
  assert.equal(body.approval.actorId, 'admin-1');
  assert.equal(body.approval.payloadHash, hashNormalizedInput(frozenPayload));
  assert.equal(chatCalls(ollama?.calls ?? []).length, 5);
  assert.equal(movaLab.calls.filter((call) => call.url.endsWith('/categories')).length, 1);

  const fetched = await fetch(`${url}/workflows/${created.id}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal((await fetched.json()).approval.payloadHash, body.approval.payloadHash);
});

test('partial draft imports keep receipts and resume missing proposals without generation', async (t) => {
  const createdDrafts = new Map<string, string>();
  const attempts = new Map<string, number>();
  const { url, ollama, movaLab } = await startService(t, {
    movaLabReply: (call) => {
      if (call.url === '/api/internal/content-generation/categories') {
        return categoriesReply(call) as OllamaReply;
      }
      if (call.url === '/api/internal/content-generation/recording-drafts') {
        const body = call.body as { sourceImportKey: string };
        const key = body.sourceImportKey;
        const attempt = (attempts.get(key) ?? 0) + 1;
        attempts.set(key, attempt);
        const id = createdDrafts.get(key) ?? `draft-${createdDrafts.size + 1}`;
        createdDrafts.set(key, id);
        return attempt === 1 && key.endsWith('proposal-2')
          ? { status: 200, raw: '{}' }
          : { status: 200, json: { id } };
      }
      return { status: 200, json: EXPECTED_CONSTRAINTS };
    },
  });
  const created = await (await createRun(url)).json();
  const approval = await fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  });
  const failed = await approval.json();
  assert.equal(approval.status, 200);
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.resumable, true);
  assert.equal(failed.importProgress.total, 2);
  assert.equal(failed.importProgress.imported, 1);
  assert.equal(failed.importProgress.receipts[1].status, 'failed');
  assert.equal(failed.result.error.code, 'MOVA_LAB_INVALID_RESPONSE');

  const resumed = await fetch(`${url}/workflows/${created.id}/resume`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  const completed = await resumed.json();
  assert.equal(resumed.status, 200);
  assert.equal(completed.status, 'COMPLETED');
  assert.equal(completed.importProgress.imported, 2);
  assert.equal(chatCalls(ollama?.calls ?? []).length, 5);
  assert.equal(attempts.get(`${created.id}:proposal-1`), 1);
  assert.equal(attempts.get(`${created.id}:proposal-2`), 2);
  assert.equal(
    movaLab.calls.filter((call) => call.url === '/api/internal/content-generation/recording-drafts')
      .length,
    3,
  );
});

test('rejection is durable, idempotent, and cannot be replaced by approval', async (t) => {
  const { url, movaLab } = await startService(t, {
    movaLabReply: categoryReply,
  });
  const created = await (await createRun(url)).json();
  const rejected = await fetch(`${url}/workflows/${created.id}/reject`, {
    method: 'POST',
    headers: adminHeaders('admin-2'),
    body: JSON.stringify({ candidateVersion: created.result.candidateVersion }),
  });
  assert.equal(rejected.status, 200);
  const body = await rejected.json();
  assert.equal(body.status, 'REJECTED');
  assert.equal(body.approval.decision, 'rejected');
  assert.equal(body.approval.categoryId, null);
  assert.equal(body.approval.frozenPayload, null);
  assert.equal(movaLab.calls.filter((call) => call.url.endsWith('/categories')).length, 0);

  const repeated = await fetch(`${url}/workflows/${created.id}/reject`, {
    method: 'POST',
    headers: adminHeaders('admin-3'),
    body: JSON.stringify({ candidateVersion: created.result.candidateVersion }),
  });
  assert.equal(repeated.status, 200);
  assert.equal((await repeated.json()).approval.actorId, 'admin-2');

  const conflicting = await fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({
      candidateVersion: created.result.candidateVersion,
      categoryId: 'cat-1',
    }),
  });
  assert.equal(conflicting.status, 409);
});

test('approval requires trusted Content Admin context and an exact current revision', async (t) => {
  const { url, movaLab, store } = await startService(t, {
    movaLabReply: categoryReply,
  });
  const created = await (await createRun(url)).json();
  const unauthorized = await fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'x-actor-id': 'teacher-1',
    },
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  });
  assert.equal(unauthorized.status, 403);
  assert.equal(store.getApproval(created.id), undefined);

  const stale = await fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: adminHeaders(),
    body: JSON.stringify({ candidateVersion: 2, categoryId: 'cat-1' }),
  });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).error.code, 'STALE_CANDIDATE');
  assert.equal(movaLab.calls.filter((call) => call.url.endsWith('/categories')).length, 0);
});

test('simultaneous approve and reject have one durable winner', async (t) => {
  const { url, store } = await startService(t, {
    movaLabReply: categoryReply,
  });
  const created = await (await createRun(url)).json();
  const approve = fetch(`${url}/workflows/${created.id}/approve`, {
    method: 'POST',
    headers: adminHeaders('admin-approve'),
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  });
  const reject = fetch(`${url}/workflows/${created.id}/reject`, {
    method: 'POST',
    headers: adminHeaders('admin-reject'),
    body: JSON.stringify({ candidateVersion: 1 }),
  });
  const responses = await Promise.all([approve, reject]);
  assert.deepEqual(
    responses.map((response) => response.status).sort((a, b) => a - b),
    [200, 409],
  );
  assert.ok(store.getApproval(created.id));
  assert.notEqual(store.getRun(created.id)?.status, 'AWAITING_APPROVAL');
});

test('same actor, key, and input return the existing run without executing again', async (t) => {
  const { url, ollama } = await startService(t);
  const first = await createRun(url);
  assert.equal(first.status, 201);
  const created = await first.json();
  const chats = chatCalls(ollama?.calls ?? []).length;
  const second = await createRun(url);
  assert.equal(second.status, 200);
  const replayed = await second.json();
  assert.equal(replayed.id, created.id);
  assert.equal(replayed.status, 'AWAITING_APPROVAL');
  assert.equal(chatCalls(ollama?.calls ?? []).length, chats);
});

test('concurrent duplicate creates share one run and one execution', async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scripted = sequentialReply();
  let held = false;
  const ollama = await fakeOllama(t, (call) => {
    const reply = scripted(call);
    if (
      !held &&
      call.method === 'POST' &&
      call.url === '/api/chat' &&
      'status' in reply &&
      !('hang' in reply)
    ) {
      held = true;
      return { ...reply, wait: gate };
    }
    return reply;
  });
  const { url } = await startService(t, { ollamaUrl: ollama.url });
  const first = createRun(url, { key: 'same' });
  const second = createRun(url, { key: 'same' });
  const faster = await Promise.race([first, second]);
  assert.equal(faster.status, 200);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  const bodies = [await a.json(), await b.json()];
  assert.equal(bodies[0].id, bodies[1].id);
  assert.equal(chatCalls(ollama.calls).length, 5);
});

test('reusing a key with a different request returns 409 and keeps the original run', async (t) => {
  const { url } = await startService(t);
  const first = await createRun(url);
  const created = await first.json();
  const conflict = await createRun(url, {
    body: { ...teacherRequest, theme: 'їжа' },
  });
  assert.equal(conflict.status, 409);
  const error = await conflict.json();
  assert.equal(error.error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(error.error.workflowId, created.id);
  const fetched = await fetch(`${url}/workflows/${created.id}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal((await fetched.json()).request.theme, teacherRequest.theme);
});

test('retrieval hides inaccessible runs and omits lease fields', async (t) => {
  const { url } = await startService(t);
  const created = await (await createRun(url)).json();
  const missing = await fetch(`${url}/workflows/${created.id}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-2' },
  });
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, 'NOT_FOUND');
  const unknown = await fetch(`${url}/workflows/${crypto.randomUUID()}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal(unknown.status, 404);
  const unauthenticated = await fetch(`${url}/workflows/${created.id}`, {
    headers: { 'x-actor-id': 'teacher-1' },
  });
  assert.equal(unauthenticated.status, 401);
});

test('execution failure is persisted and survives reopening the store', async (t) => {
  const ollama = await fakeOllama(t, (call) =>
    call.method === 'POST' && call.url === '/api/chat'
      ? { status: 404, json: { error: 'model not found' } }
      : runtimeReply({})(call),
  );
  const store = tempStore(t);
  const { url } = await startService(t, { store, ollamaUrl: ollama.url });
  const response = await createRun(url, { key: 'failed' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.result.requiresHumanApproval, false);
  assert.equal(body.result.error.code, 'MODEL_UNAVAILABLE');
  const sqlitePath = store.path;
  store.close();
  const reopened = openWorkflowStore(sqlitePath);
  t.after(() => reopened.close());
  const { url: again } = await startService(t, { store: reopened, ollamaUrl: ollama.url });
  const fetched = await fetch(`${again}/workflows/${body.id}`, {
    headers: { authorization: 'Bearer test-token', 'x-actor-id': 'teacher-1' },
  });
  assert.equal(fetched.status, 200);
  const persisted = await fetched.json();
  assert.equal(persisted.status, 'FAILED');
  assert.equal(persisted.result.error.code, 'MODEL_UNAVAILABLE');
  assertSafe(persisted);
});

test('create requires actor and idempotency headers and does not persist invalid input', async (t) => {
  const { url, store } = await startService(t);
  const missingKey = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'x-actor-id': 'teacher-1',
    },
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(missingKey.status, 400);
  const missingActor = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-token',
      'content-type': 'application/json',
      'idempotency-key': 'key-1',
    },
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(missingActor.status, 400);
  const invalid = await createRun(url, { body: { theme: 'тварини' } });
  assert.equal(invalid.status, 400);
  assert.equal(store.getRunByIdempotency('teacher-1', 'key-1'), undefined);
});

test('a failed candidate checkpoint is retried on the terminal write', async (t) => {
  const store = tempStore(t);
  const save = store.saveCheckpoint.bind(store);
  let rejected = false;
  store.saveCheckpoint = (input) => {
    if (input.candidate && !rejected) {
      rejected = true;
      throw new Error('checkpoint busy');
    }
    return save(input);
  };
  const duplicate = JSON.parse(generatedContent) as {
    proposals: Array<Record<string, unknown>>;
  };
  duplicate.proposals[1] = { ...duplicate.proposals[1], phrase: duplicate.proposals[0]?.phrase };
  const { url } = await startService(t, {
    store,
    reply: scriptedChats({
      generation: {
        status: 200,
        json: chatEnvelope({
          message: { role: 'assistant', content: JSON.stringify(duplicate) },
        }),
      },
    }),
  });
  const response = await createRun(url, { key: 'checkpoint-retry' });
  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.result.candidateVersion, 1);
  assert.equal(body.result.proposals.length, 2);
  assert.equal(body.candidates.length, 1);
  assert.equal(body.candidates[0].candidateVersion, 1);
});

test('GET /ready checks sqlite and model tags without generation; /health stays independent', async (t) => {
  const { url, ollama } = await startService(t);
  const ready = await fetch(`${url}/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: 'ok', sqlite: 'ok', model: 'ok' });
  assert.deepEqual(
    ollama?.calls.map((call) => `${call.method} ${call.url}`),
    ['GET /api/tags'],
  );

  const health = await fetch(`${url}/health`);
  assert.equal(health.status, 200);

  const hangingTags = await fakeOllama(t, (call) =>
    call.method === 'GET' && call.url === '/api/tags'
      ? { hang: true as const }
      : { status: 200, json: {} },
  );
  const hangReady = await startService(t, {
    store: tempStore(t),
    ollamaUrl: hangingTags.url,
  });
  const started = Date.now();
  const timed = await fetch(`${hangReady.url}/ready`);
  assert.equal(timed.status, 503);
  assert.ok(Date.now() - started < 3000);
  assert.equal((await timed.json()).model, 'unavailable');

  const down = await listen(createApp({ config: loadConfig(testEnv()), logger }));
  t.after(() => shutDown(down.server, 50));
  const liveness = await fetch(`${down.url}/health`);
  assert.equal(liveness.status, 200);
  const unreadiness = await fetch(`${down.url}/ready`);
  assert.equal(unreadiness.status, 503);
  const report = await unreadiness.json();
  assert.equal(report.status, 'not_ready');
  assert.equal(report.sqlite, 'unavailable');
});
