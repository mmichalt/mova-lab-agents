import { once } from 'node:events';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { createLogger } from '../src/logger.ts';
import { shutDown } from '../src/server.ts';
import { chatFixtures } from './fixtures/ollama.ts';

export type ChatKind = 'vocabulary' | 'generation' | 'revision' | 'age' | 'language';
export type OllamaCall = { method: string; url: string; body: unknown };
export type OllamaReply =
  | { hang: true }
  | { hangBody: true }
  | { status: number; json?: unknown; raw?: string };

export const teacherRequest = {
  ageYears: 7,
  targetSounds: ['р', 'л'],
  difficulty: 'easy',
  theme: 'тварини',
  exerciseCount: 2,
  teacherInstructions: 'Короткі слова та прості фрази.',
};

type After = { after: (fn: () => Promise<void> | void) => void };

export async function listen(app: ReturnType<typeof createApp>) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

export async function fakeOllama(t: After, reply: (call: OllamaCall) => OllamaReply) {
  const calls: OllamaCall[] = [];
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const call: OllamaCall = {
        method: req.method ?? '',
        url: req.url ?? '',
        body: raw ? JSON.parse(raw) : undefined,
      };
      calls.push(call);
      const result = reply(call);
      if ('hang' in result) return;
      if ('hangBody' in result) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
        return;
      }
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(result.raw ?? JSON.stringify(result.json ?? {}));
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => shutDown(server, 50));
  const address = server.address() as AddressInfo;
  return { calls, url: `http://127.0.0.1:${address.port}` };
}

export async function postDrafts(
  t: After,
  options: {
    reply?: (call: OllamaCall) => OllamaReply;
    body?: unknown;
    token?: string | null;
    timeoutMs?: string;
    log?: ReturnType<typeof createLogger>;
  } = {},
) {
  const ollama = await fakeOllama(
    t,
    options.reply ?? (() => ({ status: 500, json: { error: 'unused' } })),
  );
  const chunks: string[] = [];
  const logger =
    options.log ??
    createLogger('info', {
      write(msg) {
        chunks.push(msg);
      },
    });
  const config = loadConfig({
    SERVICE_TOKEN: 'test-token',
    OLLAMA_BASE_URL: ollama.url,
    LLM_ATTEMPT_TIMEOUT_MS: options.timeoutMs ?? '2000',
  });
  const { server, url } = await listen(createApp({ config, logger }));
  t.after(() => shutDown(server, 50));
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? 'test-token'}`;
  const response = await fetch(`${url}/content-drafts`, {
    method: 'POST',
    headers,
    body: JSON.stringify(options.body ?? teacherRequest),
  });
  return { response, ollama, logs: chunks.join('\n') };
}

export function chatCalls(calls: OllamaCall[]) {
  return calls.filter((call) => call.method === 'POST' && call.url === '/api/chat');
}

export function userJson(call: OllamaCall) {
  const payload = call.body as { messages: Array<{ content: string }> };
  return JSON.parse(payload.messages[1]?.content ?? '{}') as unknown;
}

export function chatKind(call: OllamaCall): ChatKind | 'unknown' {
  const system = (call.body as { messages: Array<{ content: string }> }).messages[0]?.content ?? '';
  if (system.includes('Select Ukrainian vocabulary')) return 'vocabulary';
  if (system.includes('Revise Ukrainian recording-exercise')) return 'revision';
  if (system.includes('Produce Ukrainian recording-exercise')) return 'generation';
  if (system.includes('requested child age')) return 'age';
  if (system.includes('Ukrainian wording and theme')) return 'language';
  return 'unknown';
}

export function chatOf(calls: OllamaCall[], kind: ChatKind) {
  return chatCalls(calls).find((call) => chatKind(call) === kind);
}

export function chatsOf(calls: OllamaCall[], kind: ChatKind) {
  return chatCalls(calls).filter((call) => chatKind(call) === kind);
}

export function completedAttempts(logs: string) {
  return logs
    .split('\n')
    .filter((line) => line.includes('llm attempt completed'))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function workflowLog(logs: string) {
  const line = logs.split('\n').find((entry) => entry.includes('workflow finished'));
  return line ? (JSON.parse(line) as Record<string, unknown>) : {};
}

export function runtimeReply(json: unknown): (call: OllamaCall) => OllamaReply {
  return (call) => {
    if (call.method === 'GET' && call.url === '/api/version') {
      return { status: 200, json: { version: '0.33.3' } };
    }
    if (call.method === 'GET' && call.url === '/api/tags') {
      return {
        status: 200,
        json: { models: [{ name: 'qwen3:4b-instruct', digest: 'sha256:abc' }] },
      };
    }
    return { status: 200, json };
  };
}

export function sequentialReply(
  vocabulary: unknown = chatFixtures.vocabulary,
  generated: unknown = chatFixtures.generated,
  review: unknown = chatFixtures.reviewPassed,
): (call: OllamaCall) => OllamaReply {
  const meta = runtimeReply(generated);
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      const kind = chatKind(call);
      if (kind === 'vocabulary') return { status: 200, json: vocabulary };
      if (kind === 'generation' || kind === 'revision') return { status: 200, json: generated };
      return { status: 200, json: review };
    }
    return meta(call);
  };
}

export function reviewReply(replies: {
  age?: OllamaReply | ((call: OllamaCall) => OllamaReply);
  language?: OllamaReply | ((call: OllamaCall) => OllamaReply);
}): (call: OllamaCall) => OllamaReply {
  const after = afterVocabulary({ status: 200, json: chatFixtures.generated });
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      const kind = chatKind(call);
      const reply =
        kind === 'age' ? replies.age : kind === 'language' ? replies.language : undefined;
      if (reply) return typeof reply === 'function' ? reply(call) : reply;
    }
    return after(call);
  };
}

export function afterVocabulary(
  reply: OllamaReply | ((call: OllamaCall) => OllamaReply),
): (call: OllamaCall) => OllamaReply {
  let chats = 0;
  const meta = runtimeReply(chatFixtures.vocabulary);
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      chats += 1;
      if (chats === 1) return { status: 200, json: chatFixtures.vocabulary };
      return typeof reply === 'function' ? reply(call) : reply;
    }
    return meta(call);
  };
}

export function scriptedChats(
  script: Partial<Record<ChatKind, OllamaReply | OllamaReply[]>>,
): (call: OllamaCall) => OllamaReply {
  const queues = Object.fromEntries(
    Object.entries(script).map(([kind, replies]) => [
      kind,
      Array.isArray(replies) ? [...replies] : [replies],
    ]),
  ) as Partial<Record<ChatKind, OllamaReply[]>>;
  const fallback = sequentialReply();
  return (call) => {
    if (call.method === 'POST' && call.url === '/api/chat') {
      const kind = chatKind(call);
      if (kind !== 'unknown') {
        const next = queues[kind]?.shift();
        if (next) return next;
      }
    }
    return fallback(call);
  };
}
