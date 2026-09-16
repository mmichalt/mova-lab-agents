import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';
import {
  chatCalls,
  fakeMovaLab,
  fakeOllama,
  instantClock,
  teacherRequest,
  testEnv,
} from './drafts-harness.ts';

const config = loadConfig(testEnv());
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

async function waitUntil(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
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

test('malformed and oversized JSON on protected routes return sanitized errors', async (t) => {
  const { server, url } = await listen(createApp({ config, logger }));
  t.after(() => shutDown(server, 100));
  const drafts = `${url}/content-drafts`;
  const jsonHeaders = { 'content-type': 'application/json' };
  const authHeaders = { ...jsonHeaders, authorization: 'Bearer test-token' };
  const oversized = `{"x":"${'a'.repeat(16 * 1024)}"}`;

  const unauthenticated = await fetch(drafts, {
    method: 'POST',
    headers: jsonHeaders,
    body: '{',
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal((await unauthenticated.json()).error.code, 'UNAUTHORIZED');

  const unauthenticatedOversize = await fetch(drafts, {
    method: 'POST',
    headers: jsonHeaders,
    body: oversized,
  });
  assert.equal(unauthenticatedOversize.status, 401);

  const malformed = await fetch(drafts, {
    method: 'POST',
    headers: authHeaders,
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

  const rootMalformed = await fetch(url, {
    method: 'POST',
    headers: jsonHeaders,
    body: '{',
  });
  assert.equal(rootMalformed.status, 404);

  const oversizedAuth = await fetch(drafts, {
    method: 'POST',
    headers: authHeaders,
    body: oversized,
  });
  assert.equal(oversizedAuth.status, 413);
  const oversizedBody = await oversizedAuth.json();
  assert.equal(oversizedBody.error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(oversizedBody.error.requestId, oversizedAuth.headers.get('x-request-id'));
});

test('unexpected errors omit stacks and secrets from the public body', async (t) => {
  const chunks: string[] = [];
  const log = createLogger('error', {
    write(msg) {
      chunks.push(msg);
    },
  });
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
  const log = createLogger('info', {
    write(msg) {
      chunks.push(msg);
    },
  });
  log.info({ headers: { authorization: 'Bearer leaked-token' } }, 'check');
  log.info({ movaLabServiceToken: 'outbound-secret' }, 'outbound');
  const text = chunks.join('');
  assert.equal(text.includes('leaked-token'), false);
  assert.equal(text.includes('Bearer'), false);
  assert.equal(text.includes('outbound-secret'), false);
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
  assert.ok(elapsed >= drainMs - 25, `drain returned too early (${elapsed}ms)`);
  assert.ok(elapsed < 1000, `drain lasted too long (${elapsed}ms)`);
});

test('client disconnect and forced shutdown stop later provider calls', async (t) => {
  const hangChat = (call: { url: string }) =>
    call.url === '/api/chat' ? { hang: true as const } : { status: 200, json: {} };

  const disconnectOllama = await fakeOllama(t, hangChat);
  const movaLab = await fakeMovaLab(t);
  const draftsConfig = loadConfig(
    testEnv({
      OLLAMA_BASE_URL: disconnectOllama.url,
      MOVA_LAB_BASE_URL: movaLab.url,
      LLM_ATTEMPT_TIMEOUT_MS: '5000',
      WORKFLOW_TIMEOUT_MS: '600000',
    }),
  );
  const { server, url } = await listen(
    createApp({ config: draftsConfig, logger, clock: instantClock() }),
  );
  t.after(() => shutDown(server, 50));

  const ac = new AbortController();
  const pending = fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(teacherRequest),
    signal: ac.signal,
  });
  await waitUntil(() => chatCalls(disconnectOllama.calls).length === 1);
  ac.abort();
  await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(chatCalls(disconnectOllama.calls).length, 1);

  const shutdownOllama = await fakeOllama(t, hangChat);
  const shutdownApp = await listen(
    createApp({
      config: loadConfig(
        testEnv({
          OLLAMA_BASE_URL: shutdownOllama.url,
          MOVA_LAB_BASE_URL: movaLab.url,
          LLM_ATTEMPT_TIMEOUT_MS: '5000',
          WORKFLOW_TIMEOUT_MS: '600000',
        }),
      ),
      logger,
      clock: instantClock(),
    }),
  );
  const hang = fetch(`${shutdownApp.url}/content-drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(teacherRequest),
  });
  hang.catch(() => {});
  await waitUntil(() => chatCalls(shutdownOllama.calls).length === 1);
  await shutDown(shutdownApp.server, 40);
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(chatCalls(shutdownOllama.calls).length, 1);
});
