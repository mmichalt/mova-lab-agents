import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import type { LlmUsage } from '../content/schemas.ts';
import { AppError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import {
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
  observed?: { modelTag: string | null; modelDigest: string | null };
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
  const attempt = await completeChat({ ...options, allowToolCalls: false, tools: undefined });
  let outputJson: unknown;
  try {
    outputJson = JSON.parse(attempt.content);
  } catch {
    throw invalidOutput(options, 'The model returned invalid JSON.');
  }
  const output = schema.safeParse(outputJson);
  if (!output.success) {
    throw invalidOutput(options, 'The model returned invalid output.');
  }
  return output.data;
}

export async function completeChat(options: ChatOptions): Promise<ChatAttempt> {
  return withTransportRetry(
    {
      limits: options.limits,
      clock: options.clock,
      signal: options.signal,
      logger: options.logger,
      requestId: options.requestId,
      step: options.step,
    },
    () => chatOnce(options),
  );
}

async function chatOnce(options: ChatOptions): Promise<ChatAttempt> {
  const attemptId = randomUUID();
  const started = options.clock.now();
  try {
    const attempt = await ollamaChat({
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
    if (options.expectedModelTag && attempt.model !== options.expectedModelTag) {
      throw new AppError(409, 'MODEL_TAG_CHANGED', 'The model tag changed during recovery.');
    }
    if (options.expectedModelDigest && attempt.modelDigest !== options.expectedModelDigest) {
      throw new AppError(409, 'MODEL_DIGEST_CHANGED', 'The model digest changed during recovery.');
    }
    options.observed ??= { modelTag: null, modelDigest: null };
    options.observed.modelTag = attempt.model;
    if (attempt.modelDigest && !options.observed.modelDigest) {
      options.observed.modelDigest = attempt.modelDigest;
    }
    options.logger.info(
      {
        attemptId,
        requestId: options.requestId,
        step: options.step,
        promptVersion: options.promptVersion,
        model: clip(attempt.model),
        modelDigest: clip(attempt.modelDigest),
        ollamaVersion: clip(attempt.ollamaVersion),
        wallMs: options.clock.now() - started,
        loadDurationNs: attempt.loadDurationNs,
        usage: attempt.usage,
      },
      'llm attempt completed',
    );
    return attempt;
  } catch (err) {
    options.logger.warn(
      {
        attemptId,
        requestId: options.requestId,
        step: options.step,
        promptVersion: options.promptVersion,
        wallMs: options.clock.now() - started,
        err,
      },
      'llm attempt failed',
    );
    throw err;
  }
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
