import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  type Context,
  context,
  propagation,
  ROOT_CONTEXT,
  SpanKind,
  trace,
} from '@opentelemetry/api';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Config } from './config.ts';
import {
  actorIdFrom,
  approveContentGeneration,
  createContentGeneration,
  getContentGeneration,
  idempotencyKeyFrom,
  rejectContentGeneration,
  resumeContentGeneration,
} from './content/runs.ts';
import { generateContentDrafts } from './content/workflow.ts';
import { AppError } from './errors.ts';
import type { WorkflowJobProducer } from './jobs.ts';
import { type Clock, clientDisconnected } from './llm/execution.ts';
import type { Logger } from './logger.ts';
import {
  getObservability,
  type Observability,
  safeException,
  spanContextRecord,
} from './observability.ts';
import type { WorkflowStore } from './persist/store.ts';
import { inspectReadiness } from './ready.ts';

const jsonLimitBytes = 16 * 1024;

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

export function createApp(options: {
  config: Config;
  logger: Logger;
  store?: WorkflowStore;
  testRoutes?: boolean;
  clock?: Clock;
  maxProviderRequests?: number;
  maxInFlightWorkflows?: number;
  queue?: WorkflowJobProducer;
  observability?: Observability;
}) {
  const app = express();
  const observability = options.observability ?? getObservability(options.config);
  const admission = createInFlightAdmission(options.maxInFlightWorkflows ?? 1);
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const requestId = randomUUID();
    const parent = propagation.extract(ROOT_CONTEXT, req.headers, headerGetter);
    const span = observability.startSpan(
      'http.request',
      {
        kind: SpanKind.SERVER,
        attributes: {
          'http.request.method': req.method,
          'url.path': req.path,
          'service.request_id': requestId,
        },
      },
      parent,
    );
    const spanContext = trace.setSpan(parent, span);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      span.setAttribute('http.response.status_code', res.statusCode);
      span.end();
    };
    res.once('finish', end);
    res.once('close', end);
    res.locals.requestId = requestId;
    res.locals.log = options.logger.child({ requestId });
    res.locals.observability = observability;
    res.locals.traceContext = spanContext;
    res.locals.traceRecord = spanContextRecord(span);
    res.setHeader('x-request-id', requestId);
    context.with(spanContext, next);
  });
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });
  app.get('/ready', async (_req, res, next) => {
    try {
      const readiness = await inspectReadiness({
        config: options.config,
        store: options.store,
      });
      res.status(readiness.status === 'ok' ? 200 : 503).json(readiness);
    } catch (err) {
      next(err);
    }
  });
  const json = express.json({ limit: jsonLimitBytes });
  const auth = requireServiceToken(options.config.serviceToken);
  app.post('/content-drafts', auth, json, (req, res, next) => {
    res.setHeader('deprecation', 'true');
    void withRequestAbort(res, next, async (signal) => {
      const release = admission.tryAcquire();
      if (!release) throw capacityError();
      try {
        res.json(
          await generateContentDrafts({
            config: options.config,
            logger: res.locals.log as Logger,
            requestId: res.locals.requestId as string,
            body: req.body,
            clock: options.clock,
            maxProviderRequests: options.maxProviderRequests,
            signal,
            observability,
          }),
        );
      } finally {
        release();
      }
    });
  });
  app.post('/workflows/content-generation', auth, json, (req, res, next) => {
    void withRequestAbort(res, next, async (signal) => {
      const created = await createContentGeneration({
        store: requireStore(options.store),
        config: options.config,
        logger: res.locals.log as Logger,
        requestId: res.locals.requestId as string,
        ownerId: actorIdFrom(req),
        idempotencyKey: idempotencyKeyFrom(req),
        body: req.body,
        clock: options.clock,
        maxProviderRequests: options.maxProviderRequests,
        signal,
        observability,
        traceContext: res.locals.traceRecord,
        admission: options.queue ? undefined : admission,
        queue: options.queue,
      });
      res
        .status(options.queue && created.created ? 202 : created.created ? 201 : 200)
        .json(created.resource);
    });
  });
  app.get('/workflows/:id', auth, (req, res, next) => {
    try {
      res.json(
        getContentGeneration(
          requireStore(options.store),
          String(req.params.id),
          actorIdFrom(req),
          options.clock?.now(),
          isContentAdmin(req),
        ),
      );
    } catch (err) {
      next(err);
    }
  });
  app.post('/workflows/:id/approve', auth, requireContentAdmin, json, (req, res, next) => {
    void withRequestAbort(res, next, async (signal) => {
      const store = requireStore(options.store);
      const existing = store.getApproval(String(req.params.id));
      const resource = await approveContentGeneration({
        store,
        config: options.config,
        logger: res.locals.log as Logger,
        requestId: res.locals.requestId as string,
        ownerId: actorIdFrom(req),
        id: String(req.params.id),
        body: req.body,
        clock: options.clock,
        signal,
        canReview: true,
        queue: options.queue,
        observability,
        traceContext: res.locals.traceRecord,
      });
      res.status(options.queue && !existing ? 202 : 200).json(resource);
    });
  });
  app.post('/workflows/:id/reject', auth, requireContentAdmin, json, (req, res, next) => {
    void withRequestAbort(res, next, async (signal) => {
      res.json(
        await rejectContentGeneration({
          store: requireStore(options.store),
          config: options.config,
          logger: res.locals.log as Logger,
          requestId: res.locals.requestId as string,
          ownerId: actorIdFrom(req),
          id: String(req.params.id),
          body: req.body,
          clock: options.clock,
          signal,
          canReview: true,
          queue: options.queue,
          observability,
          traceContext: res.locals.traceRecord,
        }),
      );
    });
  });
  app.post('/workflows/:id/resume', auth, (req, res, next) => {
    void withRequestAbort(res, next, async (signal) => {
      const release = options.queue ? () => {} : admission.tryAcquire();
      if (!release) throw capacityError();
      try {
        const resource = await resumeContentGeneration({
          store: requireStore(options.store),
          config: options.config,
          logger: res.locals.log as Logger,
          requestId: res.locals.requestId as string,
          ownerId: actorIdFrom(req),
          id: String(req.params.id),
          clock: options.clock,
          maxProviderRequests: options.maxProviderRequests,
          signal,
          canReview: isContentAdmin(req),
          queue: options.queue,
          observability,
        });
        res.status(options.queue ? 202 : 200).json(resource);
      } finally {
        release();
      }
    });
  });
  if (options.testRoutes) {
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

function requireContentAdmin(req: Request, _res: Response, next: NextFunction) {
  try {
    actorIdFrom(req);
    if (!isContentAdmin(req)) {
      throw new AppError(403, 'FORBIDDEN', 'Content Admin authority is required.');
    }
    next();
  } catch (err) {
    next(err);
  }
}

function isContentAdmin(req: Request) {
  return req.get('x-content-admin')?.trim().toLowerCase() === 'true';
}

function createInFlightAdmission(max: number) {
  let inFlight = 0;
  return {
    tryAcquire() {
      if (inFlight >= max) return undefined;
      inFlight += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          inFlight -= 1;
        }
      };
    },
  };
}

