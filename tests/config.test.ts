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
