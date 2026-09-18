import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const httpOrigin = z.url({ protocol: /^https?$/ }).transform((value, ctx) => {
  const url = new URL(value);
  if (url.username !== '' || url.password !== '') {
    ctx.addIssue({ code: 'custom', message: 'Must not include credentials' });
    return z.NEVER;
  }
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    ctx.addIssue({ code: 'custom', message: 'Must not include a path, query, or fragment' });
    return z.NEVER;
  }
  return url.origin;
});

const redisUrl = z.url({ protocol: /^rediss?$/ });
const optionalHttpUrl = z
  .url({ protocol: /^https?$/ })
  .nullable()
  .optional()
  .transform((value) => value ?? null);

const positiveInt = z.coerce.number().int().positive();
const booleanEnv = z.enum(['true', 'false']).transform((value) => value === 'true');
/** Node `setTimeout` / `AbortSignal.timeout` treat values above this as 1 ms. */
export const MAX_NODE_TIMEOUT_MS = 2_147_483_647;
const timeoutMs = positiveInt.max(MAX_NODE_TIMEOUT_MS);

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535),
  LOG_LEVEL: z.enum(logLevels),
  SERVICE_TOKEN: z.string().trim().min(1).regex(/^\S+$/),
  MOVA_LAB_BASE_URL: httpOrigin,
  MOVA_LAB_SERVICE_TOKEN: z.string().trim().min(1).regex(/^\S+$/),
  MOVA_LAB_TIMEOUT_MS: timeoutMs,
  OLLAMA_BASE_URL: httpOrigin,
  OLLAMA_MODEL: z.string().trim().min(1).regex(/^\S+$/),
  OLLAMA_NUM_CTX: positiveInt,
  OLLAMA_NUM_PREDICT: positiveInt,
  LLM_ATTEMPT_TIMEOUT_MS: timeoutMs,
  WORKFLOW_TIMEOUT_MS: timeoutMs,
  SQLITE_PATH: z
    .string()
    .trim()
    .min(1)
    .refine((value) => value !== ':memory:', { error: 'Must be a filesystem path' }),
  REDIS_URL: redisUrl,
  EXPERIMENTAL_SUPERVISOR: booleanEnv,
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalHttpUrl,
  OTEL_SERVICE_NAME: z.string().trim().min(1).regex(/^\S+$/),
  DIAGNOSTIC_CAPTURE: z.enum(['off', 'redacted']),
});

export type Config = {
  port: number;
  logLevel: (typeof logLevels)[number];
  serviceToken: string;
  movaLabBaseUrl: string;
  movaLabServiceToken: string;
  movaLabTimeoutMs: number;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
  llmAttemptTimeoutMs: number;
  workflowTimeoutMs: number;
  sqlitePath: string;
  redisUrl: string;
  experimentalSupervisor: boolean;
  otelExporterOtlpEndpoint: string | null;
  otelServiceName: string;
  diagnosticCapture: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    PORT: env.PORT?.trim() || '3000',
    LOG_LEVEL: env.LOG_LEVEL?.trim() || 'info',
    SERVICE_TOKEN: env.SERVICE_TOKEN,
    MOVA_LAB_BASE_URL: env.MOVA_LAB_BASE_URL,
    MOVA_LAB_SERVICE_TOKEN: env.MOVA_LAB_SERVICE_TOKEN,
    MOVA_LAB_TIMEOUT_MS: env.MOVA_LAB_TIMEOUT_MS?.trim() || '10000',
    OLLAMA_BASE_URL: env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434',
    OLLAMA_MODEL: env.OLLAMA_MODEL?.trim() || 'qwen3:4b-instruct',
    OLLAMA_NUM_CTX: env.OLLAMA_NUM_CTX?.trim() || '4096',
    OLLAMA_NUM_PREDICT: env.OLLAMA_NUM_PREDICT?.trim() || '2000',
    LLM_ATTEMPT_TIMEOUT_MS: env.LLM_ATTEMPT_TIMEOUT_MS?.trim() || '120000',
    WORKFLOW_TIMEOUT_MS: env.WORKFLOW_TIMEOUT_MS?.trim() || '600000',
    SQLITE_PATH: env.SQLITE_PATH?.trim() || 'data/workflows.sqlite',
    REDIS_URL: env.REDIS_URL?.trim() || 'redis://localhost:6379',
    EXPERIMENTAL_SUPERVISOR: env.EXPERIMENTAL_SUPERVISOR?.trim() || 'false',
    OTEL_EXPORTER_OTLP_ENDPOINT: env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || null,
    OTEL_SERVICE_NAME: env.OTEL_SERVICE_NAME?.trim() || 'mova-lab-agents',
    DIAGNOSTIC_CAPTURE: env.DIAGNOSTIC_CAPTURE?.trim() || 'off',
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return {
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    serviceToken: parsed.data.SERVICE_TOKEN,
    movaLabBaseUrl: parsed.data.MOVA_LAB_BASE_URL,
    movaLabServiceToken: parsed.data.MOVA_LAB_SERVICE_TOKEN,
    movaLabTimeoutMs: parsed.data.MOVA_LAB_TIMEOUT_MS,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaModel: parsed.data.OLLAMA_MODEL,
    ollamaNumCtx: parsed.data.OLLAMA_NUM_CTX,
    ollamaNumPredict: parsed.data.OLLAMA_NUM_PREDICT,
    llmAttemptTimeoutMs: parsed.data.LLM_ATTEMPT_TIMEOUT_MS,
    workflowTimeoutMs: parsed.data.WORKFLOW_TIMEOUT_MS,
    sqlitePath: parsed.data.SQLITE_PATH,
    redisUrl: parsed.data.REDIS_URL,
    experimentalSupervisor: parsed.data.EXPERIMENTAL_SUPERVISOR,
    otelExporterOtlpEndpoint: parsed.data.OTEL_EXPORTER_OTLP_ENDPOINT,
    otelServiceName: parsed.data.OTEL_SERVICE_NAME,
    diagnosticCapture: parsed.data.DIAGNOSTIC_CAPTURE === 'redacted',
  };
}
