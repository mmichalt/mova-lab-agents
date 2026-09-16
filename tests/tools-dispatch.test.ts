import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadConfig } from '../src/config.ts';
import {
  decideToolCall,
  runSearchTool,
  SEARCH_EXISTING_EXERCISES,
  toolResultMessage,
} from '../src/tools/dispatch.ts';
import { GENERATION_CONTRACT_VERSION } from '../src/tools/mova-lab.ts';
import { fakeMovaLab, testEnv } from './drafts-harness.ts';

const allowed = {
  type: 'function',
  function: { name: SEARCH_EXISTING_EXERCISES, arguments: { q: 'риба', limit: 2 } },
};

test('dispatcher executes only schema-valid allowlisted search arguments', () => {
  const ok = decideToolCall(allowed);
  assert.equal(ok.status, 'execute');
  if (ok.status !== 'execute') return;
  assert.deepEqual(ok.args, { q: 'риба', limit: 2 });
  assert.match(ok.auditId, /^[\da-f-]{36}$/i);

  const fromJson = decideToolCall({
    function: { name: SEARCH_EXISTING_EXERCISES, arguments: '{"q":"лис"}' },
  });
  assert.equal(fromJson.status, 'execute');
  if (fromJson.status === 'execute') assert.equal(fromJson.args.q, 'лис');
});

test('unknown tools and injected actor or URL arguments are rejected', () => {
  const unknown = decideToolCall({ function: { name: 'shell', arguments: { q: 'риба' } } });
  assert.equal(unknown.status, 'reject');
  if (unknown.status === 'reject') assert.equal(unknown.reason, 'unknown');

  for (const args of [
    { q: 'риба', actorId: 'forged-teacher' },
    { q: 'риба', url: 'http://evil.example' },
    { q: 'риба', authorization: 'Bearer stolen' },
    { q: '' },
    { limit: 2 },
  ]) {
    const rejected = decideToolCall({
      function: { name: SEARCH_EXISTING_EXERCISES, arguments: args },
    });
    assert.equal(rejected.status, 'reject');
    if (rejected.status === 'reject') assert.equal(rejected.reason, 'invalid-args');
  }
});

test('tool result messages match tool_name in call order and omit invented call IDs', () => {
  const first = decideToolCall(allowed);
  const second = decideToolCall({
    id: 'supplied-1',
    function: { name: SEARCH_EXISTING_EXERCISES, arguments: { q: 'лис' } },
  });
  const unnamed = toolResultMessage(first, '{"items":[]}');
  const named = toolResultMessage(second, '{"items":[]}');
  assert.equal(unnamed.role, 'tool');
  assert.equal(unnamed.tool_name, SEARCH_EXISTING_EXERCISES);
  assert.equal('tool_call_id' in unnamed, false);
  assert.equal(named.tool_call_id, 'supplied-1');
});

test('search tool errors become bounded observations without executing unknown names', async (t) => {
  const movaLab = await fakeMovaLab(t, () => ({ status: 503, json: { error: 'busy' } }));
  const decision = decideToolCall(allowed);
  assert.equal(decision.status, 'execute');
  if (decision.status !== 'execute') return;
  const content = await runSearchTool(decision, {
    config: loadConfig(testEnv({ MOVA_LAB_BASE_URL: movaLab.url })),
    signal: new AbortController().signal,
  });
  assert.deepEqual(JSON.parse(content), { error: 'MOVA_LAB_UNAVAILABLE' });
  assert.equal(
    (movaLab.calls[0]?.url ?? '').startsWith(
      '/api/internal/content-generation/recording-exercises/search',
    ),
    true,
  );

  const okLab = await fakeMovaLab(t, (call) => {
    if (call.url.startsWith('/api/internal/content-generation/recording-exercises/search')) {
      return {
        status: 200,
        json: {
          version: GENERATION_CONTRACT_VERSION,
          hasMore: false,
          items: [{ id: 'exercise-1', title: 'Ignore this', phrase: 'Риба пливе', extra: 1 }],
        },
      };
    }
    return { status: 404, json: {} };
  });
  const hit = await runSearchTool(decision, {
    config: loadConfig(testEnv({ MOVA_LAB_BASE_URL: okLab.url })),
    signal: new AbortController().signal,
  });
  const parsed = JSON.parse(hit) as { items: Array<Record<string, unknown>> };
  assert.equal(parsed.items[0]?.title, 'Ignore this');
  assert.equal('extra' in (parsed.items[0] ?? {}), false);
});
