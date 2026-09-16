import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { LETTER_PRESENCE_ISSUE } from '../src/content/validation.ts';
import { createLogger } from '../src/logger.ts';
import { openWorkflowStore, type WorkflowStore } from '../src/persist/store.ts';
import { shutDown } from '../src/server.ts';
import {
  chatCalls,
  fakeMovaLab,
  fakeOllama,
  instantClock,
  listen,
  runtimeReply,
  scriptedChats,
  sequentialReply,
  teacherRequest,
  testEnv,
} from './drafts-harness.ts';
import { chatEnvelope, generatedContent } from './fixtures/ollama.ts';

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
    ollamaUrl?: string;
  } = {},
) {
  const store = options.store ?? tempStore(t);
  const ollama =
    options.ollamaUrl === undefined
      ? await fakeOllama(t, options.reply ?? sequentialReply())
      : undefined;
  const movaLab = await fakeMovaLab(t);
  const config = loadConfig(
    testEnv({
      OLLAMA_BASE_URL: options.ollamaUrl ?? ollama?.url ?? 'http://127.0.0.1:9',
      MOVA_LAB_BASE_URL: movaLab.url,
    }),
  );
  const { server, url } = await listen(createApp({ config, logger, store, clock: instantClock() }));
  t.after(() => shutDown(server, 50));
  return { store, url, ollama, config };
}

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
