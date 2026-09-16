import assert from 'node:assert/strict';
import { test } from 'node:test';
import { contentRequestSchema } from '../src/content/schemas.ts';
import { fakeOllama, teacherRequest } from './drafts-harness.ts';
import {
  classifySmokeRun,
  fetchJson,
  smokeSettingsSufficed,
  smokeTruncated,
} from './smoke-report.ts';

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
    providerRequests: 5,
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
  const revised = { ...ready, revisionCount: 1, providerRequests: 8 };
  const reasked = { ...ready, revisionCount: 0, providerRequests: 6 };
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
