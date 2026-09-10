import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import {
  EXERCISES_PROMPT_VERSION,
  GENERATION_TEMPERATURE,
  VOCABULARY_PROMPT_VERSION,
} from '../src/content/generate.ts';
import { AGE_PROMPT_VERSION, LANGUAGE_PROMPT_VERSION } from '../src/content/review.ts';
import { generationResultSchema, vocabularySchema } from '../src/content/schemas.ts';
import { LETTER_PRESENCE_ISSUE } from '../src/content/validation.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';
import {
  afterVocabulary,
  chatCalls,
  chatKind,
  chatOf,
  completedAttempts,
  instantClock,
  listen,
  type OllamaCall,
  type OllamaReply,
  postDrafts,
  reviewReply,
  runtimeReply,
  scriptedChats,
  sequentialReply,
  teacherRequest,
  userJson,
} from './drafts-harness.ts';
import {
  chatEnvelope,
  chatFixtures,
  errorBodies,
  generatedContent,
  vocabularyContent,
} from './fixtures/ollama.ts';

test('POST /content-drafts maps a generated envelope to approved proposals', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: sequentialReply(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(generationResultSchema.parse(body).requiresHumanApproval, true);
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 0);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.deepEqual(body.checks, [
    { status: 'passed', name: 'content', issues: [LETTER_PRESENCE_ISSUE] },
    { status: 'passed', name: 'age', issues: [] },
    { status: 'passed', name: 'language', issues: [] },
  ]);
  assert.equal(body.proposals[0].localId, 'proposal-1');
  assert.equal(body.proposals[1].localId, 'proposal-2');
  assert.equal(body.proposals[0].phrase, 'Риба пливе в річці');
  assert.equal('id' in body.proposals[0], false);

  const chats = chatCalls(ollama.calls);
  assert.equal(chats.length, 4);
  const vocabChat = chatOf(ollama.calls, 'vocabulary');
  const exerciseChat = chatOf(ollama.calls, 'generation');
  const ageChat = chatOf(ollama.calls, 'age');
  const languageChat = chatOf(ollama.calls, 'language');
  assert.ok(vocabChat);
  assert.ok(exerciseChat);
  assert.ok(ageChat);
  assert.ok(languageChat);
  const selected = JSON.parse(vocabularyContent) as { items: unknown };
  const vocabulary = vocabularySchema.parse({ items: selected.items });
  const generated = JSON.parse(generatedContent) as { proposals: unknown };
  assert.deepEqual(userJson(vocabChat), teacherRequest);
  assert.deepEqual(userJson(exerciseChat), { request: teacherRequest, vocabulary });
  assert.deepEqual(userJson(ageChat), { request: teacherRequest, proposals: generated.proposals });
  assert.deepEqual(userJson(languageChat), {
    request: teacherRequest,
    proposals: generated.proposals,
  });
  assert.equal('checks' in (userJson(ageChat) as object), false);
  assert.equal('verdict' in (userJson(languageChat) as object), false);
  assert.match(
    (vocabChat.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Select Ukrainian vocabulary/,
  );
  assert.match(
    (exerciseChat.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Use the supplied vocabulary in its given form/,
  );
  assert.match(
    (ageChat.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /requested child age/,
  );
  assert.match(
    (languageChat.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Ukrainian wording and theme/,
  );

  for (const chat of chats) {
    const payload = chat.body as Record<string, unknown>;
    assert.equal(payload.model, 'qwen3:4b-instruct');
    assert.equal(payload.stream, false);
    assert.equal('id' in payload, false);
    assert.equal('request_id' in payload, false);
    const format = payload.format as { oneOf: unknown[] };
    assert.equal(
      format.oneOf.length,
      chatKind(chat) === 'age' || chatKind(chat) === 'language' ? 3 : 2,
    );
    assert.deepEqual(payload.options, {
      temperature: GENERATION_TEMPERATURE,
      num_ctx: 4096,
      num_predict: 2000,
    });
  }
  const vocabFormat = (
    vocabChat.body as { format: { oneOf: Array<{ properties: Record<string, unknown> }> } }
  ).format;
  assert.ok('items' in vocabFormat.oneOf[0].properties);
  const exerciseFormat = (
    exerciseChat.body as { format: { oneOf: Array<{ properties: Record<string, unknown> }> } }
  ).format;
  assert.ok('proposals' in exerciseFormat.oneOf[0].properties);
  const ageFormat = (
    ageChat.body as { format: { oneOf: Array<{ properties: Record<string, unknown> }> } }
  ).format;
  assert.ok('issues' in ageFormat.oneOf[0].properties);

  const completed = completedAttempts(logs);
  assert.equal(completed.length, 4);
  assert.equal(completed[0].step, 'vocabulary');
  assert.equal(completed[0].promptVersion, VOCABULARY_PROMPT_VERSION);
  assert.equal(completed[1].step, 'generation');
  assert.equal(completed[1].promptVersion, EXERCISES_PROMPT_VERSION);
  const reviewLogs = completed.filter(
    (logged) => logged.step === 'age' || logged.step === 'language',
  );
  assert.equal(reviewLogs.length, 2);
  assert.equal(
    reviewLogs.find((logged) => logged.step === 'age')?.promptVersion,
    AGE_PROMPT_VERSION,
  );
  assert.equal(
    reviewLogs.find((logged) => logged.step === 'language')?.promptVersion,
    LANGUAGE_PROMPT_VERSION,
  );
  for (const logged of completed) {
    assert.match(String(logged.attemptId), /^[\da-f-]{36}$/i);
    assert.equal(logged.model, 'qwen3:4b-instruct');
    assert.equal(logged.modelDigest, 'sha256:abc');
    assert.equal(logged.ollamaVersion, '0.33.3');
    assert.equal(logged.loadDurationNs, 12);
    assert.equal('providerRequestId' in logged, false);
    assert.equal('id' in logged, false);
    assert.equal('content' in logged, false);
    assert.equal('items' in logged, false);
    assert.equal('proposals' in logged, false);
    assert.deepEqual(logged.usage, {
      model: 'qwen3:4b-instruct',
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 20,
      estimatedCostUsd: null,
    });
  }
  assert.equal(logs.includes('риба'), false);
  assert.equal(logs.includes('Риба пливе'), false);
});

test('missing usage and runtime metadata stay null', async (t) => {
  const { response, logs } = await postDrafts(t, {
    reply: (call) => {
      if (call.url === '/api/version' || call.url === '/api/tags') return { status: 500 };
      if (call.url === '/api/chat') {
        const kind = chatKind(call);
        const json =
          kind === 'vocabulary'
            ? chatFixtures.vocabularyMissingUsage
            : kind === 'generation'
              ? chatFixtures.generatedMissingUsage
              : chatFixtures.reviewMissingUsage;
        return { status: 200, json };
      }
      return { status: 500, json: { error: 'unused' } };
    },
  });
  assert.equal(response.status, 200);
  const completed = completedAttempts(logs);
  assert.equal(completed.length, 4);
  for (const logged of completed) {
    assert.equal(logged.modelDigest, null);
    assert.equal(logged.ollamaVersion, null);
    assert.equal(logged.loadDurationNs, null);
    assert.equal('providerRequestId' in logged, false);
    assert.deepEqual(logged.usage, {
      model: 'qwen3:4b-instruct',
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
    });
  }
});

test('invalid requests and missing tokens never call the provider', async (t) => {
  const invalid = await postDrafts(t, {
    body: { ageYears: 7, patientId: 'child-1' },
  });
  assert.equal(invalid.response.status, 400);
  assert.equal((await invalid.response.json()).error.code, 'VALIDATION_ERROR');
  assert.equal(invalid.ollama.calls.length, 0);

  const unauthorized = await postDrafts(t, { token: null });
  assert.equal(unauthorized.response.status, 401);
  assert.equal(unauthorized.ollama.calls.length, 0);
});

test('failed vocabulary selection does not generate exercises', async (t) => {
  const cases = [
    { name: 'refused', reply: chatFixtures.refusedVocabulary, status: 422, code: 'MODEL_REFUSED' },
    {
      name: 'invalid json',
      reply: chatFixtures.invalidJson,
      status: 502,
      code: 'PROVIDER_INVALID_OUTPUT',
    },
    {
      name: 'wrong sounds',
      reply: chatEnvelope({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            status: 'selected',
            items: [{ word: 'риба', targetSound: 'р' }],
          }),
        },
      }),
      status: 502,
      code: 'PROVIDER_INVALID_OUTPUT',
    },
    {
      name: 'unusable tokens',
      reply: chatEnvelope({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            status: 'selected',
            items: [
              { word: '!!!', targetSound: 'р' },
              { word: '...', targetSound: 'л' },
            ],
          }),
        },
      }),
      status: 502,
      code: 'PROVIDER_INVALID_OUTPUT',
    },
  ];
  for (const { reply, status, code } of cases) {
    const { response, ollama } = await postDrafts(t, { reply: runtimeReply(reply) });
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.code, code);
    assert.equal(chatCalls(ollama.calls).length, 1);
  }
});

