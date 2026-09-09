import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { z } from 'zod';
import {
  checkResultSchema,
  contentRequestSchema,
  generatedProposalSchema,
  generationResultSchema,
  limits,
  llmUsageSchema,
  modelOutputSchema,
  recordingProposalSchema,
  reviewOutputSchema,
  validationIssueSchema,
  vocabularyOutputSchema,
  vocabularySchema,
} from '../src/content/schemas.ts';

const examples = new URL('../docs/examples/', import.meta.url);

function schemaObject(value: unknown): Record<string, unknown> {
  assert.equal(typeof value, 'object');
  assert.ok(value !== null && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function schemaProp(schema: Record<string, unknown>, key: string) {
  return schemaObject(schemaObject(schema.properties)[key]);
}

function loadExample(name: string) {
  return JSON.parse(readFileSync(new URL(name, examples), 'utf8')) as unknown;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    ageYears: 7,
    targetSounds: ['р'],
    difficulty: 'easy',
    theme: 'тварини',
    exerciseCount: 6,
    ...overrides,
  };
}

function omit(input: Record<string, unknown>, key: string) {
  const { [key]: _, ...rest } = input;
  return rest;
}

function proposal(overrides: Record<string, unknown> = {}) {
  return {
    type: 'recording',
    title: 'Риба',
    phrase: 'Риба пливе',
    childHint: 'Скажи слово',
    teacherNote: 'Темп повільний',
    targetSound: 'р',
    difficulty: 'easy',
    ...overrides,
  };
}

function recording(overrides: Record<string, unknown> = {}) {
  return { localId: 'proposal-1', ...proposal(), ...overrides };
}

const validRequests: Array<{ name: string; input: unknown; expected: unknown }> = [
  {
    name: 'architecture example with both sounds',
    input: loadExample('content-request.json'),
    expected: {
      ageYears: 7,
      targetSounds: ['р', 'л'],
      difficulty: 'easy',
      theme: 'тварини',
      exerciseCount: 6,
      teacherInstructions: 'Короткі слова та прості фрази.',
    },
  },
  {
    name: 'uppercase Р/Л and repeated sounds',
    input: req({ targetSounds: ['Л', 'р', 'л', 'Р'], exerciseCount: 2 }),
    expected: { ...req({ exerciseCount: 2 }), targetSounds: ['л', 'р'] },
  },
  {
    name: 'trimmed sounds and default exerciseCount',
    input: omit(req({ targetSounds: [' Р ', 'Л'] }), 'exerciseCount'),
    expected: req({ targetSounds: ['р', 'л'] }),
  },
  {
    name: 'single sound with minimum count 1',
    input: req({ exerciseCount: 1 }),
    expected: req({ exerciseCount: 1 }),
  },
  {
    name: 'two sounds with minimum count 2',
    input: req({ targetSounds: ['р', 'л'], exerciseCount: 2 }),
    expected: req({ targetSounds: ['р', 'л'], exerciseCount: 2 }),
  },
  {
    name: 'maximum exerciseCount 12',
    input: req({ exerciseCount: 12 }),
    expected: req({ exerciseCount: 12 }),
  },
  {
    name: 'age and theme boundaries',
    input: req({ ageYears: 1, theme: 'я'.repeat(limits.theme) }),
    expected: req({ ageYears: 1, theme: 'я'.repeat(limits.theme) }),
  },
  {
    name: 'age 18 and omitted instructions',
    input: req({ ageYears: 18 }),
    expected: req({ ageYears: 18 }),
  },
];

const invalidRequests: Array<{ name: string; input: unknown }> = [
  { name: 'missing ageYears', input: omit(req(), 'ageYears') },
  { name: 'missing targetSounds', input: omit(req(), 'targetSounds') },
  { name: 'missing difficulty', input: omit(req(), 'difficulty') },
  { name: 'missing theme', input: omit(req(), 'theme') },
  { name: 'empty targetSounds', input: req({ targetSounds: [] }) },
  { name: 'unsupported sound с', input: req({ targetSounds: ['с'] }) },
  { name: 'latin r', input: req({ targetSounds: ['r'] }) },
  { name: 'non-string targetSounds item', input: req({ targetSounds: [1] }) },
  { name: 'difficulty medium', input: req({ difficulty: 'medium' }) },
  { name: 'difficulty Easy', input: req({ difficulty: 'Easy' }) },
  { name: 'unknown patientId field', input: req({ patientId: 'child-1' }) },
  { name: 'unknown name field', input: req({ name: 'Іван' }) },
  { name: 'ageYears string', input: req({ ageYears: '7' }) },
  { name: 'ageYears 7.5', input: req({ ageYears: 7.5 }) },
  { name: 'ageYears 0', input: req({ ageYears: 0 }) },
  { name: 'ageYears 19', input: req({ ageYears: 19 }) },
  { name: 'targetSounds string', input: req({ targetSounds: 'р' }) },
  { name: 'exerciseCount string', input: req({ exerciseCount: '6' }) },
  { name: 'theme number', input: req({ theme: 1 }) },
  { name: 'blank theme', input: req({ theme: '   ' }) },
  { name: 'empty teacherInstructions', input: req({ teacherInstructions: '' }) },
  { name: 'blank teacherInstructions', input: req({ teacherInstructions: '   ' }) },
  { name: 'theme 121 chars', input: req({ theme: 'я'.repeat(limits.theme + 1) }) },
  {
    name: 'instructions 1001 chars',
    input: req({ teacherInstructions: 'а'.repeat(limits.teacherInstructions + 1) }),
  },
  { name: 'exerciseCount 0', input: req({ exerciseCount: 0 }) },
  { name: 'exerciseCount 13', input: req({ exerciseCount: 13 }) },
  { name: 'count 1 with two sounds', input: req({ targetSounds: ['р', 'л'], exerciseCount: 1 }) },
];

for (const { name, input, expected } of validRequests) {
  test(`request accepts ${name}`, () => {
    assert.deepEqual(contentRequestSchema.parse(input), expected);
  });
}

for (const { name, input } of invalidRequests) {
  test(`request rejects ${name}`, () => {
    assert.equal(contentRequestSchema.safeParse(input).success, false);
  });
}

const validProposal = proposal();
const proposalCases: Array<{ name: string; input: unknown; ok: boolean }> = [
  {
    name: 'recording fields at limits',
    input: proposal({
      title: 'т'.repeat(limits.title),
      phrase: 'ф'.repeat(limits.phrase),
      childHint: 'п'.repeat(limits.childHint),
      teacherNote: 'н'.repeat(limits.teacherNote),
    }),
    ok: true,
  },
  { name: 'empty title', input: proposal({ title: '' }), ok: false },
  { name: 'whitespace-only title', input: proposal({ title: '   ' }), ok: false },
  { name: 'whitespace-only phrase', input: proposal({ phrase: '\n\n' }), ok: false },
  { name: 'title 161 chars', input: proposal({ title: 'т'.repeat(limits.title + 1) }), ok: false },
  {
    name: 'phrase 501 chars',
    input: proposal({ phrase: 'ф'.repeat(limits.phrase + 1) }),
    ok: false,
  },
  {
    name: 'childHint 501 chars',
    input: proposal({ childHint: 'п'.repeat(limits.childHint + 1) }),
    ok: false,
  },
  {
    name: 'teacherNote 1001 chars',
    input: proposal({ teacherNote: 'н'.repeat(limits.teacherNote + 1) }),
    ok: false,
  },
  { name: 'missing phrase', input: omit(proposal(), 'phrase'), ok: false },
  { name: 'type match-image-word', input: proposal({ type: 'match-image-word' }), ok: false },
  { name: 'targetSound с', input: proposal({ targetSound: 'с' }), ok: false },
  { name: 'difficulty hard', input: proposal({ difficulty: 'hard' }), ok: false },
  { name: 'title number', input: proposal({ title: 1 }), ok: false },
];

for (const { name, input, ok } of proposalCases) {
  test(`generated proposal ${ok ? 'accepts' : 'rejects'} ${name}`, () => {
    assert.equal(generatedProposalSchema.safeParse(input).success, ok);
  });
}

const forbiddenProposalKeys = {
  localId: 'proposal-1',
  id: 'cms-1',
  contentId: 'cms-1',
  categoryId: 'cat-1',
  mediaId: 'media-1',
  published: true,
  isPublished: false,
  publicationStatus: 'draft',
};

for (const [key, value] of Object.entries(forbiddenProposalKeys)) {
  test(`model proposal rejects ${key}`, () => {
    assert.equal(generatedProposalSchema.safeParse(proposal({ [key]: value })).success, false);
  });
}

test('model output accepts generated example and schema-valid refusal', () => {
  assert.equal(modelOutputSchema.parse(loadExample('model-output.json')).status, 'generated');
  assert.deepEqual(modelOutputSchema.parse(loadExample('model-output.refused.json')), {
    status: 'refused',
    reason: 'Неможливо скласти вправи для цієї теми в межах easy.',
  });
});

test('vocabulary output accepts selected example and schema-valid refusal', () => {
  assert.deepEqual(vocabularyOutputSchema.parse(loadExample('vocabulary-output.json')), {
    status: 'selected',
    items: [
      { word: 'риба', targetSound: 'р' },
      { word: 'річка', targetSound: 'р' },
      { word: 'лис', targetSound: 'л' },
      { word: 'ліс', targetSound: 'л' },
    ],
  });
  assert.deepEqual(vocabularyOutputSchema.parse(loadExample('vocabulary-output.refused.json')), {
    status: 'refused',
    reason: 'Неможливо дібрати словник для цієї теми в межах easy.',
  });
  assert.deepEqual(
    vocabularySchema.parse({
      items: [{ word: '  риба  ', targetSound: 'р' }],
    }),
    { items: [{ word: 'риба', targetSound: 'р' }] },
  );
});

test('vocabulary output rejects empty items, extra fields, and application IDs', () => {
  assert.equal(vocabularyOutputSchema.safeParse({ status: 'selected', items: [] }).success, false);
  assert.equal(
    vocabularyOutputSchema.safeParse({
      status: 'selected',
      items: [{ word: 'риба', targetSound: 'р', id: 'cms-1' }],
    }).success,
    false,
  );
  assert.equal(
    vocabularyOutputSchema.safeParse({
      status: 'selected',
      items: [{ word: 'риба', targetSound: 'р' }],
      localId: 'x',
    }).success,
    false,
  );
  assert.equal(
    vocabularySchema.safeParse({
      items: [{ word: 'я'.repeat(limits.vocabWord + 1), targetSound: 'р' }],
    }).success,
    false,
  );
});

test('model output rejects publication controls, application IDs, and localId', () => {
  const generated = {
    status: 'generated',
    proposals: [validProposal],
    published: false,
  };
  assert.equal(modelOutputSchema.safeParse(generated).success, false);
  assert.equal(
    modelOutputSchema.safeParse({
      status: 'generated',
      proposals: [proposal({ contentId: 'cms-1' })],
    }).success,
    false,
  );
  assert.equal(
    modelOutputSchema.safeParse({ status: 'refused', reason: 'ні', localId: 'x' }).success,
    false,
  );
});

test('model JSON Schema forbids extra properties and pins field limits', () => {
  const schema = schemaObject(z.toJSONSchema(modelOutputSchema));
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2);
  const generated = schemaObject(schema.oneOf[0]);
  const refused = schemaObject(schema.oneOf[1]);
  assert.equal(generated.additionalProperties, false);
  assert.equal(refused.additionalProperties, false);
  const item = schemaObject(schemaProp(generated, 'proposals').items);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(schemaObject(item.properties)), [
    'type',
    'title',
    'phrase',
    'childHint',
    'teacherNote',
    'targetSound',
    'difficulty',
  ]);
  assert.equal(schemaProp(item, 'title').maxLength, limits.title);
  assert.equal(schemaProp(item, 'phrase').maxLength, limits.phrase);
  assert.equal(schemaProp(item, 'childHint').maxLength, limits.childHint);
  assert.equal(schemaProp(item, 'teacherNote').maxLength, limits.teacherNote);
  assert.equal(schemaProp(refused, 'reason').maxLength, limits.refusalReason);
  assert.equal(schemaProp(generated, 'proposals').maxItems, limits.exerciseCountMax);
});

