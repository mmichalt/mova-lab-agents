import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import { startWorker } from '../src/worker.ts';
import { testEnv } from './drafts-harness.ts';

test('worker startup refuses unavailable Redis before accepting jobs', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'worker-ready-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const config = loadConfig(
    testEnv({
      LOG_LEVEL: 'silent',
      OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      REDIS_URL: 'redis://127.0.0.1:1',
      SQLITE_PATH: path.join(dir, 'workflows.sqlite'),
    }),
  );

  await assert.rejects(startWorker(config), /"redis":"unavailable"/);
});
