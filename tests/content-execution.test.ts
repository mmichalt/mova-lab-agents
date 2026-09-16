import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generationResultSchema } from '../src/content/schemas.ts';
import {
  chatCalls,
  chatKind,
  chatsOf,
  completedAttempts,
  failedAttempts,
  postDrafts,
  scriptedChats,
  sequentialReply,
  workflowLog,
} from './drafts-harness.ts';
import { chatFixtures, errorBodies } from './fixtures/ollama.ts';

test('transport retry of generation does not consume a candidate version', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: [
        { status: 503, json: errorBodies.overload },
        { status: 200, json: chatFixtures.generated },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 0);
  assert.equal(chatsOf(ollama.calls, 'generation').length, 2);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 0);
  assert.equal(workflowLog(logs).providerRequests, 5);
  assert.match(logs, /llm transport retry/);
});

test('429 with Retry-After retries the same operation', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: scriptedChats({
      generation: [
        {
          status: 429,
          headers: { 'retry-after': '0' },
          json: errorBodies.tooManyRequests,
        },
        { status: 200, json: chatFixtures.generated },
      ],
    }),
  });
  assert.equal(response.status, 200);
  assert.equal(generationResultSchema.parse(await response.json()).candidateVersion, 1);
  assert.equal(chatsOf(ollama.calls, 'generation').length, 2);
});

test('missing models and capacity failures are not retried', async (t) => {
  const missing = await postDrafts(t, {
    reply: () => ({ status: 404, json: errorBodies.missingModel }),
  });
  assert.equal(missing.response.status, 503);
  assert.equal((await missing.response.json()).error.code, 'MODEL_UNAVAILABLE');
  assert.equal(chatCalls(missing.ollama.calls).length, 1);

  const capacity = await postDrafts(t, {
    reply: () => ({ status: 500, json: errorBodies.loadFailure }),
  });
  assert.equal(capacity.response.status, 503);
  assert.equal((await capacity.response.json()).error.code, 'MODEL_CAPACITY');
  assert.equal(chatCalls(capacity.ollama.calls).length, 1);
});

test('malformed reviewer output is re-asked once', async (t) => {
  const recovered = await postDrafts(t, {
    reply: scriptedChats({
      age: [
        { status: 200, json: chatFixtures.invalidJson },
        { status: 200, json: chatFixtures.reviewPassed },
      ],
    }),
  });
  assert.equal(recovered.response.status, 200);
  const recoveredBody = generationResultSchema.parse(await recovered.response.json());
  assert.equal(recoveredBody.status, 'READY_FOR_REVIEW');
  assert.equal(recoveredBody.revisionCount, 0);
  assert.equal(recoveredBody.providerRequests, 5);
  assert.equal(chatsOf(recovered.ollama.calls, 'age').length, 2);
  assert.equal(chatsOf(recovered.ollama.calls, 'revision').length, 0);
  assert.match(recovered.logs, /review re-ask/);

  const failed = await postDrafts(t, {
    reply: scriptedChats({
      age: [
        { status: 200, json: chatFixtures.invalidJson },
        { status: 200, json: chatFixtures.invalidJson },
      ],
    }),
  });
  assert.equal(failed.response.status, 200);
  const body = await failed.response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.revisionCount, 0);
  const age = body.checks.find((check: { name: string }) => check.name === 'age');
  assert.deepEqual(age, {
    status: 'unavailable',
    name: 'age',
    errorCode: 'PROVIDER_INVALID_OUTPUT',
  });
  assert.equal(
    chatCalls(failed.ollama.calls).some((call) => chatKind(call) === 'revision'),
    false,
  );
});

test('schema-valid refusals are not retried and do not revise', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: sequentialReply(chatFixtures.vocabulary, chatFixtures.refused),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'MODEL_REFUSED');
  assert.equal(chatCalls(ollama.calls).length, 2);
  assert.equal(chatsOf(ollama.calls, 'generation').length, 1);
});

test('no provider call starts after the deadline', async (t) => {
  let n = 0;
  const { response, ollama } = await postDrafts(t, {
    reply: sequentialReply(),
    workflowTimeoutMs: '1000',
    clock: {
      now: () => {
        n += 1;
        return n === 1 ? 0 : 50_000;
      },
      sleep: async () => {},
      random: () => 0,
    },
  });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'WORKFLOW_TIMEOUT');
  assert.equal(ollama.calls.length, 0);
});

test('in-flight work aborts when remaining workflow time elapses', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: () => ({ hang: true }),
    timeoutMs: '5000',
    workflowTimeoutMs: '80',
  });
  assert.equal(response.status, 504);
  assert.match((await response.json()).error.code, /^(WORKFLOW_TIMEOUT|PROVIDER_TIMEOUT)$/);
  assert.equal(chatCalls(ollama.calls).length, 1);
});

test('error body classifies capacity vs overload across status codes', async (t) => {
  const oom = await postDrafts(t, {
    reply: () => ({ status: 503, json: errorBodies.oom }),
  });
  assert.equal(oom.response.status, 503);
  assert.equal((await oom.response.json()).error.code, 'MODEL_CAPACITY');
  assert.equal(chatCalls(oom.ollama.calls).length, 1);

  const busy = await postDrafts(t, {
    reply: () => ({ status: 500, json: errorBodies.overload }),
  });
  assert.equal(busy.response.status, 503);
  assert.equal((await busy.response.json()).error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(chatCalls(busy.ollama.calls).length, 2);
});

test('gateway and generic 500 failures retry; load failures stay terminal', async (t) => {
  for (const status of [500, 502, 504]) {
    const run = await postDrafts(t, {
      reply: () => ({ status, json: { error: 'temporary upstream failure' } }),
    });
    assert.equal(run.response.status, 503);
    assert.equal((await run.response.json()).error.code, 'PROVIDER_UNAVAILABLE');
    assert.equal(chatCalls(run.ollama.calls).length, 2);
  }

  const load = await postDrafts(t, {
    reply: () => ({ status: 500, json: errorBodies.loadFailure }),
  });
  assert.equal(load.response.status, 503);
  assert.equal((await load.response.json()).error.code, 'MODEL_CAPACITY');
  assert.equal(chatCalls(load.ollama.calls).length, 1);

  const notImplemented = await postDrafts(t, {
    reply: () => ({ status: 501, json: { error: 'busy' } }),
  });
  assert.equal(notImplemented.response.status, 503);
  assert.equal((await notImplemented.response.json()).error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(chatCalls(notImplemented.ollama.calls).length, 1);
});

test('exhausted provider budget prevents the next attempt', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: sequentialReply(),
    maxProviderRequests: 1,
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_BUDGET_EXHAUSTED');
  assert.equal(chatCalls(ollama.calls).length, 1);
  assert.equal(chatsOf(ollama.calls, 'generation').length, 0);
});

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
