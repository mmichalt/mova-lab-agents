import { z } from 'zod';
import type { Config } from '../config.ts';
import type { LlmUsage } from '../content/schemas.ts';
import { AppError } from '../errors.ts';
import { parseRetryAfterMs, workflowTimeout } from './execution.ts';

const maxProviderBodyBytes = 1024 * 1024;

const envelopeSchema = z.object({
  model: z.string().min(1).optional(),
  message: z.object({
    content: z.string().optional(),
    tool_calls: z.array(z.unknown()).optional(),
  }),
  done: z.boolean(),
  done_reason: z.string().optional(),
  load_duration: z.number().nonnegative().optional(),
  prompt_eval_count: z.int().nonnegative().optional(),
  prompt_eval_cached_count: z.int().nonnegative().optional(),
  eval_count: z.int().nonnegative().optional(),
});

type ChatEnvelope = z.infer<typeof envelopeSchema>;

export type ChatAttempt = {
  content: string;
  model: string;
  modelDigest: string | null;
  ollamaVersion: string | null;
  loadDurationNs: number | null;
  usage: LlmUsage;
};

export async function ollamaChat(options: {
  config: Config;
  messages: Array<{ role: 'system' | 'user'; content: string }>;
  format: unknown;
  temperature: number;
  signal: AbortSignal;
  workflowSignal: AbortSignal;
  now?: number;
}): Promise<ChatAttempt> {
  const { config, signal, workflowSignal } = options;
  const payload = {
    model: config.ollamaModel,
    messages: options.messages,
    stream: false,
    format: options.format,
    options: {
      temperature: options.temperature,
      num_ctx: config.ollamaNumCtx,
      num_predict: config.ollamaNumPredict,
    },
  };

  const response = await requestOllama(
    ollamaUrl(config.ollamaBaseUrl, 'api/chat'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    },
    workflowSignal,
  );

  if (!response.ok) {
    const retryAfterMs = parseRetryAfterMs(
      response.headers.get('retry-after'),
      options.now ?? Date.now(),
    );
    throw mapStatus(response.status, await errorHint(response), retryAfterMs);
  }

  const envelope = parseEnvelope(await readBody(response, signal, workflowSignal));
  if (envelope.message.tool_calls && envelope.message.tool_calls.length > 0) {
    throw new AppError(
      502,
      'PROVIDER_UNEXPECTED_TOOL_CALL',
      'The model returned an unexpected tool call.',
    );
  }
  if (!envelope.done || envelope.done_reason === 'length') {
    throw new AppError(502, 'PROVIDER_INCOMPLETE', 'The model output was incomplete.');
  }
  if (typeof envelope.message.content !== 'string') {
    throw new AppError(502, 'PROVIDER_INVALID_OUTPUT', 'The model returned invalid output.');
  }

  const model = envelope.model ?? config.ollamaModel;
  const runtime = await readRuntime(config, model, signal, workflowSignal);
  return {
    content: envelope.message.content,
    model,
    modelDigest: runtime.digest,
    ollamaVersion: runtime.version,
    loadDurationNs: envelope.load_duration ?? null,
    usage: usageOf(model, envelope),
  };
}

function parseEnvelope(raw: string): ChatEnvelope {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new AppError(502, 'PROVIDER_INVALID_OUTPUT', 'The model returned invalid output.');
  }
  const parsed = envelopeSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError(502, 'PROVIDER_INVALID_OUTPUT', 'The model returned invalid output.');
  }
  return parsed.data;
}

function usageOf(model: string, envelope: ChatEnvelope): LlmUsage {
  return {
    model,
    inputTokens: countOf(envelope.prompt_eval_count),
    cachedInputTokens: countOf(envelope.prompt_eval_cached_count),
    outputTokens: countOf(envelope.eval_count),
    estimatedCostUsd: null,
  };
}

function countOf(value: number | undefined) {
  return value === undefined ? null : value;
}

