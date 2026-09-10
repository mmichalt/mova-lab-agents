import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { contentRequestSchema, generationResultSchema } from '../src/content/schemas.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';
import {
  chatCalls,
  chatsOf,
  completedAttempts,
  failedAttempts,
  fakeOllama,
  instantClock,
  listen,
  postDrafts,
  scriptedChats,
  sequentialReply,
  teacherRequest,
  workflowLog,
} from './drafts-harness.ts';
import { chatEnvelope, chatFixtures, errorBodies, generatedContent } from './fixtures/ollama.ts';
import {
  classifySmokeRun,
  fetchJson,
  smokeSettingsSufficed,
  smokeTruncated,
} from './smoke-report.ts';

const marker = 'SECRET_TEACHER_MARKER';

async function waitUntil(predicate: () => boolean, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting');
}

function duplicateGenerated() {
  const body = JSON.parse(generatedContent) as {
    status: string;
    proposals: Array<Record<string, unknown>>;
  };
  body.proposals[1] = { ...body.proposals[1], phrase: body.proposals[0]?.phrase };
  return chatEnvelope({ message: { role: 'assistant', content: JSON.stringify(body) } });
}

test('oversized and stalled error bodies stay bounded and keep timeout codes', async (t) => {
  const oversized = await postDrafts(t, {
    reply: () => ({ status: 500, raw: 'x'.repeat(2 * 1024 * 1024) }),
  });
  assert.equal(oversized.response.status, 503);
  assert.equal((await oversized.response.json()).error.code, 'PROVIDER_UNAVAILABLE');

  const stalled503 = await postDrafts(t, {
    reply: () => ({ hangBody: true, status: 503 }),
    timeoutMs: '80',
  });
  assert.equal(stalled503.response.status, 504);
  assert.equal((await stalled503.response.json()).error.code, 'PROVIDER_TIMEOUT');
  assert.equal(chatCalls(stalled503.ollama.calls).length, 1);

  const stalled500 = await postDrafts(t, {
    reply: () => ({ hangBody: true, status: 500 }),
    timeoutMs: '80',
  });
  assert.equal(stalled500.response.status, 504);
  assert.equal((await stalled500.response.json()).error.code, 'PROVIDER_TIMEOUT');
});

test('stalled metadata cannot turn an expired workflow into ready-for-review', async (t) => {
  const fallback = sequentialReply();
  const { response, ollama, logs } = await postDrafts(t, {
    reply: (call) => {
      if (call.url === '/api/version' || call.url === '/api/tags') return { hang: true };
      return fallback(call);
    },
    workflowTimeoutMs: '180',
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'WORKFLOW_TIMEOUT');
  assert.equal(chatsOf(ollama.calls, 'generation').length, 0);
  assert.equal(workflowLog(logs).errorCode, 'WORKFLOW_TIMEOUT');
});

test('a deadline during review chat returns WORKFLOW_TIMEOUT', async (t) => {
  const { response, logs } = await postDrafts(t, {
    reply: scriptedChats({ age: { hang: true } }),
    workflowTimeoutMs: '250',
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'WORKFLOW_TIMEOUT');
  assert.equal(workflowLog(logs).status, 'FAILED');
  assert.equal(workflowLog(logs).errorCode, 'WORKFLOW_TIMEOUT');
});

test('client disconnect and forced shutdown stop later provider calls', async (t) => {
  const hangChat = (call: { url: string }) =>
    call.url === '/api/chat' ? { hang: true as const } : { status: 200, json: {} };

  const disconnectOllama = await fakeOllama(t, hangChat);
  const config = loadConfig({
    SERVICE_TOKEN: 'test-token',
    OLLAMA_BASE_URL: disconnectOllama.url,
    LLM_ATTEMPT_TIMEOUT_MS: '5000',
    WORKFLOW_TIMEOUT_MS: '600000',
  });
  const { server, url } = await listen(
    createApp({ config, logger: createLogger('silent'), clock: instantClock() }),
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
      config: loadConfig({
        SERVICE_TOKEN: 'test-token',
        OLLAMA_BASE_URL: shutdownOllama.url,
        LLM_ATTEMPT_TIMEOUT_MS: '5000',
        WORKFLOW_TIMEOUT_MS: '600000',
      }),
      logger: createLogger('silent'),
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

test('refusal reasons and reviewer codes do not enter ordinary logs', async (t) => {
  const refused = chatEnvelope({
    message: {
      role: 'assistant',
      content: JSON.stringify({ status: 'refused', reason: marker }),
    },
  });
  const vocab = await postDrafts(t, { reply: sequentialReply(refused) });
  assert.equal(vocab.response.status, 422);
  assert.equal(vocab.logs.includes(marker), false);
  assert.equal(
    JSON.parse(vocab.logs.split('\n').find((line) => line.includes('model refused')) ?? '{}')
      .reason,
    undefined,
  );

  const invented = chatEnvelope({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        status: 'failed',
        issues: [{ code: marker, severity: 'error', message: marker }],
      }),
    },
  });
  const review = await postDrafts(t, {
    reply: scriptedChats({
      age: { status: 200, json: invented },
      language: { status: 200, json: chatFixtures.reviewPassed },
    }),
  });
  assert.equal(review.logs.includes(marker), false);
  assert.equal((workflowLog(review.logs).issueCodes as string[]).includes(marker), false);
});

test('operational failures still finish with terminal state and counters', async (t) => {
  const { response, logs } = await postDrafts(t, {
    reply: () => ({ status: 404, json: errorBodies.missingModel }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'MODEL_UNAVAILABLE');
  const finished = workflowLog(logs);
  assert.equal(finished.status, 'FAILED');
  assert.equal(finished.errorCode, 'MODEL_UNAVAILABLE');
  assert.equal(finished.providerRequests, 1);
  assert.equal(logs.includes('workflow finished'), true);
});

test('malformed revisions keep the checked candidate version', async (t) => {
  const { response, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: duplicateGenerated() },
      revision: [
        { status: 200, json: chatFixtures.invalidJson },
        { status: 200, json: chatFixtures.invalidJson },
      ],
    }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'CONTENT_VALIDATION_EXHAUSTED');
  const finished = workflowLog(logs);
  assert.equal(finished.candidateVersion, 1);
  assert.equal(finished.revisionCount, 2);
  assert.equal(finished.attempts, 3);
  assert.deepEqual(finished.issueCodes, ['DUPLICATE_PHRASE']);
});

test('truncated envelopes still retain reported usage', async (t) => {
  const { response, logs } = await postDrafts(t, {
    reply: () => ({ status: 200, json: chatFixtures.truncated }),
  });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'PROVIDER_INCOMPLETE');
  assert.equal(workflowLog(logs).usageCount, 1);
});

test('each transport attempt is logged and successful usage is retained', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: [
        { status: 503, json: errorBodies.overload },
        { status: 200, json: chatFixtures.generated },
      ],
    }),
  });
  assert.equal(response.status, 200);
  generationResultSchema.parse(await response.json());
  assert.equal(chatsOf(ollama.calls, 'generation').length, 2);
  const failed = failedAttempts(logs).filter((item) => item.step === 'generation');
  const completed = completedAttempts(logs).filter((item) => item.step === 'generation');
  assert.equal(failed.length, 1);
  assert.equal(completed.length, 1);
  assert.notEqual(failed[0]?.attemptId, completed[0]?.attemptId);
  assert.equal(workflowLog(logs).usageCount, 4);
  assert.equal(workflowLog(logs).providerRequests, 5);
});

