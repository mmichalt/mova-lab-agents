import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { GENERATION_TEMPERATURE, PROMPT_VERSION } from '../src/content/generate.ts';
import { contentRequestSchema } from '../src/content/schemas.ts';
import { assessGeneration } from './properties.ts';

const corpus = JSON.parse(readFileSync(new URL('../evals/corpus.json', import.meta.url), 'utf8'));
const runtime = JSON.parse(readFileSync(new URL('../evals/runtime.json', import.meta.url), 'utf8'));
const compose = readFileSync(new URL('../compose.yaml', import.meta.url), 'utf8');
const defaults = loadConfig({ SERVICE_TOKEN: 'x' });

const cases = corpus.cases as Array<{
  id: string;
  request: unknown;
  expect: {
    targetSounds: string[];
    exerciseType: string;
    count: number;
    language: string;
    theme: string;
  };
}>;

test('corpus covers Р, Л, and both with property expectations', () => {
  const sounds = new Set(cases.map((c) => c.expect.targetSounds.join('+')));
  assert.ok(sounds.has('р'));
  assert.ok(sounds.has('л'));
  assert.ok(sounds.has('р+л'));
  for (const item of cases) {
    const request = contentRequestSchema.parse(item.request);
    assert.deepEqual([...request.targetSounds], item.expect.targetSounds);
    assert.equal(request.exerciseCount, item.expect.count);
    assert.equal(request.theme, item.expect.theme);
    assert.equal(item.expect.exerciseType, 'recording');
    assert.equal(item.expect.language, 'uk');
  }
});

test('runtime metadata records prompt, model, and sampling without invented ids', () => {
  assert.equal(runtime.promptVersion, PROMPT_VERSION);
  assert.equal(runtime.model.tag, defaults.ollamaModel);
  assert.equal(runtime.model.quantization, 'Q4_K_M');
  assert.equal(runtime.runtime.numCtx, defaults.ollamaNumCtx);
  assert.equal(runtime.runtime.numPredict, defaults.ollamaNumPredict);
  assert.equal(runtime.runtime.temperature, GENERATION_TEMPERATURE);
  assert.ok(compose.includes(runtime.runtime.ollamaImage));
  assert.equal('providerRequestId' in runtime, false);
  assert.equal(typeof runtime.smoke.ran, 'boolean');
  if (runtime.smoke.ran) {
    assert.match(runtime.model.digest, /^[\da-f]{64}$/);
    assert.equal(typeof runtime.runtime.ollamaVersion, 'string');
    assert.ok(runtime.runtime.ollamaVersion.length > 0);
  }
});

test('quality properties judge shape, not exact wording', () => {
  const request = contentRequestSchema.parse(cases[0].request);
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
  const ok = {
    requestId: '11111111-1111-4111-8111-111111111111',
    requiresHumanApproval: true,
    checks: [],
    proposals: Array.from({ length: 6 }, (_, i) => ({ ...proposal, localId: `proposal-${i + 1}` })),
  };
  assert.equal(
    assessGeneration(request, ok).every((f) => f.passed),
    true,
  );

  const english = {
    ...ok,
    proposals: ok.proposals.map((p) => ({ ...p, title: 'Fish', phrase: 'The fish swims' })),
  };
  const findings = Object.fromEntries(
    assessGeneration(request, english).map((f) => [f.id, f.passed]),
  );
  assert.equal(findings['ukrainian-script'], false);
  assert.equal(findings['literal-target-letter'], false);
  assert.equal(findings['schema-valid'], true);

  const mixed = contentRequestSchema.parse(cases.find((c) => c.id === 'rl-mixed-animals')?.request);
  const onlyR = {
    ...ok,
    proposals: ok.proposals.map((p) => ({ ...p, targetSound: 'р', phrase: 'Риба пливе' })),
  };
  assert.equal(
    Object.fromEntries(assessGeneration(mixed, onlyR).map((f) => [f.id, f.passed]))[
      'covers-requested-sounds'
    ],
    false,
  );
});