test('generation receives the validated vocabulary, not the raw model string', async (t) => {
  const padded = chatEnvelope({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        status: 'selected',
        items: [
          { word: '  риба  ', targetSound: 'р' },
          { word: ' лис ', targetSound: 'л' },
        ],
      }),
    },
  });
  const { response, ollama } = await postDrafts(t, {
    reply: sequentialReply(padded),
  });
  assert.equal(response.status, 200);
  const chats = chatCalls(ollama.calls);
  assert.equal(chats.length, 4);
  assert.deepEqual(userJson(chatOf(ollama.calls, 'generation') as OllamaCall), {
    request: teacherRequest,
    vocabulary: {
      items: [
        { word: 'риба', targetSound: 'р' },
        { word: 'лис', targetSound: 'л' },
      ],
    },
  });
});

test('invalid generated content skips semantic review and stops on a repeated candidate', async (t) => {
  const duplicated = JSON.parse(generatedContent) as {
    status: string;
    proposals: Array<Record<string, unknown>>;
  };
  duplicated.proposals[1] = { ...duplicated.proposals[1], phrase: duplicated.proposals[0]?.phrase };
  const invalid = chatEnvelope({
    message: { role: 'assistant', content: JSON.stringify(duplicated) },
  });
  const { response, ollama, logs } = await postDrafts(t, {
    reply: sequentialReply(chatFixtures.vocabulary, invalid),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'IDENTICAL_INVALID_CANDIDATE');
  assert.equal(chatCalls(ollama.calls).length, 3);
  assert.equal(chatKind(chatCalls(ollama.calls)[1] as OllamaCall), 'generation');
  assert.equal(chatKind(chatCalls(ollama.calls)[2] as OllamaCall), 'revision');
  assert.equal(
    chatCalls(ollama.calls).some((call) => chatKind(call) === 'age'),
    false,
  );
  assert.equal(
    chatCalls(ollama.calls).some((call) => chatKind(call) === 'language'),
    false,
  );
  const logged = JSON.parse(
    logs.split('\n').find((line) => line.includes('content validation failed')) ?? '{}',
  );
  assert.equal(logged.step, 'validation');
  assert.deepEqual(logged.issues, [{ code: 'DUPLICATE_PHRASE', path: 'proposals[1].phrase' }]);
  assert.equal(logs.includes('Риба пливе'), false);
});

test('refused review is failed, not a pass, and the other review is kept', async (t) => {
  const echoed = chatEnvelope({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        status: 'refused',
        reason: 'Cannot judge «Риба пливе в річці».',
      }),
    },
  });
  const { response, ollama, logs } = await postDrafts(t, {
    reply: reviewReply({
      age: { status: 200, json: echoed },
      language: { status: 200, json: chatFixtures.reviewPassed },
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 0);
  assert.equal(body.requiresHumanApproval, false);
  const age = body.checks.find((check: { name: string }) => check.name === 'age');
  const language = body.checks.find((check: { name: string }) => check.name === 'language');
  assert.equal(age.status, 'failed');
  assert.equal(age.issues[0].code, 'REVIEW_REFUSED');
  assert.equal(age.issues[0].source, 'application');
  assert.equal(language.status, 'passed');
  assert.equal(
    chatCalls(ollama.calls).some((call) => chatKind(call) === 'revision'),
    false,
  );
  const refused = JSON.parse(
    logs.split('\n').find((line) => line.includes('model refused') && line.includes('"age"')) ??
      '{}',
  );
  assert.equal(refused.step, 'age');
  assert.equal(refused.promptVersion, AGE_PROMPT_VERSION);
  assert.equal('reason' in refused, false);
  assert.equal(logs.includes('Риба пливе'), false);
});

test('unavailable age review keeps language feedback and cannot pass', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: reviewReply({
      age: { hang: true },
      language: { status: 200, json: chatFixtures.reviewPassed },
    }),
    timeoutMs: '80',
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 0);
  assert.equal(body.requiresHumanApproval, false);
  const age = body.checks.find((check: { name: string }) => check.name === 'age');
  const language = body.checks.find((check: { name: string }) => check.name === 'language');
  assert.deepEqual(age, { status: 'unavailable', name: 'age', errorCode: 'PROVIDER_TIMEOUT' });
  assert.equal(language.status, 'passed');
  assert.equal(
    chatCalls(ollama.calls).some((call) => chatKind(call) === 'revision'),
    false,
  );
});