test('smoke classification distinguishes HTTP, workflow, revision, and truncation', () => {
  const request = contentRequestSchema.parse(teacherRequest);
  const passedChecks = [
    { status: 'passed', name: 'content', issues: [] },
    { status: 'passed', name: 'age', issues: [] },
    { status: 'passed', name: 'language', issues: [] },
  ];
  const proposal = {
    localId: 'proposal-1',
    type: 'recording',
    title: 'Риба',
    phrase: 'Риба пливе',
    childHint: 'Скажи',
    teacherNote: 'Повільно',
    targetSound: 'р',
    difficulty: 'easy',
  };
  const ready = {
    requestId: '11111111-1111-4111-8111-111111111111',
    status: 'READY_FOR_REVIEW',
    candidateVersion: 1,
    revisionCount: 0,
    providerRequests: 4,
    requiresHumanApproval: true,
    checks: passedChecks,
    proposals: [
      proposal,
      { ...proposal, localId: 'proposal-2', targetSound: 'л', phrase: 'Лис біжить' },
    ],
  };
  const failedHttpOk = {
    ...ready,
    status: 'FAILED',
    requiresHumanApproval: false,
    checks: [
      ...passedChecks.slice(0, 2),
      { status: 'unavailable', name: 'language', errorCode: 'PROVIDER_INCOMPLETE' },
    ],
  };
  const revised = { ...ready, revisionCount: 1, providerRequests: 7 };
  const reasked = { ...ready, revisionCount: 0, providerRequests: 5 };
  const first = classifySmokeRun(request, {
    httpOk: true,
    status: 200,
    code: null,
    requestId: 'a',
    body: ready,
  });
  const reviewFail = classifySmokeRun(request, {
    httpOk: true,
    status: 200,
    code: null,
    requestId: 'b',
    body: failedHttpOk,
  });
  const recovered = classifySmokeRun(request, {
    httpOk: true,
    status: 200,
    code: null,
    requestId: 'c',
    body: revised,
  });
  const reviewReask = classifySmokeRun(request, {
    httpOk: true,
    status: 200,
    code: null,
    requestId: 'c-reask',
    body: reasked,
  });
  const timedOut = classifySmokeRun(request, {
    httpOk: false,
    status: 504,
    code: 'PROVIDER_INCOMPLETE',
    requestId: 'd',
    body: { error: { code: 'PROVIDER_INCOMPLETE' } },
  });
  assert.equal(first.firstAttemptReady, true);
  assert.equal(first.truncated, null);
  assert.equal(reviewFail.httpOk, true);
  assert.equal(reviewFail.readyForReview, false);
  assert.equal(reviewFail.firstAttemptReady, false);
  assert.equal(reviewFail.truncated, true);
  assert.equal(
    reviewFail.qualities?.every((item) => item.passed === false),
    true,
  );
  assert.equal(recovered.revisionAssisted, true);
  assert.equal(recovered.firstAttemptReady, false);
  assert.equal(recovered.truncated, null);
  assert.equal(reviewReask.revisionAssisted, false);
  assert.equal(reviewReask.firstAttemptReady, false);
  assert.equal(timedOut.truncated, true);
  assert.equal(smokeSettingsSufficed([first, recovered]), false);
  assert.equal(smokeSettingsSufficed([first, reviewReask]), false);
  assert.equal(smokeTruncated([first, recovered]), null);
  assert.equal(smokeTruncated([first]), null);
});

test('smoke fetchJson reports the timed-out stage', async (t) => {
  const ollama = await fakeOllama(t, () => ({ hang: true }));
  await assert.rejects(
    () => fetchJson(`${ollama.url}/api/version`, 'health', 50),
    /health timed out/,
  );
});
