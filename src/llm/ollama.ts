import { z } from 'zod';
import type { Config } from '../config.ts';
import type { LlmUsage } from '../content/schemas.ts';
import { AppError } from '../errors.ts';

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
}): Promise<ChatAttempt> {
  const { config } = options;
  const signal = AbortSignal.timeout(config.llmAttemptTimeoutMs);
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
    'The model request timed out.',
  );

  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    if (response.status === 404) {
      throw new AppError(503, 'MODEL_UNAVAILABLE', 'The configured model is not available.');
    }
    if (response.status === 400 || response.status === 500) {
      throw new AppError(503, 'MODEL_CAPACITY', 'The model cannot complete the request.');
    }
    throw new AppError(503, 'PROVIDER_UNAVAILABLE', 'The model server is unavailable.');
  }

  const envelope = parseEnvelope(await readBody(response, signal));
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
  const runtime = await readRuntime(config, model, signal);
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

async function readRuntime(config: Config, model: string, signal: AbortSignal) {
  const empty = { version: null as string | null, digest: null as string | null };
  if (signal.aborted) return empty;
  const meta = AbortSignal.any([signal, AbortSignal.timeout(2000)]);
  const [versionRes, tagsRes] = await Promise.all([
    tryFetch(ollamaUrl(config.ollamaBaseUrl, 'api/version'), meta),
    tryFetch(ollamaUrl(config.ollamaBaseUrl, 'api/tags'), meta),
  ]);
  return {
    version: versionRes?.ok ? stringField(await readJson(versionRes, meta), 'version') : null,
    digest: tagsRes?.ok ? modelDigest(await readJson(tagsRes, meta), model) : null,
  };
}

async function readJson(response: Response, signal: AbortSignal) {
  try {
    return JSON.parse(await readBody(response, signal)) as unknown;
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

async function requestOllama(url: URL, init: RequestInit, timeoutMessage: string) {
  try {
    return await fetch(url, init);
  } catch (err) {
    throw mapFetchError(err, timeoutMessage);
  }
}

async function tryFetch(url: URL, signal: AbortSignal) {
  try {
    return await fetch(url, { signal });
  } catch {
    return undefined;
  }
}

async function readBody(response: Response, signal: AbortSignal) {
  if (signal.aborted) {
    throw mapFetchError(signal.reason, 'The model request timed out.');
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
        throw mapFetchError(signal.reason, 'The model request timed out.');
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
      : mapFetchError(signal.aborted ? signal.reason : err, 'The model request timed out.');
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function aborted(signal: AbortSignal) {
  return new Promise<'aborted'>((resolve) => {
    signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

function mapFetchError(err: unknown, timeoutMessage: string) {
  if (isAbort(err)) {
    return new AppError(504, 'PROVIDER_TIMEOUT', timeoutMessage);
  }
  return new AppError(503, 'PROVIDER_UNAVAILABLE', 'The model server is unavailable.');
}

function isAbort(err: unknown) {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
}

function ollamaUrl(baseUrl: string, path: string) {
  return new URL(path, `${baseUrl}/`);
}
