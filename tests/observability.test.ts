import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { InMemorySpanExporter } from '@opentelemetry/sdk-trace-node';
import { presentRun } from '../src/content/runs.ts';
import {
  aggregateAttemptTiming,
  aggregateUsage,
  createObservability,
  diagnosticAttributes,
  linksFor,
  redact,
  spanContextRecord,
  withSpan,
} from '../src/observability.ts';
import { CONSTRAINTS_VERSION, openWorkflowStore, WORKFLOW_VERSION } from '../src/persist/store.ts';

test('exports correlated spans without retaining payloads', async () => {
  const exporter = new InMemorySpanExporter();
  const observability = createObservability({ exporter });
  const http = observability.startSpan('http.request');
  const httpRecord = spanContextRecord(http);
  http.end();
  await withSpan(
    observability,
    'workflow.job',
    { links: linksFor([httpRecord]), attributes: { 'workflow.id': 'run-1' } },
    async () => undefined,
  );
  const spans = exporter.getFinishedSpans();
  const job = spans.find((span) => span.name === 'workflow.job');
  assert.ok(job);
  assert.equal(job.links[0]?.context.traceId, httpRecord.traceId);
  assert.equal(JSON.stringify(job.attributes).includes('secret payload'), false);
  await observability.shutdown();
});

test('diagnostic capture is opt-in and redacted', async () => {
  const exporter = new InMemorySpanExporter();
  const observability = createObservability({ exporter, diagnosticCapture: true });
  await withSpan(
    observability,
    'diagnostic',
    {
      attributes: diagnosticAttributes(observability, {
        authorization: 'Bearer secret',
        body: 'secret payload',
        step: 'generation',
      }),
    },
    async () => undefined,
  );
  const attrs = exporter.getFinishedSpans()[0]?.attributes ?? {};
  assert.equal(attrs['diagnostic.capture'], 'redacted');
  assert.equal(String(attrs['diagnostic.fields']).includes('secret payload'), false);
  assert.equal(String(attrs['diagnostic.fields']).includes('[REDACTED]'), true);
  await observability.shutdown();
});

test('usage and timing reports preserve unknowns and null local cost', () => {
  assert.deepEqual(
    aggregateUsage([
      {
        model: 'local',
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 4,
        estimatedCostUsd: null,
      },
      {
        model: 'local',
        inputTokens: null,
        cachedInputTokens: null,
        outputTokens: 3,
        estimatedCostUsd: null,
      },
    ]),
    {
      attempts: 2,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: 7,
      estimatedCostUsd: null,
      costStatus: 'unmeasured_local',
    },
  );
  assert.deepEqual(
    aggregateAttemptTiming([
      {
        startedAt: 10,
        finishedAt: 25,
        usage: { loadDurationNs: 100, promptEvaluationDurationNs: 20, generationDurationNs: 30 },
      },
      {
        startedAt: 30,
        finishedAt: 40,
        usage: { loadDurationNs: 0, promptEvaluationDurationNs: null, generationDurationNs: 10 },
      },
    ]),
    {
      attempts: 2,
      wallDurationMs: 25,
      loadDurationNs: 100,
      promptEvaluationDurationNs: null,
      generationDurationNs: 40,
      coldAttempts: 1,
      warmAttempts: 1,
    },
  );
  assert.deepEqual(
    aggregateUsage([
      null,
      {
        model: 'local',
        inputTokens: 10,
        cachedInputTokens: null,
        outputTokens: 5,
        estimatedCostUsd: null,
      },
    ]),
    {
      attempts: 2,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      costStatus: 'unmeasured_local',
    },
  );
  assert.deepEqual(
    aggregateAttemptTiming(
      [
        { startedAt: 0, finishedAt: null, usage: null },
        { startedAt: 10, finishedAt: 20, usage: null },
      ],
      [
        {
          wallDurationMs: 4,
          loadDurationNs: 8,
          promptEvaluationDurationNs: 2,
          generationDurationNs: 3,
        },
      ],
    ),
    {
      attempts: 2,
      wallDurationMs: null,
      loadDurationNs: null,
      promptEvaluationDurationNs: null,
      generationDurationNs: null,
      coldAttempts: 1,
      warmAttempts: 0,
    },
  );
});

