import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { EvaluationCaseReport, EvaluationMetadata, EvaluationReport } from './runner.ts';

export const WORKFLOW_COMPARISON_REPORT_VERSION = 'workflow-comparison/v1';
export const WORKFLOW_MODES = ['single-call', 'deterministic', 'supervisor'] as const;
export type WorkflowMode = (typeof WORKFLOW_MODES)[number];

const comparableFields = [
  'corpus.version',
  'corpus.propertiesVersion',
  'corpus.rubricVersion',
  'corpus.cases',
  'corpus.holdoutCaseIds',
  'schemaVersion',
  'model',
  'runtime',
  'hardware',
] as const;

export type RecordedWorkflowReport = {
  mode: WorkflowMode;
  report: EvaluationReport;
};

export type WorkflowComparisonReport = {
  reportVersion: string;
  status: 'complete' | 'incomplete' | 'invalid';
  inputMismatches: Array<{ field: string; values: Record<string, unknown> }>;
  versions: Record<WorkflowMode, WorkflowVersions | null>;
  runs: ComparisonRun[];
  summaries: Record<WorkflowMode, WorkflowSummary | null>;
  humanReview: HumanReviewPlan;
};

type WorkflowVersions = {
  corpus: EvaluationReport['corpus'];
  workflowVersion: string;
  promptVersions: Record<string, string>;
  schemaVersion: string;
  model: EvaluationMetadata['model'];
  runtime: Record<string, unknown>;
  hardware: Record<string, unknown>;
};

export type ComparisonRun = {
  caseId: string;
  repetition: number;
  holdout: boolean;
  missingModes: WorkflowMode[];
  workflows: Partial<Record<WorkflowMode, ComparisonRunMode>>;
};

type ComparisonRunMode = {
  status: EvaluationCaseReport['status'];
  outcome: EvaluationCaseReport['outcomes']['outcome'];
  initialSuccess: boolean;
  revisionAssistedSuccess: boolean;
  refusal: boolean;
  operationalFailure: boolean;
  humanReview: EvaluationCaseReport['outcomes']['therapist'];
  qualityProperties: EvaluationCaseReport['outcomes']['properties'];
  latencyMs: number | null;
  measuredOutputTokens: number | null;
  estimatedCostUsd: number | null;
  costStatus: EvaluationCaseReport['cost']['status'];
  supervisorActionCounts: Record<string, number>;
};

type WorkflowSummary = {
  totalRuns: number;
  completeRuns: number;
  incompleteRuns: number;
  holdout: { totalRuns: number; completeRuns: number; incompleteRuns: number };
  outcomes: {
    initialSuccess: number;
    revisionAssistedSuccess: number;
    refusal: number;
    operationalFailure: number;
  };
  humanRatedUsefulness: {
    ratedRuns: number;
    unratedRuns: number;
    meanScore: number | null;
  };
  qualityProperties: Record<string, { passed: number; total: number }>;
  latencyMs: { min: number | null; max: number | null; mean: number | null };
  measuredOutputTokens: { total: number | null; measuredRuns: number; unmeasuredRuns: number };
  cost: {
    estimatedCostUsd: number | null;
    status: 'reported' | 'unmeasured_local' | 'mixed';
  };
  supervisorActionCounts: Record<string, number>;
};

type HumanReviewPlan = {
  required: true;
  status: 'pending' | 'complete';
  rubricVersions: Record<WorkflowMode, string | null>;
  checklist: Array<{ id: string; complete: boolean }>;
  records: Array<{
    mode: WorkflowMode;
    caseId: string;
    repetition: number;
    score: number;
    dimensions: Record<string, number | null>;
    comments: string | null;
  }>;
};

