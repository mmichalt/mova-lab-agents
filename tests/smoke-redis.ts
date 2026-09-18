import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Queue } from 'bullmq';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import {
  closeWorkflowWorker,
  createWorkflowQueue,
  createWorkflowWorker,
  WORKFLOW_QUEUE_NAME,
} from '../src/jobs.ts';
import { createLogger } from '../src/logger.ts';
import { CONSTRAINTS_VERSION, openWorkflowStore, type PersistedRun } from '../src/persist/store.ts';
import { shutDown } from '../src/server.ts';
import { EXPECTED_CONSTRAINTS } from '../src/tools/mova-lab.ts';
import {
  fakeMovaLab,
  fakeOllama,
  instantClock,
  listen,
  sequentialReply,
  teacherRequest,
  testEnv,
} from './drafts-harness.ts';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const cleanup: Array<() => Promise<void> | void> = [];
const t = { after: (fn: () => Promise<void> | void) => cleanup.push(fn) };
const tempDir = mkdtempSync(path.join(tmpdir(), 'mova-lab-redis-smoke-'));
const store = openWorkflowStore(path.join(tempDir, 'workflows.sqlite'));
const logger = createLogger('silent');
const ollama = await fakeOllama(t, sequentialReply());
const flakyReply = sequentialReply();
let successfulChats = 0;
const failingOllama = await fakeOllama(t, (call) => {
  if (call.method === 'POST' && call.url === '/api/chat' && ++successfulChats > 2) {
    return { status: 500, json: { error: 'busy' } };
  }
  return flakyReply(call);
});
const movaLab = await fakeMovaLab(t, (call) => {
  if (call.url.endsWith('/categories')) {
    return {
      status: 200,
      json: { version: CONSTRAINTS_VERSION, items: [{ id: 'cat-1', name: 'Артикуляція' }] },
    };
  }
  if (call.url.endsWith('/recording-drafts')) return { status: 200, json: { id: 'draft-1' } };
  return { status: 200, json: EXPECTED_CONSTRAINTS };
});
const config = loadConfig(
  testEnv({ OLLAMA_BASE_URL: ollama.url, MOVA_LAB_BASE_URL: movaLab.url, REDIS_URL: redisUrl }),
);
const failingConfig = loadConfig(
  testEnv({
    OLLAMA_BASE_URL: failingOllama.url,
    MOVA_LAB_BASE_URL: movaLab.url,
    REDIS_URL: redisUrl,
    LLM_ATTEMPT_TIMEOUT_MS: '2000',
  }),
);
const queue = createWorkflowQueue(redisUrl, logger);
const redisQueue = new Queue(WORKFLOW_QUEUE_NAME, { connection: { url: redisUrl } });
let worker: ReturnType<typeof createWorkflowWorker> | undefined;
let server: Server | undefined;

async function waitFor(
  id: string,
  predicate: (run: PersistedRun | undefined) => boolean,
  label: string,
) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const run = store.getRun(id);
    if (predicate(run)) return run as PersistedRun;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(store.getRun(id))}`);
}

async function reconcile() {
  if (!queue.reconcile) throw new Error('Queue reconciliation is not configured.');
  return queue.reconcile(store);
}

try {
  const app = await listen(createApp({ config, logger, store, queue, clock: instantClock() }));
  server = app.server;
  const headers = {
    authorization: 'Bearer test-token',
    'content-type': 'application/json',
    'x-actor-id': 'teacher-1',
  };
  const create = async (key: string) =>
    fetch(`${app.url}/workflows/content-generation`, {
      method: 'POST',
      headers: { ...headers, 'idempotency-key': key },
      body: JSON.stringify(teacherRequest),
    });

  const accepted = await create(`redis-smoke-${Date.now()}`);
  assert.equal(accepted.status, 202);
  const pending = await accepted.json();
  const jobId = `generation-${pending.id}-0`;
  assert.ok(await redisQueue.getJob(jobId));
  assert.equal(await reconcile(), 1);
  await (await redisQueue.getJob(jobId))?.remove();
  assert.equal(await redisQueue.getJob(jobId), undefined);
  assert.equal(await reconcile(), 1);
  assert.ok(await redisQueue.getJob(jobId));

  worker = createWorkflowWorker({
    config,
    logger,
    store,
    redisUrl,
    queue,
    reconcileIntervalMs: 100,
  });
  await waitFor(pending.id, (run) => run?.status === 'AWAITING_APPROVAL', 'approval checkpoint');
  const review = await (await fetch(`${app.url}/workflows/${pending.id}`, { headers })).json();
  const approval = await fetch(`${app.url}/workflows/${pending.id}/approve`, {
    method: 'POST',
    headers: { ...headers, 'x-actor-id': 'admin-1', 'x-content-admin': 'true' },
    body: JSON.stringify({ candidateVersion: review.result.candidateVersion, categoryId: 'cat-1' }),
  });
  assert.equal(approval.status, 202);
  await waitFor(pending.id, (run) => run?.status === 'COMPLETED', 'completed import');

  await closeWorkflowWorker(worker, 2_000);
  worker = createWorkflowWorker({
    config: failingConfig,
    logger,
    store,
    redisUrl,
    queue,
    reconcileIntervalMs: 100,
  });
  const failed = await create(`redis-redelivery-${Date.now()}`);
  assert.equal(failed.status, 202);
  const failedRun = await failed.json();
  const exhausted = await waitFor(
    failedRun.id,
    (run) => run?.status === 'FAILED' && run.deliveryCounts.generation === 3,
    'bounded redelivery exhaustion',
  );
  assert.equal(exhausted.deliveryCounts.generation, 3);
  console.log(
    'Redis smoke passed: reconciliation, async approval/import, and 3-delivery exhaustion.',
  );
} finally {
  if (worker) await closeWorkflowWorker(worker, 2_000);
  await queue.close();
  await redisQueue.close();
  if (server) await shutDown(server, 100);
  store.close();
  for (const fn of cleanup.reverse()) await fn();
  rmSync(tempDir, { recursive: true, force: true });
}