test('run reports use durable usage and unknown pre-execution runtime', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ag-026-'));
  const store = openWorkflowStore(path.join(dir, 'workflow.sqlite'));
  t.after(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = store.createRun({
    ownerId: 'teacher',
    idempotencyKey: 'durable-usage',
    normalizedInput: { ageYears: 7 },
    workflowVersion: WORKFLOW_VERSION,
    constraintsVersion: CONSTRAINTS_VERSION,
    promptVersions: {},
    modelTag: 'configured',
    initialState: {
      usage: [
        {
          model: 'stale',
          inputTokens: 99,
          cachedInputTokens: 0,
          outputTokens: 99,
          estimatedCostUsd: null,
        },
      ],
    },
    limits: {
      maxProviderRequests: 1,
      maxRevisions: 0,
      workflowTimeoutMs: 100,
      attemptTimeoutMs: 50,
      deadlineAt: 100,
      ollamaNumCtx: 1,
      ollamaNumPredict: 1,
    },
    now: 0,
  });
  store.saveCheckpoint({
    runId: run.id,
    expectedStateVersion: 0,
    status: 'RUNNING',
    phase: 'generation',
    consumed: { providerRequests: 1, revisionCount: 0 },
    state: run.state,
    now: 1,
    modelTag: 'configured',
    modelDigest: 'digest',
    attempt: {
      step: 'generation',
      candidateVersion: null,
      operationKey: 'generation:0',
      executionAttempt: 1,
      outcome: 'completed',
      startedAt: 0,
      finishedAt: 1,
      usage: {
        model: 'actual',
        inputTokens: 2,
        cachedInputTokens: null,
        outputTokens: 3,
        estimatedCostUsd: null,
      },
      error: null,
    },
  });

  const persisted = store.getRun(run.id);
  assert.ok(persisted);
  const resource = presentRun(store, persisted, 'teacher', 1);
  assert.deepEqual(resource.observability.usage, {
    attempts: 1,
    inputTokens: 2,
    cachedInputTokens: null,
    outputTokens: 3,
    estimatedCostUsd: null,
    costStatus: 'unmeasured_local',
  });
  assert.equal(resource.observability.runtime.contextTokens, null);
  assert.equal(resource.observability.runtime.hardware.platform, null);
});

test('retention redacts terminal content and keeps pending reviews', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ag-026-'));
  const store = openWorkflowStore(path.join(dir, 'workflow.sqlite'));
  try {
    const terminal = store.createRun({
      ownerId: 'teacher',
      idempotencyKey: 'terminal',
      normalizedInput: { ageYears: 7 },
      workflowVersion: WORKFLOW_VERSION,
      constraintsVersion: CONSTRAINTS_VERSION,
      promptVersions: {},
      limits: {
        maxProviderRequests: 1,
        maxRevisions: 0,
        workflowTimeoutMs: 100,
        attemptTimeoutMs: 50,
        deadlineAt: 100,
        ollamaNumCtx: 1,
        ollamaNumPredict: 1,
      },
      now: 0,
    });
    store.saveCheckpoint({
      runId: terminal.id,
      expectedStateVersion: 0,
      status: 'FAILED',
      phase: 'finished',
      consumed: terminal.consumed,
      state: { error: { retryable: false }, payload: 'secret' },
      now: 1,
    });
    const pending = store.createRun({
      ownerId: 'teacher',
      idempotencyKey: 'pending',
      normalizedInput: { ageYears: 7 },
      workflowVersion: WORKFLOW_VERSION,
      constraintsVersion: CONSTRAINTS_VERSION,
      promptVersions: {},
      limits: terminal.limits,
      now: 0,
    });
    assert.deepEqual(
      store.purgeRetention({ now: 20, contentRetentionMs: 10, tombstoneRetentionMs: 90 }),
      { redacted: 1, deleted: 0 },
    );
    assert.equal(store.getRun(terminal.id)?.contentRedactedAt, 20);
    assert.equal(store.getRun(pending.id)?.status, 'PENDING');
    assert.deepEqual(
      store.purgeRetention({ now: 120, contentRetentionMs: 10, tombstoneRetentionMs: 90 }),
      { redacted: 0, deleted: 1 },
    );
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('redaction removes sensitive keys', () => {
  assert.deepEqual(redact({ authorization: 'secret', content: 'prompt', step: 'checks' }), {
    authorization: '[REDACTED]',
    content: '[REDACTED]',
    step: 'checks',
  });
});