test('vocabulary JSON Schema forbids extra properties and pins word limits', () => {
  const schema = schemaObject(z.toJSONSchema(vocabularyOutputSchema));
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 2);
  const selected = schemaObject(schema.oneOf[0]);
  const refused = schemaObject(schema.oneOf[1]);
  assert.equal(selected.additionalProperties, false);
  assert.equal(refused.additionalProperties, false);
  const item = schemaObject(schemaProp(selected, 'items').items);
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(Object.keys(schemaObject(item.properties)), ['word', 'targetSound']);
  assert.equal(schemaProp(item, 'word').maxLength, limits.vocabWord);
  assert.equal(schemaProp(selected, 'items').maxItems, limits.vocabItemsMax);
});

test('review output requires a passed, failed, or refused branch', () => {
  assert.deepEqual(reviewOutputSchema.parse(loadExample('review-output.json')), {
    status: 'passed',
    issues: [],
  });
  assert.equal(reviewOutputSchema.parse(loadExample('review-output.failed.json')).status, 'failed');
  assert.equal(
    reviewOutputSchema.parse(loadExample('review-output.refused.json')).status,
    'refused',
  );
  assert.equal(reviewOutputSchema.safeParse({ status: 'failed', issues: [] }).success, false);
  assert.equal(
    reviewOutputSchema.safeParse({ status: 'unavailable', errorCode: 'PROVIDER_TIMEOUT' }).success,
    false,
  );
  assert.equal(
    reviewOutputSchema.safeParse({ status: 'passed', issues: [], extra: true }).success,
    false,
  );
  assert.equal(
    reviewOutputSchema.safeParse({
      status: 'passed',
      issues: [{ code: 'TOO_COMPLEX', severity: 'error', message: 'too hard' }],
    }).success,
    false,
  );
  assert.equal(
    reviewOutputSchema.safeParse({
      status: 'failed',
      issues: [{ code: 'x', severity: 'error', message: 'no', source: 'age' }],
    }).success,
    false,
  );
});

