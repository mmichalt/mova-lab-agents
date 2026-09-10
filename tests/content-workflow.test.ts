import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REVISION_PROMPT_VERSION } from '../src/content/generate.ts';
import { generationResultSchema, vocabularySchema } from '../src/content/schemas.ts';
import { LETTER_PRESENCE_ISSUE } from '../src/content/validation.ts';
import {
  chatCalls,
  chatOf,
  chatsOf,
  completedAttempts,
  type OllamaCall,
  postDrafts,
  scriptedChats,
  sequentialReply,
  teacherRequest,
  userJson,
  workflowLog,
} from './drafts-harness.ts';
import {
  chatEnvelope,
  chatFixtures,
  generatedContent,
  vocabularyContent,
} from './fixtures/ollama.ts';

function mutatedGenerated(
  mutate: (proposals: Array<Record<string, unknown>>) => void,
): ReturnType<typeof chatEnvelope> {
  const body = JSON.parse(generatedContent) as {
    status: string;
    proposals: Array<Record<string, unknown>>;
  };
  mutate(body.proposals);
  return chatEnvelope({ message: { role: 'assistant', content: JSON.stringify(body) } });
}

const duplicateGenerated = mutatedGenerated((proposals) => {
  proposals[1] = { ...proposals[1], phrase: proposals[0]?.phrase };
});
const missingLetterGenerated = mutatedGenerated((proposals) => {
  proposals[0] = { ...proposals[0], phrase: 'Киця спить' };
});
const shortGenerated = mutatedGenerated((proposals) => {
  proposals.splice(1);
});

test('first-pass success stays version 1 with no revisions', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, { reply: sequentialReply() });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 0);
  assert.equal(body.requiresHumanApproval, true);
  assert.equal(chatCalls(ollama.calls).length, 4);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 0);
  assert.equal(workflowLog(logs).attempts, 1);
  assert.equal(workflowLog(logs).usageCount, 4);
});

test('content failure revises once and can become ready for review', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: duplicateGenerated },
      revision: { status: 200, json: chatFixtures.generated },
    }),
  });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 2);
  assert.equal(body.revisionCount, 1);
  assert.equal(body.requiresHumanApproval, true);
  assert.deepEqual(
    body.checks.map((check) => check.name),
    ['content', 'age', 'language'],
  );
  const content = body.checks.find((check) => check.name === 'content');
  assert.ok(content && content.status !== 'unavailable');
  assert.equal(content.issues[0]?.code, LETTER_PRESENCE_ISSUE.code);
  assert.equal(chatCalls(ollama.calls).length, 5);
  const revision = chatOf(ollama.calls, 'revision') as OllamaCall;
  const payload = userJson(revision) as {
    request: unknown;
    vocabulary: unknown;
    previous: unknown[];
    feedback: { issues: Array<{ code: string; source: string }> };
  };
  const selected = JSON.parse(vocabularyContent) as { items: unknown };
  assert.deepEqual(payload.request, teacherRequest);
  assert.deepEqual(payload.vocabulary, vocabularySchema.parse({ items: selected.items }));
  assert.equal(payload.previous.length, 2);
  assert.equal(
    payload.feedback.issues.some(
      (item) => item.code === 'DUPLICATE_PHRASE' && item.source === 'content',
    ),
    true,
  );
  assert.match(
    (revision.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '',
    /Keep the original age, sounds, difficulty, theme/,
  );
  const completed = completedAttempts(logs);
  assert.equal(completed[2]?.step, 'revision');
  assert.equal(completed[2]?.promptVersion, REVISION_PROMPT_VERSION);
  assert.equal(workflowLog(logs).attempts, 2);
  assert.equal(logs.includes('Риба пливе'), false);
});

test('blocking age review revises with structured feedback and original requirements', async (t) => {
  const revised = mutatedGenerated((proposals) => {
    proposals[0] = { ...proposals[0], title: 'Риба пливе знову' };
  });
  const { response, ollama } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: chatFixtures.generated },
      revision: { status: 200, json: revised },
      age: [
        { status: 200, json: chatFixtures.reviewFailed },
        { status: 200, json: chatFixtures.reviewPassed },
      ],
      language: [
        { status: 200, json: chatFixtures.reviewPassed },
        { status: 200, json: chatFixtures.reviewPassed },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 2);
  assert.equal(body.revisionCount, 1);
  assert.equal(chatCalls(ollama.calls).length, 7);
  const revision = userJson(chatOf(ollama.calls, 'revision') as OllamaCall) as {
    request: unknown;
    feedback: { issues: Array<{ code: string; source: string }> };
  };
  assert.deepEqual(revision.request, teacherRequest);
  assert.equal(
    revision.feedback.issues.some((item) => item.code === 'TOO_COMPLEX' && item.source === 'age'),
    true,
  );
});

