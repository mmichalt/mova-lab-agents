import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AppError } from '../src/errors.ts';
import {
  attemptSignal,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type Clock,
  type ExecutionLimits,
  parseRetryAfterMs,
  retryDelayMs,
  withTransportRetry,
} from '../src/llm/execution.ts';
import { createLogger } from '../src/logger.ts';

const logger = createLogger('silent');

function limits(overrides: Partial<ExecutionLimits> = {}): ExecutionLimits {
  return {
    deadlineAt: 10_000,
    attemptTimeoutMs: 120_000,
    maxProviderRequests: 20,
    providerRequests: 0,
    ...overrides,
  };
}

function clock(
  overrides: Partial<Clock> & { sleeps?: number[] } = {},
): Clock & { sleeps: number[] } {
  const sleeps = overrides.sleeps ?? [];
  return {
    now: () => 0,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 1,
    ...overrides,
    sleeps,
  };
}

function retryable(retryAfterMs?: number) {
  return new AppError(503, 'PROVIDER_UNAVAILABLE', 'unavailable', {
    retryable: true,
    retryAfterMs,
  });
}

test('retryDelayMs jitters exponential backoff and caps it', () => {
  assert.equal(retryDelayMs({ failedAttempt: 1, random: 1, remainingMs: 10_000 }), BACKOFF_BASE_MS);
  assert.equal(
    retryDelayMs({ failedAttempt: 1, random: 0, remainingMs: 10_000 }),
    BACKOFF_BASE_MS / 2,
  );
  assert.equal(retryDelayMs({ failedAttempt: 8, random: 1, remainingMs: 10_000 }), BACKOFF_CAP_MS);
  assert.equal(
    retryDelayMs({ failedAttempt: 1, random: 1, retryAfterMs: 5_000, remainingMs: 1_500 }),
    1_500,
  );
});

test('parseRetryAfterMs reads delta seconds and HTTP dates', () => {
  assert.equal(parseRetryAfterMs('2', 0), 2000);
  assert.equal(
    parseRetryAfterMs('Fri, 01 Jan 2026 00:00:05 GMT', Date.parse('2026-01-01T00:00:00Z')),
    5000,
  );
  assert.equal(parseRetryAfterMs('not-a-date', 0), undefined);
  assert.equal(parseRetryAfterMs(null, 0), undefined);
});

test('withTransportRetry succeeds after one retryable failure', async () => {
  const calls: number[] = [];
  const used = clock();
  const budget = limits();
  const result = await withTransportRetry(
    {
      limits: budget,
      clock: used,
      signal: new AbortController().signal,
      logger,
      requestId: 'req',
      step: 'generation',
    },
    async () => {
      calls.push(1);
      if (calls.length === 1) throw retryable();
      return 'ok';
    },
  );
  assert.equal(result, 'ok');
  assert.equal(calls.length, 2);
  assert.equal(budget.providerRequests, 2);
  assert.deepEqual(used.sleeps, [BACKOFF_BASE_MS]);
});

test('withTransportRetry uses Retry-After and does not retry permanent errors', async () => {
  const used = clock();
  await withTransportRetry(
    {
      limits: limits(),
      clock: used,
      signal: new AbortController().signal,
      logger,
      requestId: 'req',
      step: 'generation',
    },
    async () => {
      if (used.sleeps.length === 0) throw retryable(0);
      return 'ok';
    },
  );
  assert.deepEqual(used.sleeps, [0]);

  let attempts = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: limits(),
          clock: clock(),
          signal: new AbortController().signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          attempts += 1;
          throw new AppError(503, 'MODEL_UNAVAILABLE', 'missing');
        },
      ),
    (err: AppError) => err.code === 'MODEL_UNAVAILABLE',
  );
  assert.equal(attempts, 1);
});

test('withTransportRetry stops at two attempts, deadline, abort, and budget', async () => {
  let exhausted = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: limits(),
          clock: clock(),
          signal: new AbortController().signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          exhausted += 1;
          throw retryable(0);
        },
      ),
    (err: AppError) => err.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal(exhausted, 2);

  let deadlineCalls = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: limits({ deadlineAt: 0 }),
          clock: clock({ now: () => 1 }),
          signal: new AbortController().signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          deadlineCalls += 1;
          return 'nope';
        },
      ),
    (err: AppError) => err.code === 'WORKFLOW_TIMEOUT',
  );
  assert.equal(deadlineCalls, 0);

  const aborted = new AbortController();
  aborted.abort();
  let abortCalls = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: limits(),
          clock: clock(),
          signal: aborted.signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          abortCalls += 1;
          return 'nope';
        },
      ),
    (err: AppError) => err.code === 'WORKFLOW_TIMEOUT',
  );
  assert.equal(abortCalls, 0);

  const budget = limits({ maxProviderRequests: 1, providerRequests: 1 });
  let budgetCalls = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: budget,
          clock: clock(),
          signal: new AbortController().signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          budgetCalls += 1;
          return 'nope';
        },
      ),
    (err: AppError) => err.code === 'PROVIDER_BUDGET_EXHAUSTED',
  );
  assert.equal(budgetCalls, 0);
});

test('withTransportRetry does not start a retry after remaining time is consumed', async () => {
  let attempts = 0;
  await assert.rejects(
    () =>
      withTransportRetry(
        {
          limits: limits({ deadlineAt: 100 }),
          clock: clock({ now: () => 50, random: () => 1 }),
          signal: new AbortController().signal,
          logger,
          requestId: 'req',
          step: 'generation',
        },
        async () => {
          attempts += 1;
          throw retryable(200);
        },
      ),
    (err: AppError) => err.code === 'PROVIDER_UNAVAILABLE',
  );
  assert.equal(attempts, 1);
});

test('attemptSignal aborts at remaining workflow time, not the full attempt timeout', async () => {
  const started = Date.now();
  const signal = attemptSignal(
    limits({ deadlineAt: started + 40, attemptTimeoutMs: 5000 }),
    new AbortController().signal,
    started,
  );
  await new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 20, `elapsed ${elapsed}`);
  assert.ok(elapsed < 250, `elapsed ${elapsed}`);
});
