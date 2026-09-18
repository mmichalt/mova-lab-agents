import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Config, loadConfig } from './config.ts';
import { closeWorkflowWorker, createWorkflowQueue, createWorkflowWorker } from './jobs.ts';
import { createLogger } from './logger.ts';
import { getObservability } from './observability.ts';
import { openWorkflowStore } from './persist/store.ts';
import { inspectReadiness } from './ready.ts';

export async function startWorker(config: Config) {
  const logger = createLogger(config.logLevel);
  const store = openWorkflowStore(config.sqlitePath);
  const queue = createWorkflowQueue(config.redisUrl, logger);
  const observability = getObservability(config);
  try {
    const readiness = await inspectReadiness({ config, store, queue, role: 'worker' });
    if (readiness.status !== 'ok') {
      throw new Error(`Worker readiness failed: ${JSON.stringify(readiness)}`);
    }
    const worker = createWorkflowWorker({
      config,
      logger,
      store,
      redisUrl: config.redisUrl,
      queue,
      observability,
    });
    return { logger, store, queue, worker, observability };
  } catch (err) {
    await queue.close();
    store.close();
    await observability.shutdown();
    throw err;
  }
}

function isEntrypoint() {
  return (
    process.argv[1] !== undefined &&
    import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  );
}

if (isEntrypoint()) {
  try {
    const config = loadConfig();
    const { logger, store, queue, worker, observability } = await startWorker(config);
    logger.info({ sqlitePath: config.sqlitePath, workerId: worker.id }, 'worker ready');
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, 'worker shutting down');
      void closeWorkflowWorker(worker).then(
        async () => {
          await queue.close();
          store.close();
          await observability.shutdown();
          process.exit(0);
        },
        async (err: unknown) => {
          logger.error({ err }, 'worker shutdown failed');
          try {
            await queue.close();
            store.close();
            await observability.shutdown();
          } finally {
            process.exit(1);
          }
        },
      );
    };
    process.on('SIGTERM', () => stop('SIGTERM'));
    process.on('SIGINT', () => stop('SIGINT'));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
