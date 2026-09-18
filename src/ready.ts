import type { Config } from './config.ts';
import type { WorkflowJobProducer } from './jobs.ts';
import { ollamaModelReady } from './llm/ollama.ts';
import type { WorkflowStore } from './persist/store.ts';

export type Readiness = {
  status: 'ok' | 'not_ready';
  sqlite: 'ok' | 'unavailable';
  redis?: 'ok' | 'unavailable';
  model: 'ok' | 'missing' | 'not_required' | 'unavailable';
};

export async function inspectReadiness(options: {
  config: Config;
  store?: WorkflowStore;
  queue?: Pick<WorkflowJobProducer, 'ready'>;
  role?: 'api' | 'worker';
}): Promise<Readiness> {
  const sqlite = pingStore(options.store);
  const needsQueue = options.role === 'worker' || options.queue !== undefined;
  const redis = needsQueue ? await pingQueue(options.queue) : 'not_required';
  const model =
    options.role === 'worker' || options.queue === undefined
      ? await ollamaModelReady(options.config)
      : 'not_required';
  return {
    status:
      sqlite === 'ok' && redis !== 'unavailable' && (model === 'ok' || model === 'not_required')
        ? 'ok'
        : 'not_ready',
    sqlite,
    ...(redis === 'not_required' ? {} : { redis }),
    model,
  };
}

async function pingQueue(queue?: Pick<WorkflowJobProducer, 'ready'>) {
  if (!queue?.ready) return 'unavailable' as const;
  try {
    return await queue.ready();
  } catch {
    return 'unavailable' as const;
  }
}

function pingStore(store?: WorkflowStore): 'ok' | 'unavailable' {
  if (!store) return 'unavailable';
  try {
    store.ping();
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
