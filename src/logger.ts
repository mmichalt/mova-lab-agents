import pino from 'pino';
import type { Config } from './config.ts';

export type Logger = pino.Logger;

export function createLogger(level: Config['logLevel'], stream?: pino.DestinationStream) {
  return pino(
    {
      level,
      redact: {
        paths: [
          'req.headers.authorization',
          'headers.authorization',
          'authorization',
          '*.authorization',
          'serviceToken',
          '*.serviceToken',
        ],
        remove: true,
      },
    },
    stream,
  );
}