async function readRuntime(
  config: Config,
  model: string,
  signal: AbortSignal,
  workflowSignal: AbortSignal,
) {
  const empty = { version: null as string | null, digest: null as string | null };
  if (signal.aborted) return empty;
  const meta = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const [versionRes, tagsRes] = await Promise.all([
    tryFetch(ollamaUrl(config.ollamaBaseUrl, 'api/version'), meta),
    tryFetch(ollamaUrl(config.ollamaBaseUrl, 'api/tags'), meta),
  ]);
  return {
    version: versionRes?.ok
      ? stringField(await readJson(versionRes, meta, workflowSignal), 'version')
      : null,
    digest: tagsRes?.ok ? modelDigest(await readJson(tagsRes, meta, workflowSignal), model) : null,
  };
}

async function readJson(response: Response, signal: AbortSignal, workflowSignal: AbortSignal) {
  try {
    return JSON.parse(await readBody(response, signal, workflowSignal)) as unknown;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown, key: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === 'string' && field.length > 0 ? field : null;
}

function modelDigest(value: unknown, model: string) {
  if (typeof value !== 'object' || value === null || !('models' in value)) return null;
  if (!Array.isArray(value.models)) return null;
  const found = value.models.find((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return item.name === model || item.model === model;
  }) as Record<string, unknown> | undefined;
  return typeof found?.digest === 'string' && found.digest.length > 0 ? found.digest : null;
}

function mapStatus(status: number, hint: string, retryAfterMs?: number) {
  if (status === 404) {
    return new AppError(503, 'MODEL_UNAVAILABLE', 'The configured model is not available.');
  }
  if (status === 400 || isCapacity(hint) || (status === 500 && !isOverload(hint))) {
    return new AppError(503, 'MODEL_CAPACITY', 'The model cannot complete the request.');
  }
  if (status === 429 || status === 503 || isOverload(hint)) {
    return new AppError(503, 'PROVIDER_UNAVAILABLE', 'The model server is unavailable.', {
      retryable: true,
      retryAfterMs,
    });
  }
  return new AppError(503, 'PROVIDER_UNAVAILABLE', 'The model server is unavailable.');
}

function isCapacity(hint: string) {
  return /out of memory|\booms?\b|more system memory|invalid options|unsupported/.test(hint);
}

function isOverload(hint: string) {
  return /busy|overload|too many requests|queue/.test(hint);
}

async function errorHint(response: Response) {
  try {
    const raw = (await response.text()).slice(0, 4096);
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
      const error = (parsed as { error: unknown }).error;
      if (typeof error === 'string') return error.toLowerCase();
    }
    return raw.toLowerCase();
  } catch {
    return '';
  }
}

async function requestOllama(url: URL, init: RequestInit, workflowSignal: AbortSignal) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw mapFetchError(err, workflowSignal);
  }
}

async function tryFetch(url: URL, signal: AbortSignal) {
  try {
    return await fetch(url, { signal });
  } catch {
    return undefined;
  }
}

async function readBody(response: Response, signal: AbortSignal, workflowSignal: AbortSignal) {
  if (signal.aborted) {
    throw mapFetchError(signal.reason, workflowSignal);
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  const aborting = aborted(signal);
  let size = 0;
  try {
    for (;;) {
      const reading = reader.read();
      const result = await Promise.race([reading, aborting]);
      if (result === 'aborted') {
        void reading.catch(() => {});
        throw mapFetchError(signal.reason, workflowSignal);
      }
      if (result.done) break;
      if (result.value) {
        size += result.value.byteLength;
        if (size > maxProviderBodyBytes) {
          throw new AppError(502, 'PROVIDER_INVALID_OUTPUT', 'The model returned invalid output.');
        }
        chunks.push(result.value);
      }
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    throw err instanceof AppError
      ? err
      : mapFetchError(signal.aborted ? signal.reason : err, workflowSignal);
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function aborted(signal: AbortSignal) {
  return new Promise<'aborted'>((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

function mapFetchError(err: unknown, workflowSignal: AbortSignal) {
  if (isAbort(err)) {
    if (workflowSignal.aborted) return workflowTimeout();
    return new AppError(504, 'PROVIDER_TIMEOUT', 'The model request timed out.');
  }
  return new AppError(503, 'PROVIDER_UNAVAILABLE', 'The model server is unavailable.', {
    retryable: true,
  });
}

function isAbort(err: unknown) {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function ollamaUrl(baseUrl: string, path: string) {
  return new URL(path, `${baseUrl}/`);
}
