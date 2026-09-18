import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateCorpus, loadCorpus } from '../evals/runner.ts';

const corpus = loadCorpus();
const validResult = (requestId: string, revisionCount = 1) => ({
  requestId,
  status: 'READY_FOR_REVIEW',
  candidateVersion: Math.min(revisionCount, 2) + 1,
  revisionCount: Math.min(revisionCount, 2),
  providerRequests: 3,
  requiresHumanApproval: true,
  checks: [
    { status: 'passed', name: 'content', issues: [] },
    { status: 'passed', name: 'age', issues: [] },
    { status: 'passed', name: 'language', issues: [] },
  ],
  proposals: Array.from({ length: 6 }, (_, index) => ({
    localId: `proposal-${index + 1}`,
    type: 'recording',
    title: `Риба ${index + 1}`,
    phrase: `Риба пливе ${index + 1}`,
    childHint: 'Скажи',
    teacherNote: 'Повільно',
    targetSound: index % 2 === 0 ? 'р' : 'л',
    difficulty: 'easy',
  })),
});

test('budgeted runner calculates quality, revisions, latency, usage, and holdout metadata', async () => {
  let calls = 0;
  const report = await evaluateCorpus(
    { ...corpus, cases: corpus.cases.slice(0, 1), holdoutCaseIds: [] },
    async ({ repetition, maxCalls, maxGeneratedTokens }) => {
      calls += 1;
      assert.equal(maxCalls, 4);
      assert.equal(maxGeneratedTokens, 100);
      return {
        result: validResult(`run-${repetition}`, repetition),
        elapsedMs: repetition * 10,
        usage: { calls: 3, outputTokens: 20, estimatedCostUsd: null },
      };
    },
    {
      budget: {
        maxCalls: 12,
        maxGeneratedTokens: 300,
        maxCallsPerRun: 4,
        maxGeneratedTokensPerRun: 100,
        maxConcurrent: 2,
      },
    },
  );

  assert.equal(calls, 3);
  assert.equal(report.status, 'complete');
  assert.equal(report.summary.totalRuns, 3);
  assert.equal(report.summary.targetCoverage.passed, 3);
  assert.equal(report.summary.revisions, 5);
  assert.equal(report.summary.usage.calls, 9);
  assert.equal(report.summary.usage.outputTokens, 60);
  assert.deepEqual(
    report.runs.map((run) => run.latencyMs),
    [10, 20, 30],
  );
  assert.equal(
    report.runs.every((run) => run.holdout === false),
    true,
  );
});

test('reservations prevent concurrent submissions beyond call and token budgets', async () => {
  const submitted: number[] = [];
  const report = await evaluateCorpus(
    { ...corpus, cases: corpus.cases.slice(0, 2), holdoutCaseIds: [] },
    async ({ repetition, maxCalls, maxGeneratedTokens }) => {
      submitted.push(repetition);
      assert.equal(maxCalls, 1);
      assert.equal(maxGeneratedTokens, 10);
      return { result: validResult(`run-${repetition}`), usage: { calls: 1, outputTokens: 10 } };
    },
    {
      budget: {
        maxCalls: 2,
        maxGeneratedTokens: 20,
        maxCallsPerRun: 1,
        maxGeneratedTokensPerRun: 10,
        maxConcurrent: 2,
      },
    },
  );

  assert.equal(submitted.length, 2);
  assert.equal(report.summary.startedRuns, 2);
  assert.equal(report.summary.incompleteRuns, 4);
  assert.equal(
    report.incomplete.every((run) => run.reason === 'budget_exhausted'),
    true,
  );
});

test('missing generated-token usage stops before the next submission', async () => {
  let calls = 0;
  const report = await evaluateCorpus(
    { ...corpus, cases: corpus.cases.slice(0, 1), holdoutCaseIds: [] },
    async () => {
      calls += 1;
      return { result: validResult(`run-${calls}`), usage: { calls: 1, outputTokens: null } };
    },
    {
      budget: {
        maxCalls: 20,
        maxGeneratedTokens: 10,
        maxCallsPerRun: 1,
        maxGeneratedTokensPerRun: 10,
      },
    },
  );

  assert.equal(calls, 1);
  assert.equal(report.status, 'incomplete');
  assert.equal(report.summary.incompleteRuns, 3);
  assert.equal(report.incomplete[0]?.reason, 'missing_usage');
});
