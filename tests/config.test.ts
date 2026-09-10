import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.ts';

const root = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

test('loadConfig defaults empty PORT and LOG_LEVEL', () => {
  const config = loadConfig({ SERVICE_TOKEN: '  token\n', PORT: '   ', LOG_LEVEL: '' });
  assert.equal(config.port, 3000);
  assert.equal(config.logLevel, 'info');
  assert.equal(config.serviceToken, 'token');
  assert.equal(config.ollamaBaseUrl, 'http://localhost:11434');
  assert.equal(config.ollamaModel, 'qwen3:4b-instruct');
  assert.equal(config.ollamaNumCtx, 4096);
  assert.equal(config.ollamaNumPredict, 2000);
  assert.equal(config.llmAttemptTimeoutMs, 120000);
  assert.equal(config.workflowTimeoutMs, 600000);
});

test('loadConfig rejects missing, empty, or invalid values', () => {
  assert.throws(() => loadConfig({}), /Invalid configuration/);
  assert.throws(() => loadConfig({ SERVICE_TOKEN: '' }), /Invalid configuration/);
  assert.throws(() => loadConfig({ SERVICE_TOKEN: '   ' }), /Invalid configuration/);
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'tok en' }),
    (err: Error) => {
      assert.match(err.message, /Invalid configuration/);
      assert.equal(err.message.includes('tok en'), false);
      return true;
    },
  );
  assert.throws(() => loadConfig({ SERVICE_TOKEN: 'token', PORT: 'abc' }), /Invalid configuration/);
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', LOG_LEVEL: 'verbose' }),
    /Invalid configuration/,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', OLLAMA_BASE_URL: 'file:///tmp' }),
    /Invalid configuration/,
  );
  assert.throws(
    () =>
      loadConfig({ SERVICE_TOKEN: 'token', OLLAMA_BASE_URL: 'http://user:pass@localhost:11434' }),
    /Invalid configuration/,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', LLM_ATTEMPT_TIMEOUT_MS: '0' }),
    /Invalid configuration/,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', WORKFLOW_TIMEOUT_MS: '0' }),
    /Invalid configuration/,
  );
  assert.equal(
    loadConfig({ SERVICE_TOKEN: 'token', LLM_ATTEMPT_TIMEOUT_MS: '1' }).llmAttemptTimeoutMs,
    1,
  );
  assert.equal(
    loadConfig({ SERVICE_TOKEN: 'token', WORKFLOW_TIMEOUT_MS: '2147483647' }).workflowTimeoutMs,
    2_147_483_647,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', WORKFLOW_TIMEOUT_MS: '2147483648' }),
    /Invalid configuration/,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', LLM_ATTEMPT_TIMEOUT_MS: '2147483648' }),
    /Invalid configuration/,
  );
  assert.throws(
    () => loadConfig({ SERVICE_TOKEN: 'token', OLLAMA_BASE_URL: 'http://localhost:11434/proxy' }),
    /Invalid configuration/,
  );
});

test('invalid configuration exits before listening', async () => {
  const env = { ...process.env };
  delete env.SERVICE_TOKEN;
  const child = spawn(process.execPath, ['src/server.ts'], {
    cwd: root,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const stderrChunks: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => stderrChunks.push(chunk));
  const [code] = await once(child, 'exit');
  assert.notEqual(code, 0);
  assert.match(Buffer.concat(stderrChunks).toString(), /Invalid configuration/);
});
