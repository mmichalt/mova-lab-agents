import assert from 'node:assert/strict';
import { test } from 'node:test';
import { supervisorActionSchema } from '../src/content/supervisor.ts';
import { EXPECTED_CONSTRAINTS, GENERATION_CONTRACT_VERSION } from '../src/tools/mova-lab.ts';
import type { OllamaReply } from './drafts-harness.ts';
import { chatsOf, postDrafts, scriptedChats } from './drafts-harness.ts';
import { chatEnvelope, chatFixtures, generatedContent } from './fixtures/ollama.ts';

function action(action: string, args: Record<string, unknown> = {}): OllamaReply {
  return {
    status: 200,
    json: chatEnvelope({
      message: { role: 'assistant', content: JSON.stringify({ action, args }) },
    }),
  };
}

test('supervisor completes a bounded path and keeps approval code-controlled', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({
      supervisor: [action('vocabulary'), action('generate'), action('finish')],
    }),
  });

  assert.equal(result.response.status, 200);
  const body = await result.response.json();
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.requiresHumanApproval, true);
  assert.equal(chatsOf(result.ollama.calls, 'supervisor').length, 3);
  assert.equal(chatsOf(result.ollama.calls, 'generation').length, 1);
  assert.equal(chatsOf(result.ollama.calls, 'age').length, 1);
  assert.equal(chatsOf(result.ollama.calls, 'language').length, 1);
});

test('supervisor can search before selecting and generating content', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    movaLabReply: (call) =>
      call.url.startsWith('/api/internal/content-generation/recording-exercises/search')
        ? { status: 200, json: { version: GENERATION_CONTRACT_VERSION, hasMore: false, items: [] } }
        : { status: 200, json: EXPECTED_CONSTRAINTS },
    reply: scriptedChats({
      supervisor: [
        action('search', { q: 'риба', limit: 1 }),
        action('vocabulary'),
        action('generate'),
        action('finish'),
      ],
    }),
  });

  assert.equal(result.response.status, 200);
  assert.equal((await result.response.json()).status, 'READY_FOR_REVIEW');
  assert.equal(
    result.movaLab.calls.filter((call) =>
      call.url.startsWith('/api/internal/content-generation/recording-exercises/search'),
    ).length,
    1,
  );
});

test('supervisor can revise a failed candidate before finishing', async (t) => {
  const revised = JSON.parse(generatedContent) as {
    proposals: Array<{ title: string }>;
  };
  revised.proposals[0].title = 'Риба в чистій річці';
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({
      supervisor: [
        action('vocabulary'),
        action('generate'),
        action('finish'),
        action('revise'),
        action('finish'),
      ],
      age: {
        status: 200,
        json: chatFixtures.reviewFailed,
      },
      language: {
        status: 200,
        json: chatFixtures.reviewFailed,
      },
      revision: {
        status: 200,
        json: chatEnvelope({
          message: { role: 'assistant', content: JSON.stringify(revised) },
        }),
      },
    }),
  });

  assert.equal(result.response.status, 200);
  const body = await result.response.json();
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.revisionCount, 1);
  assert.equal(chatsOf(result.ollama.calls, 'revision').length, 1);
});

test('supervisor cannot generate over an existing candidate', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({
      supervisor: [action('vocabulary'), action('generate'), action('generate')],
    }),
  });

  assert.equal(result.response.status, 422);
  assert.equal((await result.response.json()).error.code, 'SUPERVISOR_PREREQUISITE_MISSING');
  assert.equal(chatsOf(result.ollama.calls, 'generation').length, 1);
});

test('supervisor stops at eight decisions', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    movaLabReply: (call) =>
      call.url.startsWith('/api/internal/content-generation/recording-exercises/search')
        ? { status: 200, json: { version: GENERATION_CONTRACT_VERSION, hasMore: false, items: [] } }
        : { status: 200, json: EXPECTED_CONSTRAINTS },
    reply: scriptedChats({
      supervisor: Array.from({ length: 8 }, (_, index) => action('search', { q: `риба-${index}` })),
    }),
  });

  assert.equal(result.response.status, 422);
  assert.equal((await result.response.json()).error.code, 'SUPERVISOR_DECISIONS_EXHAUSTED');
  assert.equal(chatsOf(result.ollama.calls, 'supervisor').length, 8);
});

test('malformed and unknown supervisor actions fail without fallback generation', async (t) => {
  for (const content of ['not json', JSON.stringify({ action: 'unknown', args: {} })]) {
    const result = await postDrafts(t, {
      experimentalSupervisor: true,
      reply: () => ({
        status: 200,
        json: chatEnvelope({ message: { role: 'assistant', content } }),
      }),
    });
    assert.equal(result.response.status, 502);
    assert.equal((await result.response.json()).error.code, 'PROVIDER_INVALID_OUTPUT');
    assert.equal(chatsOf(result.ollama.calls, 'generation').length, 0);
  }
});

test('premature finish is rejected before checks or approval', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({ supervisor: action('finish') }),
  });

  assert.equal(result.response.status, 422);
  assert.equal((await result.response.json()).error.code, 'SUPERVISOR_PREREQUISITE_MISSING');
  assert.equal(chatsOf(result.ollama.calls, 'age').length, 0);
  assert.equal(chatsOf(result.ollama.calls, 'language').length, 0);
});

test('repeated ineffective actions stop the experiment', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({
      supervisor: [action('vocabulary'), action('vocabulary')],
    }),
  });

  assert.equal(result.response.status, 422);
  assert.equal((await result.response.json()).error.code, 'SUPERVISOR_NO_PROGRESS');
  assert.equal(chatsOf(result.ollama.calls, 'generation').length, 0);
});

test('supervisor action selection respects the existing provider budget', async (t) => {
  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    maxProviderRequests: 1,
    reply: scriptedChats({ supervisor: action('vocabulary') }),
  });

  assert.equal(result.response.status, 503);
  assert.equal((await result.response.json()).error.code, 'PROVIDER_BUDGET_EXHAUSTED');
});

test('approval and publication bypass actions are outside the action union', async (t) => {
  assert.equal(supervisorActionSchema.safeParse({ action: 'approve', args: {} }).success, false);
  assert.equal(
    supervisorActionSchema.safeParse({ action: 'finish', args: { approve: true } }).success,
    false,
  );

  const result = await postDrafts(t, {
    experimentalSupervisor: true,
    reply: scriptedChats({ supervisor: action('approve') }),
  });
  assert.equal(result.response.status, 502);
  assert.equal((await result.response.json()).error.code, 'PROVIDER_INVALID_OUTPUT');
  assert.equal(chatsOf(result.ollama.calls, 'generation').length, 0);
});
