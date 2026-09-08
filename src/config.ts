import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const schema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535),
  LOG_LEVEL: z.enum(logLevels),
  SERVICE_TOKEN: z.string().trim().min(1).regex(/^\S+$/),
});

export type Config = {
  port: number;
  logLevel: (typeof logLevels)[number];
  serviceToken: string;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse({
    PORT: env.PORT?.trim() || '3000',
    LOG_LEVEL: env.LOG_LEVEL?.trim() || 'info',
    SERVICE_TOKEN: env.SERVICE_TOKEN,
  });
  if (!parsed.success) {
    throw new Error(`Invalid configuration: ${z.prettifyError(parsed.error)}`);
  }
  return {
    port: parsed.data.PORT,
    logLevel: parsed.data.LOG_LEVEL,
    serviceToken: parsed.data.SERVICE_TOKEN,
  };
}