test('both unavailable reviews block success', async (t) => {
  const { response, ollama } = await postDrafts(t, {
    reply: scriptedChats({
      age: [
        { status: 503, json: errorBodies.overload },
        { status: 503, json: errorBodies.overload },
      ],
      language: [
        { status: 200, json: chatFixtures.invalidJson },
        { status: 200, json: chatFixtures.invalidJson },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.status, 'FAILED');
  assert.equal(body.requiresHumanApproval, false);
  assert.equal(
    chatCalls(ollama.calls).some((call) => chatKind(call) === 'revision'),
    false,
  );
  assert.deepEqual(
    body.checks.filter((check: { name: string }) => check.name !== 'content'),
    [
      { status: 'unavailable', name: 'age', errorCode: 'PROVIDER_UNAVAILABLE' },
      { status: 'unavailable', name: 'language', errorCode: 'PROVIDER_INVALID_OUTPUT' },
    ],
  );
});

test('generation-step refusal still maps after successful vocabulary', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: afterVocabulary({ status: 200, json: chatFixtures.refused }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'MODEL_REFUSED');
  assert.equal(chatCalls(ollama.calls).length, 2);
  const refused = JSON.parse(
    logs.split('\n').find((line) => line.includes('model refused')) ?? '{}',
  );
  assert.equal(refused.step, 'generation');
  assert.equal(refused.promptVersion, EXERCISES_PROMPT_VERSION);
  assert.equal('reason' in refused, false);
  assert.equal('items' in refused, false);
  assert.equal('proposals' in refused, false);
});

test('generation-step provider failure still maps after successful vocabulary', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: afterVocabulary({ status: 503, json: errorBodies.overload }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(chatCalls(ollama.calls).length, 3);
  const failed = JSON.parse(
    logs.split('\n').find((line) => line.includes('llm attempt failed')) ?? '{}',
  );
  assert.equal(failed.step, 'generation');
  assert.equal(failed.promptVersion, EXERCISES_PROMPT_VERSION);
});

test('vocabulary failure logs identify the step without raw words', async (t) => {
  const timeout = await postDrafts(t, {
    reply: () => ({ hang: true }),
    timeoutMs: '80',
  });
  assert.equal(timeout.response.status, 504);
  const failed = JSON.parse(
    timeout.logs.split('\n').find((line) => line.includes('llm attempt failed')) ?? '{}',
  );
  assert.equal(failed.step, 'vocabulary');
  assert.equal(failed.promptVersion, VOCABULARY_PROMPT_VERSION);
  assert.equal(chatCalls(timeout.ollama.calls).length, 1);

  const invalid = await postDrafts(t, {
    reply: runtimeReply(
      chatEnvelope({
        message: {
          role: 'assistant',
          content: JSON.stringify({
            status: 'selected',
            items: [{ word: 'риба', targetSound: 'р' }],
          }),
        },
      }),
    ),
  });
  assert.equal(invalid.response.status, 502);
  const logged = JSON.parse(
    invalid.logs.split('\n').find((line) => line.includes('invalid vocabulary')) ?? '{}',
  );
  assert.equal(logged.step, 'vocabulary');
  assert.equal(logged.promptVersion, VOCABULARY_PROMPT_VERSION);
  assert.equal(invalid.logs.includes('риба'), false);
});

const outcomeCases: Array<{
  name: string;
  reply: OllamaReply | ((call: OllamaCall) => OllamaReply);
  status: number;
  code: string;
  timeoutMs?: string;
}> = [
  {
    name: 'schema-valid refusal',
    reply: { status: 200, json: chatFixtures.refused },
    status: 422,
    code: 'MODEL_REFUSED',
  },
  {
    name: 'free-text refusal',
    reply: { status: 200, json: chatFixtures.freeText },
    status: 502,
    code: 'PROVIDER_INVALID_OUTPUT',
  },
  {
    name: 'invalid JSON content',
    reply: { status: 200, json: chatFixtures.invalidJson },
    status: 502,
    code: 'PROVIDER_INVALID_OUTPUT',
  },
  {
    name: 'wrong shape',
    reply: { status: 200, json: chatFixtures.wrongShape },
    status: 502,
    code: 'PROVIDER_INVALID_OUTPUT',
  },
  {
    name: 'malformed envelope',
    reply: { status: 200, json: chatFixtures.malformedEnvelope },
    status: 502,
    code: 'PROVIDER_INVALID_OUTPUT',
  },
  {
    name: 'truncated output',
    reply: { status: 200, json: chatFixtures.truncated },
    status: 502,
    code: 'PROVIDER_INCOMPLETE',
  },
  {
    name: 'incomplete output',
    reply: { status: 200, json: chatFixtures.incomplete },
    status: 502,
    code: 'PROVIDER_INCOMPLETE',
  },
  {
    name: 'unexpected tool call',
    reply: { status: 200, json: chatFixtures.toolCall },
    status: 502,
    code: 'PROVIDER_UNEXPECTED_TOOL_CALL',
  },
  {
    name: 'missing model',
    reply: { status: 404, json: errorBodies.missingModel },
    status: 503,
    code: 'MODEL_UNAVAILABLE',
  },
  {
    name: 'model load failure',
    reply: { status: 500, json: errorBodies.loadFailure },
    status: 503,
    code: 'MODEL_CAPACITY',
  },
  {
    name: 'model OOM',
    reply: { status: 500, json: errorBodies.oom },
    status: 503,
    code: 'MODEL_CAPACITY',
  },
  {
    name: 'unsupported settings',
    reply: { status: 400, json: errorBodies.unsupportedSettings },
    status: 503,
    code: 'MODEL_CAPACITY',
  },
  {
    name: 'provider overload',
    reply: { status: 503, json: errorBodies.overload },
    status: 503,
    code: 'PROVIDER_UNAVAILABLE',
  },
  {
    name: 'oversized response body',
    reply: { status: 200, raw: 'x'.repeat(1024 * 1024 + 1) },
    status: 502,
    code: 'PROVIDER_INVALID_OUTPUT',
  },
  {
    name: 'abort before headers',
    reply: { hang: true },
    status: 504,
    code: 'PROVIDER_TIMEOUT',
    timeoutMs: '80',
  },
  {
    name: 'stalled response body',
    reply: { hangBody: true },
    status: 504,
    code: 'PROVIDER_TIMEOUT',
    timeoutMs: '80',
  },
];

for (const { name, reply, status, code, timeoutMs } of outcomeCases) {
  test(`POST /content-drafts maps ${name}`, async (t) => {
    const { response } = await postDrafts(t, {
      reply: typeof reply === 'function' ? reply : () => reply,
      timeoutMs,
    });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
    assert.equal(JSON.stringify(body).includes('stack'), false);
  });
}

test('unreachable Ollama is unavailable', async (t) => {
  const config = loadConfig({
    SERVICE_TOKEN: 'test-token',
    OLLAMA_BASE_URL: 'http://127.0.0.1:9',
    LLM_ATTEMPT_TIMEOUT_MS: '200',
  });
  const { server, url } = await listen(
    createApp({ config, logger: createLogger('silent'), clock: instantClock() }),
  );
  t.after(() => shutDown(server, 50));
  const response = await fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_UNAVAILABLE');
});
