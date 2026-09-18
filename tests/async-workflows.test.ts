import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { AppError } from '../src/errors.ts';
import type { WorkflowJobProducer } from '../src/jobs.ts';
import { createLogger } from '../src/logger.ts';
import { CONSTRAINTS_VERSION, openWorkflowStore } from '../src/persist/store.ts';
import { shutDown } from '../src/server.ts';
import { EXPECTED_CONSTRAINTS } from '../src/tools/mova-lab.ts';
import {
  chatCalls,
  fakeMovaLab,
  fakeOllama,
  instantClock,
  listen,
  sequentialReply,
  teacherRequest,
  testEnv,
} from './drafts-harness.ts';

const logger = createLogger('silent');

function tempStore(t: { after: (fn: () => void) => void }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ag-022-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = openWorkflowStore(path.join(dir, 'workflows.sqlite'));
  t.after(() => store.close());
  return store;
}

function fakeQueue(
  jobs: Array<{ name: string; runId: string; stateVersion: number }>,
  failures = 0,
) {
  const queued = new Set<string>();
  const add = (name: string, runId: string, stateVersion: number) => {
    if (failures > 0) {
      failures -= 1;
      return Promise.reject(
        new AppError(503, 'QUEUE_UNAVAILABLE', 'Workflow queue is unavailable.'),
      );
    }
    const key = `${name}:${runId}:${stateVersion}`;
    if (!queued.has(key)) {
      queued.add(key);
      jobs.push({ name, runId, stateVersion });
    }
    return Promise.resolve();
  };
  return {
    enqueueGeneration: (runId: string, stateVersion: number) =>
      add('generation', runId, stateVersion),
    enqueueImport: (runId: string, stateVersion: number) => add('import', runId, stateVersion),
    close: () => Promise.resolve(),
  } satisfies WorkflowJobProducer;
}

function headers(actor = 'teacher-1', key = 'key-1') {
  return {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'x-actor-id': actor,
    'idempotency-key': key,
  };
}

test('queued generation is durably accepted before any model call', async (t) => {
  const store = tempStore(t);
  const jobs: Array<{ name: string; runId: string; stateVersion: number }> = [];
  const queue = fakeQueue(jobs);
  const ollama = await fakeOllama(t, sequentialReply());
  const movaLab = await fakeMovaLab(t);
  const config = loadConfig(
    testEnv({ OLLAMA_BASE_URL: ollama.url, MOVA_LAB_BASE_URL: movaLab.url }),
  );
  const { server, url } = await listen(
    createApp({ config, logger, store, queue, clock: instantClock() }),
  );
  t.after(() => shutDown(server, 50));

  const response = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(response.status, 202);
  const body = await response.json();
  assert.equal(body.status, 'PENDING');
  assert.equal(store.getRun(body.id)?.status, 'PENDING');
  assert.deepEqual(jobs, [{ name: 'generation', runId: body.id, stateVersion: 0 }]);
  assert.equal(chatCalls(ollama.calls).length, 0);

  const duplicate = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(duplicate.status, 200);
  assert.equal((await duplicate.json()).id, body.id);
  assert.equal(jobs.length, 1);
});

