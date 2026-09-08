import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createApp } from '../src/app.ts';

function listeningServers() {
  return process.getActiveResourcesInfo().filter((name) => name === 'TCPServerWrap')
    .length;
}

test('createApp constructs an Express app without opening a port', () => {
  const before = listeningServers();
  const app = createApp();
  assert.equal(typeof app, 'function');
  assert.equal(typeof app.listen, 'function');
  assert.equal(listeningServers(), before);
});
