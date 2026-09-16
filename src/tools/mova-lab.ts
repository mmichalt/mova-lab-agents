import { z } from 'zod';
import type { Config } from '../config.ts';
import { normalizePhrase } from '../content/validation.ts';
import { AppError } from '../errors.ts';
import { abortError } from '../llm/execution.ts';

export const GENERATION_CONTRACT_VERSION = 'recording-generation/v1';
export const SEARCH_QUERY_MAX_LENGTH = 120;
export const SEARCH_RESULT_LIMIT_MAX = 20;
export const SEARCH_RESULT_LIMIT_DEFAULT = 10;
export const CATEGORY_RESULT_LIMIT_MAX = 200;

const maxBodyBytes = 64 * 1024;

export const EXPECTED_CONSTRAINTS = {
  version: GENERATION_CONTRACT_VERSION,
  targetSounds: ['р', 'л'],
  difficulties: ['easy'],
  exerciseTypes: ['recording'],
  limits: {
    ageYears: { min: 1, max: 18 },
    targetSounds: { min: 1, max: 2 },
    exerciseCount: { default: 6, min: 1, max: 12, minPerTargetSound: 1 },
    theme: { maxLength: 120 },
    teacherInstructions: { maxLength: 1000 },
    vocabulary: { maxItems: 24, maxWordLength: 80 },
    generated: {
      titleMaxLength: 160,
      phraseMaxLength: 500,
      childHintMaxLength: 500,
      teacherNoteMaxLength: 1000,
    },
    search: { maxQueryLength: SEARCH_QUERY_MAX_LENGTH, maxResults: SEARCH_RESULT_LIMIT_MAX },
  },
} as const;

const nonempty = (max: number) => z.string().trim().min(1).max(max);
const categoryOptionSchema = z
  .object({
    id: nonempty(128),
    name: nonempty(200),
    slug: nonempty(200).optional(),
  })
  .strip();

const constraintsSchema = z.strictObject({
  version: z.literal(GENERATION_CONTRACT_VERSION),
  targetSounds: z.tuple([z.literal('р'), z.literal('л')]),
  difficulties: z.tuple([z.literal('easy')]),
  exerciseTypes: z.tuple([z.literal('recording')]),
  limits: z.strictObject({
    ageYears: z.strictObject({ min: z.literal(1), max: z.literal(18) }),
    targetSounds: z.strictObject({ min: z.literal(1), max: z.literal(2) }),
    exerciseCount: z.strictObject({
      default: z.literal(6),
      min: z.literal(1),
      max: z.literal(12),
      minPerTargetSound: z.literal(1),
    }),
    theme: z.strictObject({ maxLength: z.literal(120) }),
    teacherInstructions: z.strictObject({ maxLength: z.literal(1000) }),
    vocabulary: z.strictObject({ maxItems: z.literal(24), maxWordLength: z.literal(80) }),
    generated: z.strictObject({
      titleMaxLength: z.literal(160),
      phraseMaxLength: z.literal(500),
      childHintMaxLength: z.literal(500),
      teacherNoteMaxLength: z.literal(1000),
    }),
    search: z.strictObject({
      maxQueryLength: z.literal(SEARCH_QUERY_MAX_LENGTH),
      maxResults: z.literal(SEARCH_RESULT_LIMIT_MAX),
    }),
  }),
});

const categoriesSchema = z.strictObject({
  version: z.literal(GENERATION_CONTRACT_VERSION),
  items: z.array(categoryOptionSchema).max(CATEGORY_RESULT_LIMIT_MAX),
});

const searchHitSchema = z
  .object({
    id: nonempty(128),
    title: nonempty(500),
    phrase: nonempty(2000),
    targetSound: nonempty(16).optional(),
    difficulty: nonempty(32).optional(),
    category: categoryOptionSchema.optional(),
  })
  .strip();

const searchSchema = z.strictObject({
  version: z.literal(GENERATION_CONTRACT_VERSION),
  hasMore: z.boolean(),
  items: z.array(searchHitSchema).max(SEARCH_RESULT_LIMIT_MAX),
});

const searchArgsSchema = z.strictObject({
  q: nonempty(SEARCH_QUERY_MAX_LENGTH),
  limit: z.int().min(1).max(SEARCH_RESULT_LIMIT_MAX).default(SEARCH_RESULT_LIMIT_DEFAULT),
});