export function compareWorkflowReports(
  recorded: RecordedWorkflowReport[],
): WorkflowComparisonReport {
  const byMode = new Map<WorkflowMode, EvaluationReport>();
  const inputMismatches: WorkflowComparisonReport['inputMismatches'] = [];
  for (const item of recorded) {
    if (byMode.has(item.mode)) {
      inputMismatches.push({
        field: 'mode',
        values: { [item.mode]: 'duplicate report' },
      });
    } else {
      byMode.set(item.mode, item.report);
    }
  }

  for (const mode of WORKFLOW_MODES) {
    if (!byMode.has(mode)) {
      inputMismatches.push({ field: 'mode', values: { [mode]: 'missing report' } });
    }
  }

  const versions = Object.fromEntries(
    WORKFLOW_MODES.map((mode) => {
      const report = byMode.get(mode);
      return [mode, report ? versionsOf(report) : null];
    }),
  ) as Record<WorkflowMode, WorkflowVersions | null>;
  for (const field of comparableFields) {
    const values = Object.fromEntries(
      WORKFLOW_MODES.flatMap((mode) => {
        const version = versions[mode];
        return version ? [[mode, fieldValue(version, field)]] : [];
      }),
    );
    if (new Set(Object.values(values).map(stableJson)).size > 1) {
      inputMismatches.push({ field, values });
    }
  }

  const keys = new Set<string>();
  for (const report of byMode.values()) {
    for (const run of report.runs) keys.add(runKey(run));
  }
  const runs = [...keys].sort().map((key) => comparisonRun(key, byMode));
  const summaries = Object.fromEntries(
    WORKFLOW_MODES.map((mode) => {
      const report = byMode.get(mode);
      return [mode, report ? summarize(report.runs) : null];
    }),
  ) as Record<WorkflowMode, WorkflowSummary | null>;
  const humanReview = buildHumanReview(byMode);
  const hasIncomplete = runs.some((run) =>
    WORKFLOW_MODES.some((mode) => run.workflows[mode]?.status === 'incomplete'),
  );

  return {
    reportVersion: WORKFLOW_COMPARISON_REPORT_VERSION,
    status: inputMismatches.length ? 'invalid' : hasIncomplete ? 'incomplete' : 'complete',
    inputMismatches,
    versions,
    runs,
    summaries,
    humanReview,
  };
}

function comparisonRun(key: string, reports: Map<WorkflowMode, EvaluationReport>): ComparisonRun {
  const [caseId, repetitionText] = key.split(':');
  const repetition = Number(repetitionText);
  const workflows: Partial<Record<WorkflowMode, ComparisonRunMode>> = {};
  let holdout = false;
  for (const mode of WORKFLOW_MODES) {
    const run = reports.get(mode)?.runs.find((item) => runKey(item) === key);
    if (!run) continue;
    holdout = run.holdout;
    workflows[mode] = toComparisonRun(run);
  }
  return {
    caseId,
    repetition,
    holdout,
    missingModes: WORKFLOW_MODES.filter((mode) => !workflows[mode]),
    workflows,
  };
}

function toComparisonRun(run: EvaluationCaseReport): ComparisonRunMode {
  const outcome = outcomeOf(run);
  return {
    status: run.status,
    outcome,
    initialSuccess: outcome === 'initial_success',
    revisionAssistedSuccess: outcome === 'revision_assisted_success',
    refusal: outcome === 'refusal',
    operationalFailure: outcome === 'operational_failure',
    humanReview: run.outcomes.therapist,
    qualityProperties: run.outcomes.properties,
    latencyMs: run.latencyMs,
    measuredOutputTokens: run.usage?.outputTokens ?? null,
    estimatedCostUsd: run.cost.estimatedCostUsd,
    costStatus: run.cost.status,
    supervisorActionCounts: run.outcomes.supervisorActionCounts ?? {},
  };
}

function summarize(runs: EvaluationCaseReport[]): WorkflowSummary {
  const complete = runs.filter((run) => run.status === 'complete');
  const holdout = runs.filter((run) => run.holdout);
  const latencies = runs.flatMap((run) => (run.latencyMs === null ? [] : [run.latencyMs]));
  const tokenValues = runs.flatMap((run) => {
    const value = run.usage?.outputTokens;
    return typeof value === 'number' ? [value] : [];
  });
  const rated = runs.flatMap((run) => {
    const score = run.outcomes.therapist.score;
    return typeof score === 'number' ? [score] : [];
  });
  const properties: Record<string, { passed: number; total: number }> = {};
  const supervisorActionCounts: Record<string, number> = {};
  for (const run of runs) {
    for (const finding of run.outcomes.properties) {
      const property = properties[finding.id] ?? { passed: 0, total: 0 };
      properties[finding.id] = property;
      property.total += 1;
      if (finding.passed) property.passed += 1;
    }
    for (const [action, count] of Object.entries(run.outcomes.supervisorActionCounts ?? {})) {
      supervisorActionCounts[action] = (supervisorActionCounts[action] ?? 0) + count;
    }
  }
  const costValues = runs.flatMap((run) =>
    typeof run.cost.estimatedCostUsd === 'number' ? [run.cost.estimatedCostUsd] : [],
  );
  const costStatus =
    costValues.length === runs.length
      ? 'reported'
      : costValues.length
        ? 'mixed'
        : 'unmeasured_local';
  return {
    totalRuns: runs.length,
    completeRuns: complete.length,
    incompleteRuns: runs.length - complete.length,
    holdout: {
      totalRuns: holdout.length,
      completeRuns: holdout.filter((run) => run.status === 'complete').length,
      incompleteRuns: holdout.filter((run) => run.status === 'incomplete').length,
    },
    outcomes: {
      initialSuccess: runs.filter((run) => outcomeOf(run) === 'initial_success').length,
      revisionAssistedSuccess: runs.filter((run) => outcomeOf(run) === 'revision_assisted_success')
        .length,
      refusal: runs.filter((run) => outcomeOf(run) === 'refusal').length,
      operationalFailure: runs.filter((run) => outcomeOf(run) === 'operational_failure').length,
    },
    humanRatedUsefulness: {
      ratedRuns: rated.length,
      unratedRuns: runs.length - rated.length,
      meanScore: mean(rated),
    },
    qualityProperties: properties,
    latencyMs: { min: min(latencies), max: max(latencies), mean: mean(latencies) },
    measuredOutputTokens: {
      total: tokenValues.length ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
      measuredRuns: tokenValues.length,
      unmeasuredRuns: runs.length - tokenValues.length,
    },
    cost: {
      estimatedCostUsd:
        costValues.length === runs.length
          ? costValues.reduce((sum, value) => sum + value, 0)
          : null,
      status: costStatus,
    },
    supervisorActionCounts,
  };
}

