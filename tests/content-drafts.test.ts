import assert from 'node:assert/strict';
import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import {
  EXERCISES_PROMPT_VERSION,
  GENERATION_TEMPERATURE,
  VOCABULARY_PROMPT_VERSION,
} from '../src/content/generate.ts';
import { generationResultSchema, vocabularySchema } from '../src/content/schemas.ts';
import { LETTER_PRESENCE_ISSUE } from '../src/content/validation.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';
import {
  chatEnvelope,
  chatFixtures,
  errorBodies,
  generatedContent,
  vocabularyContent,
} from './fixtures/ollama.ts';

const teacherRequest = {
  ageYears: 7,
  targetSounds: ['р', 'л'],
  difficulty: 'easy',
  theme: 'тварини',
  exerciseCount: 2,
  teacherInstructions: 'Короткі слова та прості фрази.',
};

type OllamaCall = { method: string; url: string; body: unknown };
type OllamaReply =
  | { hang: true }
  | { hangBody: true }
  | { status: number; json?: unknown; raw?: string };

async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function fakeOllama(
  t: { after: (fn: () => Promise<void> | void) => void },
  reply: (call: OllamaCall) => OllamaReply,
) {
  const calls: OllamaCall[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const call: OllamaCall = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const result = reply(call);
      if ('hang' in result) return;
      if ('hangBody' in result) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        return;
      }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(result.raw ?? JSON.stringify(result.json ?? {}));
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => shutDown(server, 50));
  const address = server.address() as AddressInfo;
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

