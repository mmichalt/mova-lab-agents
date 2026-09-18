import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Config, loadConfig } from './config.ts';
import { closeWorkflowWorker, createWorkflowWorker } from './jobs.ts';
import { createLogger } from './logger.ts';
import { openWorkflowStore } from './persist/store.ts';

export function startWorker(config: Config) {
  const logger = createLogger(config.logLevel);
  const store = openWorkflowStore(config.sqlitePath);
  const worker = createWorkflowWorker({
    config,
    logger,
    store,
    redisUrl: config.redisUrl,
  });
  return { logger, store, worker };
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
    const { logger, store, worker } = startWorker(config);
    logger.info({ sqlitePath: config.sqlitePath, workerId: worker.id }, 'worker ready');
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal }, 'worker shutting down');
      void closeWorkflowWorker(worker).then(
        () => {
          store.close();
          process.exit(0);
        },
        (err: unknown) => {
          logger.error({ err }, 'worker shutdown failed');
          try {
            store.close();
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
