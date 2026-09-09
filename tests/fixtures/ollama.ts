import { readFileSync } from 'node:fs';

const examples = new URL('../../docs/examples/', import.meta.url);

export const generatedContent = readFileSync(new URL('model-output.json', examples), 'utf8');
export const vocabularyContent = readFileSync(new URL('vocabulary-output.json', examples), 'utf8');
export const reviewPassedContent = readFileSync(new URL('review-output.json', examples), 'utf8');
export const reviewFailedContent = readFileSync(
  new URL('review-output.failed.json', examples),
  'utf8',
);
export const reviewRefusedContent = readFileSync(
  new URL('review-output.refused.json', examples),
  'utf8',
);
export const refusedContent = JSON.stringify(
  JSON.parse(readFileSync(new URL('model-output.refused.json', examples), 'utf8')),
);
export const refusedVocabularyContent = JSON.stringify(
  JSON.parse(readFileSync(new URL('vocabulary-output.refused.json', examples), 'utf8')),
);

export function chatEnvelope(overrides: Record<string, unknown> = {}) {
  return JSON.parse(
    JSON.stringify({
      model: 'qwen3:4b-instruct',
      created_at: '2026-01-01T00:00:00Z',
      message: { role: 'assistant', content: generatedContent },
      done: true,
      done_reason: 'stop',
      load_duration: 12,
      prompt_eval_count: 10,
      prompt_eval_cached_count: 2,
      eval_count: 20,
      ...overrides,
    }),
  ) as Record<string, unknown>;
}

export const chatFixtures = {
  generated: chatEnvelope(),
  vocabulary: chatEnvelope({ message: { role: 'assistant', content: vocabularyContent } }),
  generatedMissingUsage: chatEnvelope({
    load_duration: undefined,
    prompt_eval_count: undefined,
    prompt_eval_cached_count: undefined,
    eval_count: undefined,
  }),
  vocabularyMissingUsage: chatEnvelope({
    message: { role: 'assistant', content: vocabularyContent },
    load_duration: undefined,
    prompt_eval_count: undefined,
    prompt_eval_cached_count: undefined,
    eval_count: undefined,
  }),
  refused: chatEnvelope({ message: { role: 'assistant', content: refusedContent } }),
  refusedVocabulary: chatEnvelope({
    message: { role: 'assistant', content: refusedVocabularyContent },
  }),
  reviewPassed: chatEnvelope({ message: { role: 'assistant', content: reviewPassedContent } }),
  reviewFailed: chatEnvelope({ message: { role: 'assistant', content: reviewFailedContent } }),
  reviewRefused: chatEnvelope({ message: { role: 'assistant', content: reviewRefusedContent } }),
  reviewMissingUsage: chatEnvelope({
    message: { role: 'assistant', content: reviewPassedContent },
    load_duration: undefined,
    prompt_eval_count: undefined,
    prompt_eval_cached_count: undefined,
    eval_count: undefined,
  }),
  freeText: chatEnvelope({ message: { role: 'assistant', content: 'I cannot help with that.' } }),
  invalidJson: chatEnvelope({ message: { role: 'assistant', content: '{not json' } }),
  wrongShape: chatEnvelope({
    message: { role: 'assistant', content: '{"status":"generated","proposals":[]}' },
  }),
  malformedEnvelope: { ok: true },
  truncated: chatEnvelope({ done: true, done_reason: 'length' }),
  incomplete: chatEnvelope({ done: false }),
  toolCall: chatEnvelope({
    message: {
      role: 'assistant',
      content: generatedContent,
      tool_calls: [{ function: { name: 'x' } }],
    },
  }),
};

export const errorBodies = {
  missingModel: { error: 'model not found' },
  overload: { error: 'busy' },
  loadFailure: { error: 'model requires more system memory' },
  oom: { error: 'CUDA out of memory' },
  unsupportedSettings: { error: 'invalid options' },
  tooManyRequests: { error: 'too many requests' },
};
