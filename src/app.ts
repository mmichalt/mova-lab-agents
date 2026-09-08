import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.ts';
import type { Logger } from './logger.ts';

const jsonLimitBytes = 16 * 1024;

export class AppError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

export function requireServiceToken(expected: string) {
  return (req: Request, _res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? '';
    const token = /^Bearer (\S+)$/i.exec(header)?.[1] ?? '';
    if (!equalToken(token, expected)) {
      next(new AppError(401, 'UNAUTHORIZED', 'Authentication required.'));
      return;
    }
    next();
  };
}

export function createApp(options: { config: Config; logger: Logger; testRoutes?: boolean }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.locals.log = options.logger.child({ requestId });
    res.setHeader('x-request-id', requestId);
    next();
  });
  app.use(express.json({ limit: jsonLimitBytes }));
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  if (options.testRoutes) {
    const auth = requireServiceToken(options.config.serviceToken);
    let protectedHits = 0;
    app.post('/__test/protected', auth, (_req, res) => {
      protectedHits += 1;
      res.json({ ok: true, hits: protectedHits });
    });
    app.get('/__test/boom', () => {
      throw new Error('boom-secret');
    });
    app.get('/__test/hang', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('.');
    });
  }
  app.use((_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'Not found.'));
  });
  app.use(errorHandler);
  return app;
}

function equalToken(actual: string, expected: string) {
  return timingSafeEqual(
    createHash('sha256').update(actual).digest(),
    createHash('sha256').update(expected).digest(),
  );
}

function errorHandler(err: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent) {
    next(err);
    return;
  }
  const mapped = mapError(err);
  if (mapped.status >= 500) {
    (res.locals.log as Logger | undefined)?.error({ err }, 'request failed');
  }
  res.status(mapped.status).json({
    error: {
      code: mapped.code,
      message: mapped.message,
      requestId: res.locals.requestId,
    },
  });
}

function mapError(err: unknown) {
  if (err instanceof AppError) {
    return { status: err.status, code: err.code, message: err.message };
  }
  const type = typeof err === 'object' && err !== null && 'type' in err ? String(err.type) : '';
  if (type === 'entity.too.large') {
    return { status: 413, code: 'PAYLOAD_TOO_LARGE', message: 'JSON body exceeds 16 KiB.' };
  }
  if (type === 'entity.parse.failed' || (err instanceof SyntaxError && statusOf(err) === 400)) {
    return { status: 400, code: 'MALFORMED_JSON', message: 'Malformed JSON body.' };
  }
  const status = typeof err === 'object' && err !== null ? statusOf(err) : undefined;
  if (status !== undefined && status >= 400 && status < 500) {
    return { status, code: 'BAD_REQUEST', message: 'Invalid request.' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error.' };
}

function statusOf(err: object) {
  if ('status' in err && typeof err.status === 'number') return err.status;
  if ('statusCode' in err && typeof err.statusCode === 'number') return err.statusCode;
  return undefined;
}