export type GenerationConstraints = z.infer<typeof constraintsSchema>;
export type GenerationCategory = z.infer<typeof categoryOptionSchema>;
export type RecordingSearchHit = z.infer<typeof searchHitSchema>;
export type RecordingSearchResult = {
  version: typeof GENERATION_CONTRACT_VERSION;
  hasMore: boolean;
  items: RecordingSearchHit[];
};

type LabCall = {
  config: Config;
  signal: AbortSignal;
};

export async function readGenerationConstraints(options: LabCall): Promise<GenerationConstraints> {
  return getJson(options, 'api/internal/content-generation/constraints', constraintsSchema);
}

export async function listGenerationCategories(
  options: LabCall,
): Promise<{ version: typeof GENERATION_CONTRACT_VERSION; items: GenerationCategory[] }> {
  const result = await getJson(
    options,
    'api/internal/content-generation/categories',
    categoriesSchema,
  );
  return { version: result.version, items: result.items.slice(0, CATEGORY_RESULT_LIMIT_MAX) };
}

export async function searchRecordingExercises(
  options: LabCall & { q: string; limit?: number },
): Promise<RecordingSearchResult> {
  const parsed = searchArgsSchema.safeParse({ q: options.q, limit: options.limit });
  if (!parsed.success) {
    throw new AppError(400, 'VALIDATION_ERROR', 'Invalid recording-exercise search.');
  }
  const result = await getJson(
    options,
    'api/internal/content-generation/recording-exercises/search',
    searchSchema,
    { q: parsed.data.q, limit: String(parsed.data.limit) },
  );
  if (result.items.length > parsed.data.limit) throw invalidResponse();
  return {
    version: result.version,
    hasMore: result.hasMore,
    items: result.items,
  };
}

export function exactPhraseMatches(
  items: readonly RecordingSearchHit[],
  phrase: string,
): RecordingSearchHit[] {
  const needle = normalizePhrase(phrase);
  return items.filter((item) => normalizePhrase(item.phrase) === needle);
}

async function getJson<T>(
  options: LabCall,
  path: string,
  schema: z.ZodType<T>,
  query?: Record<string, string>,
): Promise<T> {
  const { config, signal: workflowSignal } = options;
  if (workflowSignal.aborted) throw abortError(workflowSignal);
  const signal = AbortSignal.any([workflowSignal, AbortSignal.timeout(config.movaLabTimeoutMs)]);
  const url = apiUrl(config.movaLabBaseUrl, path, query);
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${config.movaLabServiceToken}`,
      },
      signal,
    });
  } catch (err) {
    throw mapFetchError(err, workflowSignal);
  }

  const raw = await readBody(response, signal, workflowSignal);
  if (!response.ok) throw mapStatus(response.status);
  return parseJson(raw, schema);
}

function parseJson<T>(raw: string, schema: z.ZodType<T>): T {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw invalidResponse();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw invalidResponse();
  return parsed.data;
}

function mapStatus(status: number) {
  if (status === 401 || status === 403) {
    return new AppError(503, 'MOVA_LAB_UNAVAILABLE', 'Mova-Lab rejected the service credentials.');
  }
  if (status === 429 || status >= 500) {
    return new AppError(503, 'MOVA_LAB_UNAVAILABLE', 'Mova-Lab is unavailable.');
  }
  return invalidResponse();
}

function invalidResponse() {
  return new AppError(502, 'MOVA_LAB_INVALID_RESPONSE', 'Mova-Lab returned an invalid response.');
}

async function readBody(response: Response, signal: AbortSignal, workflowSignal: AbortSignal) {
  if (signal.aborted) throw mapFetchError(signal.reason, workflowSignal);
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
        if (size > maxBodyBytes) throw invalidResponse();
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
  if (workflowSignal.aborted) return abortError(workflowSignal);
  if (err instanceof AppError) return err;
  if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
    return new AppError(504, 'MOVA_LAB_TIMEOUT', 'The Mova-Lab request timed out.');
  }
  return new AppError(503, 'MOVA_LAB_UNAVAILABLE', 'Mova-Lab is unavailable.');
}

function apiUrl(baseUrl: string, path: string, query?: Record<string, string>) {
  const url = new URL(path, `${baseUrl}/`);
  if (url.origin !== baseUrl) {
    throw new AppError(500, 'INTERNAL_ERROR', 'Internal server error.');
  }
  if (query) {
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  }
  return url;
}
