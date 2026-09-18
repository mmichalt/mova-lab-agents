import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareWorkflowReports, type WorkflowMode } from '../evals/comparison.ts';
import type { EvaluationCaseReport, EvaluationReport } from '../evals/runner.ts';

const modes: WorkflowMode[] = ['single-call', 'deterministic', 'supervisor'];

function run(
  caseId: string,
  repetition: number,
  values: {
    outcomes?: Partial<EvaluationCaseReport['outcomes']>;
  } & Partial<
    Pick<EvaluationCaseReport, 'status' | 'holdout' | 'latencyMs' | 'usage' | 'cost'>
  > = {},
): EvaluationCaseReport {
  const { outcomes: outcomeOverrides, ...runOverrides } = values;
  return {
    caseId,
    repetition,
    holdout: values.holdout ?? caseId.startsWith('holdout'),
    status: values.status ?? 'complete',
    outcomes: {
      outcome: values.status === 'incomplete' ? 'incomplete' : 'initial_success',
      schema: true,
      content: true,
      targetCoverage: true,
      properties: [{ id: 'schema-valid', passed: true }],
      duplicates: 0,
      revisions: 0,
      proposals: null,
      therapist: {
        rubricVersion: 'therapist-rubric/v1',
        score: null,
        dimensions: {},
        comments: null,
      },
      supervisorActionCounts: {},
      failure: null,
      ...outcomeOverrides,
    },
    latencyMs: values.latencyMs ?? null,
    usage: values.usage ?? null,
    metadata: null,
    cost: values.cost ?? { estimatedCostUsd: null, status: 'unmeasured_local' },
    ...runOverrides,
  } as EvaluationCaseReport;
}

function report(runs: EvaluationCaseReport[], corpusVersion = 'synthetic-corpus/v2') {
  const expandedRuns = runs.flatMap((item) =>
    [1, 2, 3].map((repetition) => ({ ...item, repetition })),
  );
  return {
    reportVersion: 'evaluation-report/v1',
    protocolVersion: 'evaluation-protocol/v1',
    corpus: {
      version: corpusVersion,
      propertiesVersion: 'properties/v1',
      rubricVersion: 'therapist-rubric/v1',
      rubricDimensions: [
        'target-sound relevance',
        'age appropriateness',
        'language clarity',
        'therapy usefulness',
      ],
      cases: 2,
      holdoutCaseIds: ['holdout-case'],
    },
    budget: {
      maxCalls: 1,
      maxGeneratedTokens: 1,
      maxElapsedMs: 1,
      maxConcurrent: 1,
      maxCallsPerRun: 1,
      maxGeneratedTokensPerRun: 1,
      timeoutMs: 1,
    },
    status: 'complete',
    metadata: {
      workflowVersion: 'workflow/v1',
      mode: 'deterministic',
      promptVersions: { exercises: 'exercises/v1' },
      schemaVersion: 'schema/v1',
      model: { tag: 'fake', digest: 'digest', quantization: 'Q4' },
      runtime: { numCtx: 4096 },
      hardware: { cpu: 'fake' },
      concurrency: 1,
    },
    summary: {},
    runs: expandedRuns,
    incomplete: [],
  } as unknown as EvaluationReport;
}

function recorded(overrides: Partial<Record<WorkflowMode, EvaluationReport>> = {}) {
  return modes.map((mode) => {
    const source =
      overrides[mode] ?? report([run('case', 1), run('holdout-case', 1, { status: 'incomplete' })]);
    return { mode, report: { ...source, metadata: { ...source.metadata, mode } } };
  });
}

test('comparison aggregates outcomes, quality, latency, tokens, cost, and actions', () => {
  const comparison = compareWorkflowReports(
    recorded({
      deterministic: report([
        run('case', 1, {
          outcomes: {
            outcome: 'revision_assisted_success',
            therapist: {
              rubricVersion: 'therapist-rubric/v1',
              score: 4,
              dimensions: { usefulness: 4 },
              comments: 'usable',
            },
            revisions: 1,
          },
          latencyMs: 200,
          usage: { outputTokens: 20 },
        }),
        run('holdout-case', 1, { status: 'incomplete' }),
      ]),
      supervisor: report([
        run('case', 1, {
          outcomes: {
            outcome: 'operational_failure',
            supervisorActionCounts: { generate: 2, finish: 1 },
            failure: { status: 'FAILED', code: 'PROVIDER_TIMEOUT' },
          },
          latencyMs: 300,
          usage: { outputTokens: null },
        }),
        run('holdout-case', 1, { status: 'incomplete' }),
      ]),
    }),
  );

  assert.equal(comparison.status, 'incomplete');
  assert.equal(comparison.summaries['single-call']?.outcomes.initialSuccess, 3);
  assert.equal(comparison.summaries.deterministic?.outcomes.revisionAssistedSuccess, 3);
  assert.equal(comparison.summaries.supervisor?.outcomes.operationalFailure, 3);
  assert.deepEqual(comparison.summaries.supervisor?.supervisorActionCounts, {
    generate: 6,
    finish: 3,
  });
  assert.equal(comparison.summaries.deterministic?.humanRatedUsefulness.meanScore, 4);
  assert.equal(comparison.summaries.deterministic?.measuredOutputTokens.total, 60);
  assert.equal(comparison.summaries.supervisor?.measuredOutputTokens.total, null);
  assert.equal(comparison.summaries['single-call']?.holdout.incompleteRuns, 3);
  assert.equal(comparison.humanReview.status, 'pending');
  assert.equal(comparison.humanReview.records.length, 3);
});

test('comparison exposes mismatched inputs and missing runs instead of merging them', () => {
  const reports = recorded({ deterministic: report([run('case', 1)], 'other-corpus/v1') });
  const comparison = compareWorkflowReports(reports);
  assert.equal(comparison.status, 'invalid');
  assert.equal(
    comparison.inputMismatches.some((item) => item.field === 'corpus.version'),
    true,
  );
  const holdout = comparison.runs.find((item) => item.caseId === 'holdout-case');
  assert.deepEqual(holdout?.missingModes, ['deterministic']);
});

test('comparison rejects a report with mixed runtime identity', () => {
  const mixed = report([run('case', 1), run('holdout-case', 1)]);
  mixed.status = 'incomplete';
  mixed.metadataMismatches = [
    { field: 'model', expected: { digest: 'one' }, actual: { digest: 'two' } },
  ];
  const comparison = compareWorkflowReports(recorded({ deterministic: mixed }));
  assert.equal(comparison.status, 'invalid');
  assert.equal(
    comparison.inputMismatches.some((item) => item.field === 'deterministic.metadataMismatches'),
    true,
  );
});

test('missing therapist ratings stay nullable and keep review pending', () => {
  const comparison = compareWorkflowReports(recorded());
  assert.equal(comparison.humanReview.status, 'pending');
  assert.equal(comparison.humanReview.records.length, 0);
  assert.equal(
    comparison.humanReview.checklist.every((item) => !item.complete),
    true,
  );
  assert.equal(comparison.summaries['single-call']?.humanRatedUsefulness.meanScore, null);
});
