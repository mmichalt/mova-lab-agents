import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { Logger } from '../logger.ts';

export const MAX_TRANSPORT_ATTEMPTS = 2;
export const MAX_PROVIDER_REQUESTS = 20;
export const BACKOFF_BASE_MS = 200;
export const BACKOFF_CAP_MS = 2000;

export type Clock = {
  now: () => number;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  random: () => number;
};

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep,
  random: () => Math.random(),
};

export type ExecutionLimits = {
  deadlineAt: number;
  attemptTimeoutMs: number;
  maxProviderRequests: number;
  providerRequests: number;
};

export function createLimits(
  config: Config,
  now: number,
  maxProviderRequests = MAX_PROVIDER_REQUESTS,
): ExecutionLimits {
  return {
    deadlineAt: now + config.workflowTimeoutMs,
    attemptTimeoutMs: config.llmAttemptTimeoutMs,
    maxProviderRequests,
    providerRequests: 0,
  };
}

export function remainingMs(limits: ExecutionLimits, now: number) {
  return Math.max(0, limits.deadlineAt - now);
}

export function workflowTimeout() {
  return new AppError(504, 'WORKFLOW_TIMEOUT', 'The workflow deadline was exceeded.');
}

export function clientDisconnected() {
  return new AppError(499, 'CLIENT_DISCONNECTED', 'The client disconnected.');
}

export function abortError(signal: AbortSignal) {
  return signal.reason instanceof AppError ? signal.reason : workflowTimeout();
}

export function isCancellation(err: unknown): err is AppError {
  return (
    err instanceof AppError &&
    (err.code === 'WORKFLOW_TIMEOUT' || err.code === 'CLIENT_DISCONNECTED')
  );
}

export function budgetExhausted() {
  return new AppError(
    503,
    'PROVIDER_BUDGET_EXHAUSTED',
    'The provider request budget was exhausted.',
  );
}

export function isRetryable(err: unknown) {
  return err instanceof AppError && err.retryable;
}

export function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (header == null) return undefined;
  const value = header.trim();
  if (value === '') return undefined;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

export function retryDelayMs(options: {
  failedAttempt: number;
  random: number;
  retryAfterMs?: number;
  remainingMs: number;
}) {
  const computed =
    options.retryAfterMs !== undefined
      ? options.retryAfterMs
      : Math.floor(
          Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (options.failedAttempt - 1)) *
            (0.5 + options.random * 0.5),
        );
  return Math.min(computed, options.remainingMs);
}

export function attemptSignal(limits: ExecutionLimits, workflowSignal: AbortSignal, now: number) {
  if (workflowSignal.aborted) throw abortError(workflowSignal);
  const attemptMs = Math.min(limits.attemptTimeoutMs, remainingMs(limits, now));
  if (attemptMs <= 0) throw workflowTimeout();
  return AbortSignal.any([workflowSignal, AbortSignal.timeout(attemptMs)]);
}

export async function withTransportRetry<T>(
  options: {
    limits: ExecutionLimits;
    clock: Clock;
    signal: AbortSignal;
    logger: Logger;
    requestId: string;
    step: string;
  },
  operation: () => Promise<T>,
): Promise<T> {
  let last: unknown;
  for (let attempt = 1; attempt <= MAX_TRANSPORT_ATTEMPTS; attempt += 1) {
    if (options.signal.aborted) throw abortError(options.signal);
    if (remainingMs(options.limits, options.clock.now()) <= 0) throw workflowTimeout();
    if (options.limits.providerRequests >= options.limits.maxProviderRequests) {
      throw budgetExhausted();
    }
    options.limits.providerRequests += 1;
    try {
      return await operation();
    } catch (err) {
      last = err;
      if (!isRetryable(err) || attempt === MAX_TRANSPORT_ATTEMPTS) throw err;
      if (options.signal.aborted) throw abortError(options.signal);
      const remaining = remainingMs(options.limits, options.clock.now());
      if (remaining <= 0) throw workflowTimeout();
      const wait = retryDelayMs({
        failedAttempt: attempt,
        random: options.clock.random(),
        retryAfterMs: err instanceof AppError ? err.retryAfterMs : undefined,
        remainingMs: remaining,
      });
      if (wait >= remaining) throw err;
      options.logger.warn(
        {
          requestId: options.requestId,
          step: options.step,
          attempt,
          delayMs: wait,
          code: err instanceof AppError ? err.code : 'INTERNAL_ERROR',
        },
        'llm transport retry',
      );
      await options.clock.sleep(wait, options.signal);
    }
  }
  throw last;
}

export function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
