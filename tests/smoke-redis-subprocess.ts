import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Queue, Worker } from 'bullmq';

const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

if (process.argv[2] === '--child') {
  const [, , , queueName, receiverUrl] = process.argv;
  const worker = new Worker(
    queueName,
    async (job) => {
      await fetch(receiverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importKey: job.data.importKey }),
      });
    },
    { connection: { url: redisUrl }, lockDuration: 1_000, stalledInterval: 500 },
  );
  await once(worker, 'ready');
  process.send?.('ready');
  await new Promise(() => {});
}

const queueName = `mova-lab-subprocess-smoke-${process.pid}-${Date.now()}`;
const queue = new Queue(queueName, { connection: { url: redisUrl } });
const importedDrafts = new Map<string, string>();
const responseIds: string[] = [];
let requestCount = 0;
let createdDrafts = 0;
let releaseFirstRequest = () => {};
const firstRequest = new Promise<void>((resolve) => {
  releaseFirstRequest = resolve;
});
const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/import') {
    response.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  const { importKey } = JSON.parse(body) as { importKey: string };
  requestCount += 1;
  let draftId = importedDrafts.get(importKey);
  if (!draftId) {
    createdDrafts += 1;
    draftId = `draft-${createdDrafts}`;
    importedDrafts.set(importKey, draftId);
  }
  responseIds.push(draftId);
  if (requestCount === 1) await firstRequest;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ id: draftId }));
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address();
assert.ok(address && typeof address !== 'string');
const receiverUrl = `http://127.0.0.1:${address.port}/import`;
const child = spawn(
  process.execPath,
  [new URL(import.meta.url).pathname, '--child', queueName, receiverUrl],
  {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    env: { ...process.env, REDIS_URL: redisUrl },
  },
);
const childReady = new Promise<void>((resolve, reject) => {
  child.once('message', (message) =>
    message === 'ready' ? resolve() : reject(new Error('child failed')),
  );
  child.once('error', reject);
  child.once(
    'exit',
    (code) => code === 0 || code === null || reject(new Error(`child exited ${code}`)),
  );
});
const waitFor = async (predicate: () => boolean | Promise<boolean>, label: string) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

let recovery: Worker | undefined;
try {
  await childReady;
  const importKey = `import-${Date.now()}`;
  const job = await queue.add('import', { importKey }, { removeOnComplete: true });
  assert.ok(job.id);
  const jobId = job.id;
  await waitFor(() => requestCount === 1, 'first import request');
  child.kill('SIGKILL');
  await once(child, 'exit');

  recovery = new Worker(
    queueName,
    async (redelivered) => {
      await fetch(receiverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ importKey: redelivered.data.importKey }),
      });
    },
    { connection: { url: redisUrl }, lockDuration: 1_000, stalledInterval: 500 },
  );
  await waitFor(() => requestCount === 2, 'redelivered import request');
  releaseFirstRequest();
  await waitFor(
    async () => (await queue.getJob(jobId)) === undefined,
    'redelivered job completion',
  );
  assert.equal(requestCount, 2, 'the import must be redelivered');
  assert.equal(createdDrafts, 1, 'the receiver must create one draft');
  assert.deepEqual(responseIds, ['draft-1', 'draft-1'], 'the receiver must reuse the draft');
  console.log('Redis subprocess smoke passed: worker death, redelivery, and idempotent import.');
} finally {
  child.kill('SIGKILL');
  await recovery?.close(true);
  await queue.close();
  server.close();
}