test('review JSON Schema forbids extra properties and pins finding limits', () => {
  const schema = schemaObject(z.toJSONSchema(reviewOutputSchema));
  assert.ok(Array.isArray(schema.oneOf) && schema.oneOf.length === 3);
  const passed = schemaObject(schema.oneOf[0]);
  const failed = schemaObject(schema.oneOf[1]);
  const refused = schemaObject(schema.oneOf[2]);
  assert.equal(passed.additionalProperties, false);
  assert.equal(failed.additionalProperties, false);
  assert.equal(refused.additionalProperties, false);
  const finding = schemaObject(schemaProp(passed, 'issues').items);
  assert.equal(finding.additionalProperties, false);
  assert.deepEqual(Object.keys(schemaObject(finding.properties)), [
    'code',
    'path',
    'severity',
    'message',
  ]);
  assert.equal(schemaProp(finding, 'code').maxLength, limits.findingCode);
  assert.equal(schemaProp(finding, 'message').maxLength, limits.findingMessage);
  assert.equal(schemaProp(finding, 'path').maxLength, limits.findingPath);
  assert.equal(schemaProp(passed, 'issues').maxItems, limits.findingsMax);
  assert.equal(schemaProp(refused, 'reason').maxLength, limits.refusalReason);
});

test('domain proposal requires application-assigned localId', () => {
  assert.equal(recordingProposalSchema.safeParse(validProposal).success, false);
  assert.deepEqual(recordingProposalSchema.parse(recording()), recording());
  assert.equal(recordingProposalSchema.safeParse(recording({ published: true })).success, false);
});

