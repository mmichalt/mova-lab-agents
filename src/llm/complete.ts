import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import type { Config } from '../config.ts';
import { AppError } from '../errors.ts';
import type { Logger } from '../logger.ts';
import { type ChatAttempt, ollamaChat } from './ollama.ts';

export const GENERATION_TEMPERATURE = 0.3;

const maxLogChars = 200;

export async function completeStructured<T>(
  schema: z.ZodType<T>,
  options: {
    config: Config;
    logger: Logger;
    requestId: string;
    step: string;
    promptVersion: string;
    system: string;
    user: unknown;
    format: unknown;
    temperature: number;
  },
): Promise<T> {
  const attemptId = randomUUID();
  const started = Date.now();
  let attempt: ChatAttempt;
  try {
    attempt = await ollamaChat({
      config: options.config,
      messages: [
        { role: 'system', content: options.system },
        { role: 'user', content: JSON.stringify(options.user) },
      ],
      format: options.format,
      temperature: options.temperature,
    });
    options.logger.info(
      {
        attemptId,
        requestId: options.requestId,
        step: options.step,
        promptVersion: options.promptVersion,
        model: clip(attempt.model),
        modelDigest: clip(attempt.modelDigest),
        ollamaVersion: clip(attempt.ollamaVersion),
        wallMs: Date.now() - started,
        loadDurationNs: attempt.loadDurationNs,
        usage: attempt.usage,
      },
      'llm attempt completed',
    );
  } catch (err) {
    options.logger.warn(
      {
        attemptId,
        requestId: options.requestId,
        step: options.step,
        promptVersion: options.promptVersion,
        wallMs: Date.now() - started,
        err,
      },
      'llm attempt failed',
    );
    throw err;
  }

  let outputJson: unknown;
  try {
    outputJson = JSON.parse(attempt.content);
  } catch {
    throw invalidOutput(options, attemptId, 'The model returned invalid JSON.');
  }
  const output = schema.safeParse(outputJson);
  if (!output.success) {
    throw invalidOutput(options, attemptId, 'The model returned invalid output.');
  }
  return output.data;
}

export function clip(value: string | null, max = maxLogChars) {
  if (value === null) return null;
  return value.length <= max ? value : value.slice(0, max);
}

function invalidOutput(
  options: { logger: Logger; requestId: string; step: string; promptVersion: string },
  attemptId: string,
  message: string,
): AppError {
  options.logger.warn(
    {
      attemptId,
      requestId: options.requestId,
      step: options.step,
      promptVersion: options.promptVersion,
    },
    'llm output invalid',
  );
  return new AppError(502, 'PROVIDER_INVALID_OUTPUT', message);
}