function buildHumanReview(reports: Map<WorkflowMode, EvaluationReport>): HumanReviewPlan {
  const records: HumanReviewPlan['records'] = [];
  const rubricVersions = Object.fromEntries(
    WORKFLOW_MODES.map((mode) => [mode, reports.get(mode)?.corpus.rubricVersion ?? null]),
  ) as Record<WorkflowMode, string | null>;
  for (const mode of WORKFLOW_MODES) {
    for (const run of reports.get(mode)?.runs ?? []) {
      const review = run.outcomes.therapist;
      if (review.score !== null) {
        records.push({
          mode,
          caseId: run.caseId,
          repetition: run.repetition,
          score: review.score,
          dimensions: review.dimensions,
          comments: review.comments,
        });
      }
    }
  }
  const requiredRatings = [...reports.values()].reduce(
    (sum, report) => sum + report.runs.length,
    0,
  );
  const complete = records.length === requiredRatings && requiredRatings > 0;
  return {
    required: true,
    status: complete ? 'complete' : 'pending',
    rubricVersions,
    checklist: [
      { id: 'review-all-recorded-runs', complete },
      { id: 'score-usefulness-and-dimensions', complete },
      {
        id: 'record-comments-for-corrections',
        complete: complete && records.every((record) => record.comments !== null),
      },
    ],
    records,
  };
}

function outcomeOf(run: EvaluationCaseReport): EvaluationCaseReport['outcomes']['outcome'] {
  const recorded = run.outcomes.outcome;
  if (recorded) return recorded;
  if (run.status === 'incomplete') return 'incomplete';
  if (run.outcomes.failure?.code === 'MODEL_REFUSED') return 'refusal';
  if (run.outcomes.failure) return 'operational_failure';
  return (run.outcomes.revisions ?? 0) > 0 ? 'revision_assisted_success' : 'initial_success';
}

function versionsOf(report: EvaluationReport): WorkflowVersions {
  return {
    corpus: report.corpus,
    workflowVersion: report.metadata.workflowVersion,
    promptVersions: report.metadata.promptVersions,
    schemaVersion: report.metadata.schemaVersion,
    model: report.metadata.model,
    runtime: report.metadata.runtime,
    hardware: report.metadata.hardware,
  };
}

function fieldValue(version: WorkflowVersions, field: (typeof comparableFields)[number]) {
  switch (field) {
    case 'corpus.version':
      return version.corpus.version;
    case 'corpus.propertiesVersion':
      return version.corpus.propertiesVersion;
    case 'corpus.rubricVersion':
      return version.corpus.rubricVersion;
    case 'corpus.cases':
      return version.corpus.cases;
    case 'corpus.holdoutCaseIds':
      return version.corpus.holdoutCaseIds;
    case 'schemaVersion':
      return version.schemaVersion;
    case 'model':
      return version.model;
    case 'runtime':
      return version.runtime;
    case 'hardware':
      return version.hardware;
  }
}

function runKey(run: Pick<EvaluationCaseReport, 'caseId' | 'repetition'>) {
  return `${run.caseId}:${run.repetition}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? String(value);
}

function mean(values: number[]) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function min(values: number[]) {
  return values.length ? Math.min(...values) : null;
}

function max(values: number[]) {
  return values.length ? Math.max(...values) : null;
}

type ComparisonManifest = {
  reports: Array<{ mode: WorkflowMode; path: string }>;
};

if (process.argv[1]?.endsWith('/evals/comparison.ts')) {
  const manifestPath = process.argv[2];
  if (!manifestPath) throw new Error('Usage: npm run eval:compare -- <manifest.json>');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ComparisonManifest;
  const base = dirname(resolve(manifestPath));
  const recorded = manifest.reports.map(({ mode, path }) => ({
    mode,
    report: JSON.parse(readFileSync(resolve(base, path), 'utf8')) as EvaluationReport,
  }));
  process.stdout.write(`${JSON.stringify(compareWorkflowReports(recorded), null, 2)}\n`);
}
