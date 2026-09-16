import type { Config } from './config.ts';
import { ollamaModelReady } from './llm/ollama.ts';
import type { WorkflowStore } from './persist/store.ts';

export type Readiness = {
  status: 'ok' | 'not_ready';
  sqlite: 'ok' | 'unavailable';
  model: 'ok' | 'missing' | 'unavailable';
};

export async function inspectReadiness(options: {
  config: Config;
  store?: WorkflowStore;
}): Promise<Readiness> {
  const sqlite = pingStore(options.store);
  const model = await ollamaModelReady(options.config);
  return {
    status: sqlite === 'ok' && model === 'ok' ? 'ok' : 'not_ready',
    sqlite,
    model,
  };
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