test('idempotent generation retry requeues a run after dispatch failure', async (t) => {
  const store = tempStore(t);
  const jobs: Array<{ name: string; runId: string; stateVersion: number }> = [];
  const queue = fakeQueue(jobs, 1);
  const ollama = await fakeOllama(t, sequentialReply());
  const movaLab = await fakeMovaLab(t);
  const config = loadConfig(
    testEnv({ OLLAMA_BASE_URL: ollama.url, MOVA_LAB_BASE_URL: movaLab.url }),
  );
  const { server, url } = await listen(
    createApp({ config, logger, store, queue, clock: instantClock() }),
  );
  t.after(() => shutDown(server, 50));

  const first = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(first.status, 503);
  assert.equal(store.getRunByIdempotency('teacher-1', 'key-1')?.status, 'PENDING');
  assert.deepEqual(jobs, []);

  const retry = await fetch(`${url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(retry.status, 200);
  assert.deepEqual(jobs, [
    {
      name: 'generation',
      runId: store.getRunByIdempotency('teacher-1', 'key-1')?.id,
      stateVersion: 0,
    },
  ]);
});

test('approval queues import instead of running it in the HTTP request', async (t) => {
  const store = tempStore(t);
  const ollama = await fakeOllama(t, sequentialReply());
  const movaLab = await fakeMovaLab(t, (call) =>
    call.url.endsWith('/categories')
      ? {
          status: 200,
          json: { version: CONSTRAINTS_VERSION, items: [{ id: 'cat-1', name: 'Артикуляція' }] },
        }
      : { status: 200, json: EXPECTED_CONSTRAINTS },
  );
  const config = loadConfig(
    testEnv({ OLLAMA_BASE_URL: ollama.url, MOVA_LAB_BASE_URL: movaLab.url }),
  );
  const synchronous = await listen(createApp({ config, logger, store, clock: instantClock() }));
  t.after(() => shutDown(synchronous.server, 50));
  const created = await fetch(`${synchronous.url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(created.status, 201);
  const ready = await created.json();

  const jobs: Array<{ name: string; runId: string; stateVersion: number }> = [];
  const queue = fakeQueue(jobs);
  const asynchronous = await listen(
    createApp({ config, logger, store, queue, clock: instantClock() }),
  );
  t.after(() => shutDown(asynchronous.server, 50));
  const approval = await fetch(`${asynchronous.url}/workflows/${ready.id}/approve`, {
    method: 'POST',
    headers: { ...headers('admin-1'), 'x-content-admin': 'true' },
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  });
  assert.equal(approval.status, 202);
  const approved = await approval.json();
  assert.equal(approved.status, 'RUNNING');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.name, 'import');
  assert.equal(jobs[0]?.runId, ready.id);
  assert.equal(jobs[0]?.stateVersion, approved.stateVersion);
  assert.equal(movaLab.calls.filter((call) => call.url.endsWith('/recording-drafts')).length, 0);
});

test('same approval retry requeues import after dispatch failure', async (t) => {
  const store = tempStore(t);
  const ollama = await fakeOllama(t, sequentialReply());
  const movaLab = await fakeMovaLab(t, (call) =>
    call.url.endsWith('/categories')
      ? {
          status: 200,
          json: { version: CONSTRAINTS_VERSION, items: [{ id: 'cat-1', name: 'Артикуляція' }] },
        }
      : { status: 200, json: EXPECTED_CONSTRAINTS },
  );
  const config = loadConfig(
    testEnv({ OLLAMA_BASE_URL: ollama.url, MOVA_LAB_BASE_URL: movaLab.url }),
  );
  const synchronous = await listen(createApp({ config, logger, store, clock: instantClock() }));
  t.after(() => shutDown(synchronous.server, 50));
  const created = await fetch(`${synchronous.url}/workflows/content-generation`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(created.status, 201);
  const ready = await created.json();

  const jobs: Array<{ name: string; runId: string; stateVersion: number }> = [];
  const queue = fakeQueue(jobs, 1);
  const asynchronous = await listen(
    createApp({ config, logger, store, queue, clock: instantClock() }),
  );
  t.after(() => shutDown(asynchronous.server, 50));
  const request = {
    method: 'POST',
    headers: { ...headers('admin-1'), 'x-content-admin': 'true' },
    body: JSON.stringify({ candidateVersion: 1, categoryId: 'cat-1' }),
  };
  const first = await fetch(`${asynchronous.url}/workflows/${ready.id}/approve`, request);
  assert.equal(first.status, 503);
  assert.deepEqual(jobs, []);

  const retry = await fetch(`${asynchronous.url}/workflows/${ready.id}/approve`, request);
  assert.equal(retry.status, 200);
  assert.deepEqual(jobs, [
    { name: 'import', runId: ready.id, stateVersion: store.getRun(ready.id)?.stateVersion },
  ]);
});