function capacityError() {
  return new AppError(429, 'WORKFLOW_CAPACITY_EXCEEDED', 'Workflow capacity is currently full.');
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
    const span = trace.getSpan(res.locals.traceContext as Context);
    span?.recordException(
      safeException(err, (res.locals.observability as Observability).diagnosticCapture),
    );
    span?.setStatus({ code: 2 });
    (res.locals.log as Logger | undefined)?.error({ err }, 'request failed');
  }
  res.status(mapped.status).json({
    error: {
      code: mapped.code,
      message: mapped.message,
      requestId: res.locals.requestId,
      ...(mapped.workflowId ? { workflowId: mapped.workflowId } : {}),
    },
  });
}

const headerGetter = {
  get(carrier: Record<string, string | string[] | undefined>, key: string) {
    return carrier[key];
  },
  keys(carrier: Record<string, string | string[] | undefined>) {
    return Object.keys(carrier);
  },
};

function withRequestAbort(
  res: Response,
  next: NextFunction,
  work: (signal: AbortSignal) => Promise<void>,
) {
  const requestAbort = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) requestAbort.abort(clientDisconnected());
  };
  res.on('close', onClose);
  return work(requestAbort.signal)
    .catch(next)
    .finally(() => {
      res.off('close', onClose);
    });
}

function requireStore(store: WorkflowStore | undefined) {
  if (!store) {
    throw new AppError(503, 'SQLITE_UNAVAILABLE', 'Workflow storage is unavailable.');
  }
  return store;
}

function mapError(err: unknown) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      workflowId: err.workflowId,
    };
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
