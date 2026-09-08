import type { Server } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createApp } from './app.ts';
import { type Config, loadConfig } from './config.ts';
import { createLogger, type Logger } from './logger.ts';

export const SHUTDOWN_DRAIN_MS = 10_000;

export function startServer(config: Config, logger: Logger) {
  const app = createApp({ config, logger });
  const server = app.listen(config.port);
  server.on('listening', () => {
    logger.info({ port: listeningPort(server) }, 'listening');
  });
  return server;
}

export function shutDown(server: Server, drainMs = SHUTDOWN_DRAIN_MS) {
  server.closeIdleConnections();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      server.closeAllConnections();
    }, drainMs);
    server.close((err) => {
      clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    });
  });
}

function listeningPort(server: Server) {
  const address = server.address();
  return typeof address === 'object' && address ? address.port : address;
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
    const logger = createLogger(config.logLevel);
    const server = startServer(config, logger);
    server.on('error', (err) => {
      logger.error({ err }, 'listen failed');
      process.exit(1);
    });
    let stopping = false;
    const stop = (signal: string) => {
      if (stopping) return;
      stopping = true;
      logger.info({ signal, drainMs: SHUTDOWN_DRAIN_MS }, 'shutting down');
      void shutDown(server).then(
        () => process.exit(0),
        (err: unknown) => {
          logger.error({ err }, 'shutdown failed');
          process.exit(1);
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
