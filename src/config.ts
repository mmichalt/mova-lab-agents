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

const positiveInt = z.coerce.number().int().positive();

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535),
  LOG_LEVEL: z.enum(logLevels),
  SERVICE_TOKEN: z.string().trim().min(1).regex(/^\S+$/),
  OLLAMA_BASE_URL: httpOrigin,
  OLLAMA_MODEL: z.string().trim().min(1).regex(/^\S+$/),
  OLLAMA_NUM_CTX: positiveInt,
  OLLAMA_NUM_PREDICT: positiveInt,
  LLM_ATTEMPT_TIMEOUT_MS: positiveInt,
  WORKFLOW_TIMEOUT_MS: positiveInt,
});

export type Config = {
  port: number;
  logLevel: (typeof logLevels)[number];
  serviceToken: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaNumCtx: number;
  ollamaNumPredict: number;
  llmAttemptTimeoutMs: number;
  workflowTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    PORT: env.PORT?.trim() || '3000',
    LOG_LEVEL: env.LOG_LEVEL?.trim() || 'info',
    SERVICE_TOKEN: env.SERVICE_TOKEN,
    OLLAMA_BASE_URL: env.OLLAMA_BASE_URL?.trim() || 'http://localhost:11434',
    OLLAMA_MODEL: env.OLLAMA_MODEL?.trim() || 'qwen3:4b-instruct',
    OLLAMA_NUM_CTX: env.OLLAMA_NUM_CTX?.trim() || '4096',
    OLLAMA_NUM_PREDICT: env.OLLAMA_NUM_PREDICT?.trim() || '2000',
    LLM_ATTEMPT_TIMEOUT_MS: env.LLM_ATTEMPT_TIMEOUT_MS?.trim() || '120000',
    WORKFLOW_TIMEOUT_MS: env.WORKFLOW_TIMEOUT_MS?.trim() || '600000',
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return {
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    serviceToken: parsed.data.SERVICE_TOKEN,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaModel: parsed.data.OLLAMA_MODEL,
    ollamaNumCtx: parsed.data.OLLAMA_NUM_CTX,
    ollamaNumPredict: parsed.data.OLLAMA_NUM_PREDICT,
    llmAttemptTimeoutMs: parsed.data.LLM_ATTEMPT_TIMEOUT_MS,
    workflowTimeoutMs: parsed.data.WORKFLOW_TIMEOUT_MS,
  };
}
