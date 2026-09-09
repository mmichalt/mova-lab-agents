import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settleReviews } from '../src/content/review.ts';
import type { CheckResult } from '../src/content/schemas.ts';
import { AppError } from '../src/errors.ts';

function passed(name: 'age' | 'language'): CheckResult {
  return { status: 'passed', name, issues: [] };
}

function failed(name: 'age' | 'language', code: string): CheckResult {
  return {
    status: 'failed',
    name,
    issues: [{ source: name, code, severity: 'error', message: 'unsuitable' }],
  };
}

test('both reviews start before either settles', async () => {
  const events: string[] = [];
  const gate = Promise.withResolvers<void>();
  const pending = settleReviews(
    (async () => {
      events.push('age-start');
      await gate.promise;
      events.push('age-end');
      return passed('age');
    })(),
    (async () => {
      events.push('language-start');
      await gate.promise;
      events.push('language-end');
      return passed('language');
    })(),
  );
  assert.deepEqual(events, ['age-start', 'language-start']);
  gate.resolve();
  assert.deepEqual(await pending, [passed('age'), passed('language')]);
  assert.ok(events.includes('age-end'));
  assert.ok(events.includes('language-end'));
});

test('successful feedback survives one rejection', async () => {
  const [age, language] = await settleReviews(
    Promise.reject(new AppError(504, 'PROVIDER_TIMEOUT', 'timed out')),
    Promise.resolve(passed('language')),
  );
  assert.deepEqual(age, { status: 'unavailable', name: 'age', errorCode: 'PROVIDER_TIMEOUT' });
  assert.deepEqual(language, passed('language'));
});

test('both rejections become unavailable checks', async () => {
  const [age, language] = await settleReviews(
    Promise.reject(new AppError(503, 'PROVIDER_UNAVAILABLE', 'down')),
    Promise.reject(new AppError(502, 'PROVIDER_INVALID_OUTPUT', 'bad')),
  );
  assert.deepEqual(age, { status: 'unavailable', name: 'age', errorCode: 'PROVIDER_UNAVAILABLE' });
  assert.deepEqual(language, {
    status: 'unavailable',
    name: 'language',
    errorCode: 'PROVIDER_INVALID_OUTPUT',
  });
});

test('negative verdicts stay failed and do not become unavailable', async () => {
  const [age, language] = await settleReviews(
    Promise.resolve(failed('age', 'TOO_COMPLEX')),
    Promise.resolve(passed('language')),
  );
  assert.equal(age.status, 'failed');
  assert.equal(language.status, 'passed');
});

test('aborts map to unavailable without inventing a pass', async () => {
  const [age, language] = await settleReviews(
    Promise.reject(new AppError(504, 'PROVIDER_TIMEOUT', 'aborted')),
    Promise.reject(new AppError(504, 'PROVIDER_TIMEOUT', 'aborted')),
  );
  assert.deepEqual(age, { status: 'unavailable', name: 'age', errorCode: 'PROVIDER_TIMEOUT' });
  assert.deepEqual(language, {
    status: 'unavailable',
    name: 'language',
    errorCode: 'PROVIDER_TIMEOUT',
  });
});