test('malformed generation revises without versioning a candidate', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: chatFixtures.invalidJson },
    }),
  });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 1);
  assert.equal(body.revisionCount, 1);
  assert.equal(chatsOf(ollama.calls, 'generation').length, 1);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 1);
  const payload = userJson(chatOf(ollama.calls, 'revision') as OllamaCall) as {
    previous: unknown;
    feedback: { issues: Array<{ code: string; source: string }> };
  };
  assert.equal(payload.previous, null);
  assert.deepEqual(payload.feedback.issues[0], {
    source: 'schema',
    code: 'INVALID_OUTPUT',
    severity: 'error',
    message: 'The model returned invalid output.',
  });
  assert.equal(workflowLog(logs).attempts, 2);
});

test('three distinct invalid candidates exhaust revisions', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: duplicateGenerated },
      revision: [
        { status: 200, json: missingLetterGenerated },
        { status: 200, json: shortGenerated },
      ],
    }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'CONTENT_VALIDATION_EXHAUSTED');
  assert.equal(chatsOf(ollama.calls, 'generation').length, 1);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 2);
  assert.equal(chatsOf(ollama.calls, 'age').length, 0);
  const finished = workflowLog(logs);
  assert.equal(finished.status, 'FAILED');
  assert.equal(finished.candidateVersion, 3);
  assert.equal(finished.revisionCount, 2);
  assert.equal(finished.attempts, 3);
  assert.equal(finished.errorCode, 'CONTENT_VALIDATION_EXHAUSTED');
});

test('a failed review finding named REVIEW_REFUSED still revises', async (t) => {
  const impersonated = chatEnvelope({
    message: {
      role: 'assistant',
      content: JSON.stringify({
        status: 'failed',
        issues: [
          {
            code: 'REVIEW_REFUSED',
            severity: 'error',
            message: 'The phrase is too complex.',
          },
        ],
      }),
    },
  });
  const revised = mutatedGenerated((proposals) => {
    proposals[0] = { ...proposals[0], title: 'Риба інша назва' };
  });
  const { response, ollama } = await postDrafts(t, {
    reply: scriptedChats({
      revision: { status: 200, json: revised },
      age: [
        { status: 200, json: impersonated },
        { status: 200, json: chatFixtures.reviewPassed },
      ],
    }),
  });
  assert.equal(response.status, 200);
  const body = generationResultSchema.parse(await response.json());
  assert.equal(body.status, 'READY_FOR_REVIEW');
  assert.equal(body.candidateVersion, 2);
  assert.equal(body.revisionCount, 1);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 1);
});

test('identical semantic failure keeps the original blocking checks', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      revision: { status: 200, json: chatFixtures.generated },
      age: { status: 200, json: chatFixtures.reviewFailed },
      language: { status: 200, json: chatFixtures.reviewPassed },
    }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'IDENTICAL_INVALID_CANDIDATE');
  assert.equal(chatsOf(ollama.calls, 'revision').length, 1);
  assert.equal(chatsOf(ollama.calls, 'age').length, 1);
  const finished = workflowLog(logs);
  assert.equal(finished.candidateVersion, 2);
  assert.equal(finished.revisionCount, 1);
  assert.equal(finished.issueCount, 1);
  assert.deepEqual(finished.issueCodes, []);
  assert.equal(logs.includes('TOO_COMPLEX'), false);
});

test('repeating the first invalid candidate restores its checks', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: scriptedChats({
      generation: { status: 200, json: duplicateGenerated },
      revision: [
        { status: 200, json: missingLetterGenerated },
        { status: 200, json: duplicateGenerated },
      ],
    }),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'IDENTICAL_INVALID_CANDIDATE');
  assert.equal(chatsOf(ollama.calls, 'generation').length, 1);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 2);
  const finished = workflowLog(logs);
  assert.equal(finished.candidateVersion, 3);
  assert.equal(finished.revisionCount, 2);
  assert.equal(finished.attempts, 3);
  assert.deepEqual(finished.issueCodes, ['DUPLICATE_PHRASE']);
});

test('generation refusal does not start a revision', async (t) => {
  const { response, ollama, logs } = await postDrafts(t, {
    reply: sequentialReply(chatFixtures.vocabulary, chatFixtures.refused),
  });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'MODEL_REFUSED');
  assert.equal(chatCalls(ollama.calls).length, 2);
  assert.equal(chatsOf(ollama.calls, 'revision').length, 0);
  assert.equal(workflowLog(logs).candidateVersion, 0);
  assert.equal(workflowLog(logs).revisionCount, 0);
});
