import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';

const config = loadConfig({ SERVICE_TOKEN: 'test-token' });
const logger = createLogger('silent');

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

function listeningServers() {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap').length;
}

test('createApp constructs an Express app without opening a port', () => {
  const before = listeningServers();
  const app = createApp({ config, logger });
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
  assert.equal(listeningServers(), before);
});

test('GET /health is public and makes no external calls', async (t) => {
  const { server, url } = await listen(createApp({ config, logger }));
  t.after(() => shutDown(server, 100));
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
  assert.match(response.headers.get('x-request-id') ?? '', /^[\da-f-]{36}$/i);
});

test('protected route rejects invalid tokens before the handler runs', async (t) => {
  const { server, url } = await listen(createApp({ config, logger, testRoutes: true }));
  t.after(() => shutDown(server, 100));
  const path = `${url}/__test/protected`;

  const missing = await fetch(path, { method: 'POST' });
  assert.equal(missing.status, 401);

  const wrong = await fetch(path, {
    method: 'POST',
    headers: { authorization: 'Bearer wrong-token' },
  });
  assert.equal(wrong.status, 401);
  const body = await wrong.json();
  assert.equal(body.error.code, 'UNAUTHORIZED');
  assert.equal(body.error.requestId, wrong.headers.get('x-request-id'));
  assert.equal(JSON.stringify(body).includes('wrong-token'), false);

  const ok = await fetch(path, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token' },
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, hits: 1 });
});

test('malformed and oversized JSON return sanitized errors', async (t) => {
  const { server, url } = await listen(createApp({ config, logger }));
  t.after(() => shutDown(server, 100));

  const malformed = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  });
  assert.equal(malformed.status, 400);
  const malformedBody = await malformed.json();
  assert.equal(malformedBody.error.code, 'MALFORMED_JSON');
  assert.equal(malformedBody.error.requestId, malformed.headers.get('x-request-id'));
  assert.equal(JSON.stringify(malformedBody).includes('stack'), false);

  const missing = await fetch(`${url}/nope`);
  assert.equal(missing.status, 404);
  const missingBody = await missing.json();
  assert.equal(missingBody.error.code, 'NOT_FOUND');
  assert.equal(missingBody.error.requestId, missing.headers.get('x-request-id'));

  const oversized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: `{"x":"${'a'.repeat(16 * 1024)}"}`,
  });
  assert.equal(oversized.status, 413);
  const oversizedBody = await oversized.json();
  assert.equal(oversizedBody.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(oversizedBody.error.requestId, oversized.headers.get('x-request-id'));
});

test('unexpected errors omit stacks and secrets from the public body', async (t) => {
  const chunks: string[] = [];
  const log = createLogger('error', { write(msg) { chunks.push(msg); } });
  const { server, url } = await listen(createApp({ config, logger: log, testRoutes: true }));
  t.after(() => shutDown(server, 100));
  const response = await fetch(`${url}/__test/boom`);
  assert.equal(response.status, 500);
  const body = await response.json();
  const text = JSON.stringify(body);
  assert.equal(body.error.code, 'INTERNAL_ERROR');
  assert.equal(body.error.message, 'Internal server error.');
  assert.equal(body.error.requestId, response.headers.get('x-request-id'));
  assert.equal(text.includes('boom-secret'), false);
  assert.equal(text.includes('stack'), false);
  const logged = chunks.join('');
  assert.equal(logged.includes(body.error.requestId), true);
});

test('logger redacts authorization values', () => {
  const chunks: string[] = [];
  const log = createLogger('info', { write(msg) { chunks.push(msg); } });
  log.info({ headers: { authorization: 'Bearer leaked-token' } }, 'check');
  const text = chunks.join('');
  assert.equal(text.includes('leaked-token'), false);
  assert.equal(text.includes('Bearer'), false);
});

test('shutdown stops new work and aborts remaining work after the drain period', async () => {
  const { server, url } = await listen(createApp({ config, logger, testRoutes: true }));
  const hang = http.get(`${url}/__test/hang`);
  hang.on('error', () => {});
  await once(hang, 'response');

  const drainMs = 80;
  const started = Date.now();
  const stopping = shutDown(server, drainMs);
  await assert.rejects(fetch(`${url}/health`, { signal: AbortSignal.timeout(500) }));
  await stopping;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= drainMs, `drain returned too early (${elapsed}ms)`);
  assert.ok(elapsed < 1000, `drain lasted too long (${elapsed}ms)`);
});