async function postDrafts(
  t: { after: (fn: () => Promise<void> | void) => void },
  options: {
    reply?: (call: OllamaCall) => OllamaReply;
    body?: unknown;
    token?: string | null;
    timeoutMs?: string;
    log?: ReturnType<typeof createLogger>;
  },
) {
  const ollama = await fakeOllama(
    t,
    options.reply ?? (() => ({ status: 500, json: { error: 'unused' } })),
  );
  const chunks: string[] = [];
  const logger =
    options.log ??
    createLogger('info', {
      write(msg) {
        chunks.push(msg);
      },
    });
  const config = loadConfig({
    SERVICE_TOKEN: 'test-token',
    OLLAMA_BASE_URL: ollama.url,
    LLM_ATTEMPT_TIMEOUT_MS: options.timeoutMs ?? '2000',
  });
  const { server, url } = await listen(createApp({ config, logger }));
  t.after(() => shutDown(server, 50));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? 'test-token'}`;
  const response = await fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? teacherRequest),
  });
  return { response, ollama, logs: chunks.join('\n') };
}

function chatCalls(calls: OllamaCall[]) {
  return calls.filter((call) => call.method === 'POST' && call.url === '/api/chat');
}

function userJson(call: OllamaCall) {
  const payload = call.body as { messages: Array<{ content: string }> };
  return JSON.parse(payload.messages[1]?.content ?? '{}') as unknown;
}

function completedAttempts(logs: string) {
  return logs
    .split('\n')
    .filter((line) => line.includes('llm attempt completed'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function runtimeReply(json: unknown): (call: OllamaCall) => OllamaReply {
  return (call) => {
    if (call.method === 'GET' && call.url === '/api/version') {
      return { status: 200, json: { version: '0.33.3' } };
    }
    if (call.method === 'GET' && call.url === '/api/tags') {
      return {
        status: 200,
        json: { models: [{ name: 'qwen3:4b-instruct', digest: 'sha256:abc' }] },
      };
    }
    return { status: 200, json };
  };
}

function sequentialReply(
  vocabulary: unknown = chatFixtures.vocabulary,
  generated: unknown = chatFixtures.generated,
): (call: OllamaCall) => OllamaReply {
  let chats = 0;
  const meta = runtimeReply(generated);
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      chats += 1;
      return { status: 200, json: chats === 1 ? vocabulary : generated };
    }
    return meta(call);
  };
}

function afterVocabulary(
  reply: OllamaReply | ((call: OllamaCall) => OllamaReply),
): (call: OllamaCall) => OllamaReply {
  let chats = 0;
  const meta = runtimeReply(chatFixtures.vocabulary);
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      chats += 1;
      if (chats === 1) return { status: 200, json: chatFixtures.vocabulary };
      return typeof reply === 'function' ? reply(call) : reply;
    }
    return meta(call);
  };
}

test('POST /content-drafts maps a generated envelope to approved proposals', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: sequentialReply(),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(generationResultSchema.parse(body).requiresHumanApproval, true);
  assert.equal(body.requestId, response.headers.get('x-request-id'));
  assert.deepEqual(body.checks, [
    { status: 'passed', name: 'content', issues: [LETTER_PRESENCE_ISSUE] },
  ]);
  assert.equal(body.proposals[0].localId, 'proposal-1');
  assert.equal(body.proposals[1].localId, 'proposal-2');
  assert.equal(body.proposals[0].phrase, 'Риба пливе в річці');
  assert.equal('id' in body.proposals[0], false);

  const chats = chatCalls(ollama.calls);
  assert.equal(chats.length, 2);
  const selected = JSON.parse(vocabularyContent) as { items: unknown };
  const vocabulary = vocabularySchema.parse({ items: selected.items });
  assert.deepEqual(userJson(chats[0]), teacherRequest);
  assert.deepEqual(userJson(chats[1]), { request: teacherRequest, vocabulary });
  assert.match(
    (chats[0].body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Select Ukrainian vocabulary/,
  );
  assert.match(
    (chats[1].body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Use the supplied vocabulary in its given form/,
  );

  const [vocabChat, exerciseChat] = chats;
  assert.ok(vocabChat);
  assert.ok(exerciseChat);
  for (const chat of chats) {
    const payload = chat.body as Record<string, unknown>;
    assert.equal(payload.model, 'qwen3:4b-instruct');
    assert.equal(payload.stream, false);
    assert.equal('id' in payload, false);
    assert.equal('request_id' in payload, false);
    const format = payload.format as { oneOf: unknown[] };
    assert.equal(format.oneOf.length, 2);
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

  const completed = completedAttempts(logs);
  assert.equal(completed.length, 2);
  assert.equal(completed[0].step, 'vocabulary');
  assert.equal(completed[0].promptVersion, VOCABULARY_PROMPT_VERSION);
  assert.equal(completed[1].step, 'generation');
  assert.equal(completed[1].promptVersion, EXERCISES_PROMPT_VERSION);
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
  let chats = 0;
  const { response, logs } = await postDrafts(t, {
    reply: (call) => {
      if (call.url === '/api/version' || call.url === '/api/tags') return { status: 500 };
      if (call.url === '/api/chat') {
        chats += 1;
        return {
          status: 200,
          json:
            chats === 1 ? chatFixtures.vocabularyMissingUsage : chatFixtures.generatedMissingUsage,
        };
      }
      return { status: 500, json: { error: 'unused' } };
    },
  });
  assert.equal(response.status, 200);
  const completed = completedAttempts(logs);
  assert.equal(completed.length, 2);
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
  assert.equal(chats.length, 2);
  assert.deepEqual(userJson(chats[1]), {
    request: teacherRequest,
    vocabulary: {
      items: [
        { word: 'риба', targetSound: 'р' },
        { word: 'лис', targetSound: 'л' },
      ],
    },
  });
});

test('invalid generated content is not a successful reviewable result', async (t) => {
  const duplicated = JSON.parse(generatedContent) as {
    status: string;
    proposals: Array<Record<string, unknown>>;
  };
  duplicated.proposals[1] = { ...duplicated.proposals[1], phrase: duplicated.proposals[0]?.phrase };
  const { response, logs } = await postDrafts(t, {
    reply: sequentialReply(
      chatFixtures.vocabulary,
      chatEnvelope({ message: { role: 'assistant', content: JSON.stringify(duplicated) } }),
    ),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  const content = body.checks.find((check: { name: string }) => check.name === 'content');
  assert.equal(body.requiresHumanApproval, false);
  assert.equal(content.status, 'failed');
  assert.deepEqual(
    content.issues
      .filter((item: { severity: string }) => item.severity === 'error')
      .map((item: { code: string }) => item.code),
    ['DUPLICATE_PHRASE'],
  );
  assert.equal(body.proposals.length, 2);
  const logged = JSON.parse(
    logs.split('\n').find((line) => line.includes('content validation failed')) ?? '{}',
  );
  assert.equal(logged.step, 'validation');
  assert.deepEqual(logged.issues, [{ code: 'DUPLICATE_PHRASE', path: 'proposals[1].phrase' }]);
  assert.equal(logs.includes('Риба пливе'), false);
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
  assert.equal('items' in refused, false);
  assert.equal('proposals' in refused, false);
});

test('generation-step provider failure still maps after successful vocabulary', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: afterVocabulary({ status: 503, json: errorBodies.overload }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_UNAVAILABLE');
  assert.equal(chatCalls(ollama.calls).length, 2);
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
  const { server, url } = await listen(createApp({ config, logger: createLogger('silent') }));
  t.after(() => shutDown(server, 50));
  const response = await fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: JSON.stringify(teacherRequest),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'PROVIDER_UNAVAILABLE');
});