test('validation issues and check results', () => {
  const issue = {
    source: 'content',
    code: 'DUPLICATE_PHRASE',
    path: 'proposals[1].phrase',
    severity: 'error',
    message: 'Duplicate phrase',
  };
  assert.deepEqual(validationIssueSchema.parse(issue), issue);
  assert.equal(validationIssueSchema.safeParse({ ...issue, extra: true }).success, false);
  assert.deepEqual(checkResultSchema.parse({ status: 'passed', name: 'content', issues: [] }), {
    status: 'passed',
    name: 'content',
    issues: [],
  });
  assert.deepEqual(
    checkResultSchema.parse({ status: 'failed', name: 'content', issues: [issue] }).status,
    'failed',
  );
  assert.equal(checkResultSchema.safeParse({ status: 'failed', issues: [] }).success, false);
  assert.deepEqual(
    checkResultSchema.parse({
      status: 'unavailable',
      name: 'language',
      errorCode: 'REVIEW_TIMEOUT',
    }),
    {
      status: 'unavailable',
      name: 'language',
      errorCode: 'REVIEW_TIMEOUT',
    },
  );
  assert.equal(
    checkResultSchema.safeParse({ status: 'unavailable', errorCode: 'x', issues: [] }).success,
    false,
  );
});

test('usage metadata allows null unmeasured values and rejects negatives', () => {
  const usage = {
    model: 'qwen3:4b-instruct',
    inputTokens: 12,
    cachedInputTokens: null,
    outputTokens: 40,
    estimatedCostUsd: null,
  };
  assert.deepEqual(llmUsageSchema.parse(usage), usage);
  assert.equal(llmUsageSchema.safeParse({ ...usage, inputTokens: -1 }).success, false);
  assert.equal(
    llmUsageSchema.safeParse({ ...usage, estimatedCostUsd: 0.01, extra: 1 }).success,
    false,
  );
});

test('generation result requires checks, local IDs, workflow status, and an approval flag', () => {
  const result = generationResultSchema.parse(loadExample('generation-result.json'));
  assert.equal(result.requiresHumanApproval, true);
  assert.equal(result.status, 'READY_FOR_REVIEW');
  assert.equal(result.candidateVersion, 1);
  assert.equal(result.revisionCount, 0);
  assert.equal(
    generationResultSchema.safeParse({
      ...result,
      status: 'FAILED',
      requiresHumanApproval: false,
    }).success,
    true,
  );
  assert.equal(
    generationResultSchema.safeParse({ ...result, requiresHumanApproval: false }).success,
    false,
  );
  assert.equal(
    generationResultSchema.safeParse({
      requestId: 'r1',
      status: 'READY_FOR_REVIEW',
      candidateVersion: 1,
      revisionCount: 0,
      requiresHumanApproval: true,
      checks: [],
      proposals: [validProposal],
    }).success,
    false,
  );
});
