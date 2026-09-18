import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { LlmUsage } from '../content/schemas.ts';
import { AppError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import {
  diagnosticAttributes,
  type Observability,
  type ProviderTiming,
  withSpan,
} from '../observability.ts';
import {
  type AttemptRecorder,
  type AttemptReservation,
  attemptSignal,
  type Clock,
  type ExecutionLimits,
  withTransportRetry,
} from './execution.ts';
import { type ChatAttempt, type ChatMessage, ollamaChat } from './ollama.ts';

export const GENERATION_TEMPERATURE = 0.3;

const maxLogChars = 200;

export type LlmCall = {
  config: Config;
  logger: Logger;
  requestId: string;
  limits: ExecutionLimits;
  signal: AbortSignal;
  clock: Clock;
  usage: LlmUsage[];
  attempts?: AttemptRecorder;
  candidateVersion?: number | null;
  observed?: {
    modelTag: string | null;
    modelDigest: string | null;
    ollamaVersion?: string | null;
    quantization?: string | null;
  };
  observability?: Observability;
  timing?: ProviderTiming[];
  expectedModelTag?: string | null;
  expectedModelDigest?: string | null;
};

type ChatOptions = LlmCall & {
  step: string;
  promptVersion: string;
  temperature: number;
  format?: unknown;
  tools?: unknown[];
  allowToolCalls?: boolean;
  messages?: ChatMessage[];
  system?: string;
  user?: unknown;
};

export async function completeStructured<T>(
  schema: z.ZodType<T>,
  options: ChatOptions & { format: unknown },
): Promise<T> {
  return withChatRetry(options, (reservation) => structuredOnce(schema, options, reservation));
}

export async function completeChat(options: ChatOptions): Promise<ChatAttempt> {
  return withChatRetry(options, (reservation) => chatOnce(options, reservation));
}

function withChatRetry<T>(
  options: ChatOptions,
  operation: (reservation?: AttemptReservation) => Promise<T>,
): Promise<T> {
  return withTransportRetry(
    {
      limits: options.limits,
      clock: options.clock,
      signal: options.signal,
      logger: options.logger,
      requestId: options.requestId,
      step: options.step,
      candidateVersion: options.candidateVersion,
      operationKey: `${options.step}:${options.candidateVersion ?? 0}`,
      attempts: options.attempts,
    },
    operation,
  );
}

async function structuredOnce<T>(
  schema: z.ZodType<T>,
  options: ChatOptions,
  reservation?: AttemptReservation,
): Promise<T> {
  const attempt = await chatOnce(options, reservation, false);
  let data: T;
  try {
    data = parseStructured(schema, options, attempt.content);
  } catch (err) {
    const mapped =
      err instanceof AppError ? err : invalidOutput(options, 'The model returned invalid output.');
    failAttempt(options, reservation, mapped, attempt);
    throw mapped;
  }
  finishAttempt(options, reservation, attempt);
  return data;
}

async function chatOnce(
  options: ChatOptions,
  reservation?: AttemptReservation,
  finish = true,
): Promise<ChatAttempt> {
  const attemptId = randomUUID();
  const started = options.clock.now();
  let attempt: ChatAttempt;
  let timingRecorded = false;
  try {
    attempt = await withSpan(
      options.observability,
      'llm.provider_attempt',
      {
        attributes: {
          'llm.step': options.step,
          'llm.prompt_version': options.promptVersion,
          'llm.attempt_id': attemptId,
          ...diagnosticAttributes(options.observability, { step: options.step }),
        },
      },
      async (span) => {
        const result = await ollamaChat({
          config: options.config,
          messages:
            options.messages ??
            ([
              { role: 'system', content: options.system ?? '' },
              { role: 'user', content: JSON.stringify(options.user) },
            ] satisfies ChatMessage[]),
          format: options.format,
          tools: options.tools,
          allowToolCalls: options.allowToolCalls,
          temperature: options.temperature,
          signal: attemptSignal(options.limits, options.signal, options.clock.now()),
          workflowSignal: options.signal,
          now: options.clock.now(),
          usage: options.usage,
        });
        span.setAttributes({
          'llm.input_tokens': result.usage.inputTokens ?? -1,
          'llm.cached_input_tokens': result.usage.cachedInputTokens ?? -1,
          'llm.output_tokens': result.usage.outputTokens ?? -1,
          'llm.load_duration_ns': result.loadDurationNs ?? -1,
          'llm.prompt_evaluation_duration_ns': result.promptEvaluationDurationNs ?? -1,
          'llm.generation_duration_ns': result.generationDurationNs ?? -1,
          'llm.duration_units': 'nanoseconds',
        });
        return result;
      },
    );
    attempt = { ...attempt, wallDurationMs: Math.max(0, options.clock.now() - started) };
    options.timing?.push({
      wallDurationMs: attempt.wallDurationMs ?? null,
      loadDurationNs: attempt.loadDurationNs,
      promptEvaluationDurationNs: attempt.promptEvaluationDurationNs,
      generationDurationNs: attempt.generationDurationNs,
    });
    timingRecorded = true;
    if (options.expectedModelTag && attempt.model !== options.expectedModelTag) {
      throw new AppError(409, 'MODEL_TAG_CHANGED', 'The model tag changed during recovery.');
    }
    if (options.expectedModelDigest && attempt.modelDigest !== options.expectedModelDigest) {
      throw new AppError(409, 'MODEL_DIGEST_CHANGED', 'The model digest changed during recovery.');
    }
    options.observed ??= { modelTag: null, modelDigest: null };
    if (options.observed.modelTag && options.observed.modelTag !== attempt.model) {
      throw new AppError(409, 'MODEL_TAG_CHANGED', 'The model tag changed during this run.');
    }
    if (options.observed.modelDigest && options.observed.modelDigest !== attempt.modelDigest) {
      throw new AppError(409, 'MODEL_DIGEST_CHANGED', 'The model digest changed during this run.');
    }
    if (
      options.observed.ollamaVersion &&
      options.observed.ollamaVersion !== attempt.ollamaVersion
    ) {
      throw new AppError(
        409,
        'OLLAMA_VERSION_CHANGED',
        'The Ollama runtime changed during this run.',
      );
    }
    options.observed.modelTag = attempt.model;
    options.observed.modelDigest ??= attempt.modelDigest;
    options.observed.ollamaVersion ??= attempt.ollamaVersion;
    options.observed.quantization ??= attempt.quantization;
  } catch (err) {
    if (!timingRecorded) {
      options.timing?.push({
        wallDurationMs: Math.max(0, options.clock.now() - started),
        loadDurationNs: null,
        promptEvaluationDurationNs: null,
        generationDurationNs: null,
      });
    }
    failAttempt(options, reservation, err);
    options.logger.warn(
      {
        attemptId,
        requestId: options.requestId,
        step: options.step,
        promptVersion: options.promptVersion,
        wallMs: options.clock.now() - started,
        errorCode: err instanceof AppError ? err.code : 'INTERNAL_ERROR',
      },
      'llm attempt failed',
    );
    throw err;
  }
  if (finish) finishAttempt(options, reservation, attempt);
  return attempt;
}

function parseStructured<T>(schema: z.ZodType<T>, options: ChatOptions, content: string): T {
  let outputJson: unknown;
  try {
    outputJson = JSON.parse(content);
  } catch {
    throw invalidOutput(options, 'The model returned invalid JSON.');
  }
  const output = schema.safeParse(outputJson);
  if (!output.success) {
    throw invalidOutput(options, 'The model returned invalid output.');
  }
  return output.data;
}

function finishAttempt(
  options: ChatOptions,
  reservation: AttemptReservation | undefined,
  attempt: ChatAttempt,
) {
  if (reservation) {
    options.attempts?.finish(reservation, {
      outcome: 'completed',
      finishedAt: options.clock.now(),
      usage: {
        ...attempt.usage,
        modelDigest: attempt.modelDigest,
        ollamaVersion: attempt.ollamaVersion,
      },
      error: null,
      modelTag: attempt.model,
      modelDigest: attempt.modelDigest,
    });
  }
  options.logger.info(
    {
      attemptId: randomUUID(),
      requestId: options.requestId,
      step: options.step,
      promptVersion: options.promptVersion,
      model: clip(attempt.model),
      modelDigest: clip(attempt.modelDigest),
      ollamaVersion: clip(attempt.ollamaVersion),
      loadDurationNs: attempt.loadDurationNs,
      usage: attempt.usage,
    },
    'llm attempt completed',
  );
}

function failAttempt(
  options: ChatOptions,
  reservation: AttemptReservation | undefined,
  err: unknown,
  attempt?: ChatAttempt,
) {
  if (!reservation) return;
  options.attempts?.finish(reservation, {
    outcome: 'failed',
    finishedAt: options.clock.now(),
    usage: attempt
      ? {
          ...attempt.usage,
          modelDigest: attempt.modelDigest,
          ollamaVersion: attempt.ollamaVersion,
        }
      : null,
    error: attemptError(err),
    modelTag: attempt?.model,
    modelDigest: attempt?.modelDigest,
    ollamaVersion: attempt?.ollamaVersion,
  });
}

function attemptError(err: unknown) {
  return err instanceof AppError
    ? { code: err.code, status: err.status, retryable: err.retryable }
    : { code: 'INTERNAL_ERROR', status: 500, retryable: false };
}

export function clip(value: string | null, max = maxLogChars) {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

function invalidOutput(
  options: { logger: Logger; requestId: string; step: string; promptVersion: string },
  message: string,
): AppError {
  options.logger.warn(
    {
      requestId: options.requestId,
      step: options.step,
      promptVersion: options.promptVersion,
    },
    'llm output invalid',
  );
  return new AppError(502, 'PROVIDER_INVALID_OUTPUT', message);
}
