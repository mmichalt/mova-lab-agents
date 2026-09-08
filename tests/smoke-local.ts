import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import { GENERATION_TEMPERATURE, PROMPT_VERSION } from '../src/content/generate.ts';
import { type ContentRequest, contentRequestSchema } from '../src/content/schemas.ts';
import { assessGeneration } from './properties.ts';

const corpus = JSON.parse(
  readFileSync(new URL('../evals/corpus.json', import.meta.url), 'utf8'),
) as {
  cases: Array<{ id: string; request: unknown }>;
};

const byId = Object.fromEntries(corpus.cases.map((item) => [item.id, item]));

function parseCase(id: string) {
  const item = byId[id];
  if (!item) throw new Error(`Missing corpus case ${id}`);
  return contentRequestSchema.parse(item.request);
}

function json(value: Response) {
  return value.json() as Promise<Record<string, unknown>>;
}

async function timed<T>(fn: () => Promise<T>) {
  const started = Date.now();
  const value = await fn();
  return { value, wallMs: Date.now() - started };
}

async function get(url: URL) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  return json(response);
}

function gpuShare(ps: Record<string, unknown>, model: string) {
  const models = Array.isArray(ps.models) ? ps.models : [];
  const found = models.find((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return item.name === model || item.model === model;
  }) as Record<string, unknown> | undefined;
  if (!found) return { processor: 'not-loaded', size: null, sizeVram: null, gpuPercent: null };
  const size = typeof found.size === 'number' ? found.size : null;
  const sizeVram = typeof found.size_vram === 'number' ? found.size_vram : null;
  const gpuPercent = size && sizeVram !== null ? Math.round((sizeVram / size) * 100) : null;
  return { processor: found.processor ?? null, size, sizeVram, gpuPercent };
}

function nvidiaGpu() {
  try {
    return execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'], {
      encoding: 'utf8',
    }).trim();
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function unload(config: ReturnType<typeof loadConfig>) {
  const response = await fetch(new URL('api/generate', `${config.ollamaBaseUrl}/`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.ollamaModel, keep_alive: 0 }),
  });
  if (!response.ok) {
    throw new Error(`Unload failed with HTTP ${response.status}`);
  }
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const ps = await get(new URL('api/ps', `${config.ollamaBaseUrl}/`));
    if (gpuShare(ps, config.ollamaModel).processor === 'not-loaded') return;
    await sleep(250);
  }
  throw new Error('Model was still loaded after keep_alive: 0; cold latency would be invalid.');
}

async function main() {
  const config = loadConfig();
  const service = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${config.port}`;
  const health = await fetch(`${service}/health`).catch(() => null);
  if (!health?.ok) {
    throw new Error(
      `Service at ${service}/health is not reachable. Start it with npm run dev and Ollama with docker compose --profile local-model up -d ollama.`,
    );
  }

  const version = await get(new URL('api/version', `${config.ollamaBaseUrl}/`)).catch(() => {
    throw new Error(
      `Ollama at ${config.ollamaBaseUrl} is not reachable. Start it with docker compose --profile local-model up -d ollama.`,
    );
  });
  const tags = await get(new URL('api/tags', `${config.ollamaBaseUrl}/`));
  const showRes = await fetch(new URL('api/show', `${config.ollamaBaseUrl}/`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: config.ollamaModel }),
  });
  const show = showRes.ok ? await json(showRes) : {};
  const digest = Array.isArray(tags.models)
    ? ((tags.models as Array<Record<string, unknown>>).find((m) => m.name === config.ollamaModel)
        ?.digest ?? null)
    : null;
  const quantization =
    typeof show.details === 'object' && show.details !== null
      ? ((show.details as Record<string, unknown>).quantization_level ?? null)
      : null;

  await unload(config);

  const mixed = parseCase('rl-mixed-animals');
  const rRequest = parseCase('r-only-animals');
  const lRequest = parseCase('l-only-home');
  const maxRequest = parseCase('rl-max-12');
  const cold = await timed(() => postDraft(service, config.serviceToken, mixed));
  const ps = await get(new URL('api/ps', `${config.ollamaBaseUrl}/`));
  const gpu = gpuShare(ps, config.ollamaModel);
  const warm = await timed(() => postDraft(service, config.serviceToken, mixed));
  const rOnly = await timed(() => postDraft(service, config.serviceToken, rRequest));
  const lOnly = await timed(() => postDraft(service, config.serviceToken, lRequest));
  const max = await timed(() => postDraft(service, config.serviceToken, maxRequest));

  const settingsSufficed =
    cold.value.ok && warm.value.ok && rOnly.value.ok && lOnly.value.ok && max.value.ok;
  const truncated = [cold, warm, rOnly, lOnly, max].some(
    (run) => run.value.code === 'PROVIDER_INCOMPLETE',
  );
  const report = {
    promptVersion: PROMPT_VERSION,
    model: {
      tag: config.ollamaModel,
      digest,
      quantization,
      ollamaVersion: version.version ?? null,
      numCtx: config.ollamaNumCtx,
      numPredict: config.ollamaNumPredict,
      temperature: GENERATION_TEMPERATURE,
    },
    hardware: nvidiaGpu(),
    gpu,
    settingsSufficed,
    truncated,
    usageNote:
      'HTTP bodies do not include usage. Match requestId to llm attempt completed logs for load/tokens.',
    runs: {
      coldMixed: summarize('rl-mixed-animals', mixed, cold),
      warmMixed: summarize('rl-mixed-animals', mixed, warm),
      rOnly: summarize('r-only-animals', rRequest, rOnly),
      lOnly: summarize('l-only-home', lRequest, lOnly),
      max12: summarize('rl-max-12', maxRequest, max),
    },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!settingsSufficed || truncated || gpu.gpuPercent !== 100) process.exitCode = 1;
}

function summarize(
  id: string,
  request: ContentRequest,
  run: { value: Awaited<ReturnType<typeof postDraft>>; wallMs: number },
) {
  return {
    id,
    requestId: run.value.requestId,
    wallMs: run.wallMs,
    status: run.value.status,
    code: run.value.code,
    qualities: run.value.body ? assessGeneration(request, run.value.body) : null,
  };
}

async function postDraft(baseUrl: string, token: string, body: ContentRequest) {
  const response = await fetch(`${baseUrl}/content-drafts`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await json(response).catch(() => ({}) as Record<string, unknown>);
  const error =
    typeof payload.error === 'object' && payload.error !== null
      ? (payload.error as { code?: string })
      : undefined;
  return {
    ok: response.ok,
    status: response.status,
    code: error?.code ?? null,
    requestId:
      (typeof payload.requestId === 'string' && payload.requestId) ||
      response.headers.get('x-request-id'),
    body: response.ok ? payload : null,
  };
}

await main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
