import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { loadConfig } from '../src/config.ts';
import {
  EXERCISES_PROMPT_VERSION,
  GENERATION_TEMPERATURE,
  VOCABULARY_PROMPT_VERSION,
} from '../src/content/generate.ts';
import { AGE_PROMPT_VERSION, LANGUAGE_PROMPT_VERSION } from '../src/content/review.ts';
import { type ContentRequest, contentRequestSchema } from '../src/content/schemas.ts';
import {
  classifySmokeRun,
  fetchJson,
  SMOKE_META_TIMEOUT_MS,
  SMOKE_UNLOAD_TIMEOUT_MS,
  smokeSettingsSufficed,
  smokeTruncated,
  timedOutError,
} from './smoke-report.ts';

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

async function timed<T>(fn: () => Promise<T>) {
  const started = Date.now();
  const value = await fn();
  return { value, wallMs: Date.now() - started };
}

async function get(url: URL, stage: string, timeoutMs = SMOKE_META_TIMEOUT_MS) {
  const { response, body } = await fetchJson(url, stage, timeoutMs);
  if (!response.ok) throw new Error(`${url.pathname} returned ${response.status}`);
  return body;
}

function gpuShare(ps: Record<string, unknown>, model: string) {
  const models = Array.isArray(ps.models) ? ps.models : [];
  const found = models.find((entry) => {
    if (typeof entry !== 'object' || entry === null) return false;
    const item = entry as Record<string, unknown>;
    return item.name === model || item.model === model;
  }) as Record<string, unknown> | undefined;
  if (!found) {
    return {
      processor: 'not-loaded',
      size: null,
      sizeVram: null,
      gpuPercent: null,
      fullyOnGpu: false,
    };
  }
  const size = typeof found.size === 'number' ? found.size : null;
  const sizeVram = typeof found.size_vram === 'number' ? found.size_vram : null;
  const fullyOnGpu = size !== null && size > 0 && sizeVram === size;
  const gpuPercent = size && sizeVram !== null ? Math.round((sizeVram / size) * 100) : null;
  return { processor: found.processor ?? null, size, sizeVram, gpuPercent, fullyOnGpu };
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
  const deadline = Date.now() + SMOKE_UNLOAD_TIMEOUT_MS;
  await fetchJson(
    new URL('api/generate', `${config.ollamaBaseUrl}/`),
    'unload',
    remaining(deadline),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.ollamaModel, keep_alive: 0 }),
    },
  ).then(({ response }) => {
    if (!response.ok) throw new Error(`Unload failed with HTTP ${response.status}`);
  });
  while (Date.now() < deadline) {
    const ps = await get(
      new URL('api/ps', `${config.ollamaBaseUrl}/`),
      'unload poll',
      remaining(deadline),
    );
    if (gpuShare(ps, config.ollamaModel).processor === 'not-loaded') return;
    await sleep(250);
  }
  throw timedOutError('unload');
}

function remaining(deadline: number) {
  return Math.max(1, deadline - Date.now());
}

async function main() {
  const config = loadConfig();
  const service = process.env.SMOKE_BASE_URL ?? `http://127.0.0.1:${config.port}`;
  const health = await fetchJson(`${service}/health`, 'health', SMOKE_META_TIMEOUT_MS).catch(
    (err) => {
      if (err instanceof Error && err.message === 'health timed out') throw err;
      return null;
    },
  );
  if (!health?.response.ok) {
    throw new Error(
      `Service at ${service}/health is not reachable. Start it with npm run dev and Ollama with docker compose --profile local-model up -d ollama.`,
    );
  }

  const version = await get(
    new URL('api/version', `${config.ollamaBaseUrl}/`),
    'ollama version',
  ).catch((err) => {
    if (err instanceof Error && err.message === 'ollama version timed out') throw err;
    throw new Error(
      `Ollama at ${config.ollamaBaseUrl} is not reachable. Start it with docker compose --profile local-model up -d ollama.`,
    );
  });
  const tags = await get(new URL('api/tags', `${config.ollamaBaseUrl}/`), 'ollama tags');
  const show = await fetchJson(
    new URL('api/show', `${config.ollamaBaseUrl}/`),
    'ollama show',
    SMOKE_META_TIMEOUT_MS,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: config.ollamaModel }),
    },
  );
  const showBody = show.response.ok ? show.body : {};
  const digest = Array.isArray(tags.models)
    ? ((tags.models as Array<Record<string, unknown>>).find((m) => m.name === config.ollamaModel)
        ?.digest ?? null)
    : null;
  const quantization =
    typeof showBody.details === 'object' && showBody.details !== null
      ? ((showBody.details as Record<string, unknown>).quantization_level ?? null)
      : null;

  await unload(config);

  const mixed = parseCase('rl-mixed-animals');
  const rRequest = parseCase('r-only-animals');
  const lRequest = parseCase('l-only-home');
  const maxRequest = parseCase('rl-max-12');
  const draftMs = config.workflowTimeoutMs;
  const cold = await timed(() => postDraft(service, config.serviceToken, mixed, draftMs));
  const ps = await get(new URL('api/ps', `${config.ollamaBaseUrl}/`), 'ollama ps');
  const gpu = gpuShare(ps, config.ollamaModel);
  const warm = await timed(() => postDraft(service, config.serviceToken, mixed, draftMs));
  const rOnly = await timed(() => postDraft(service, config.serviceToken, rRequest, draftMs));
  const lOnly = await timed(() => postDraft(service, config.serviceToken, lRequest, draftMs));
  const max = await timed(() => postDraft(service, config.serviceToken, maxRequest, draftMs));

  const classified = {
    coldMixed: summarize('rl-mixed-animals', mixed, cold),
    warmMixed: summarize('rl-mixed-animals', mixed, warm),
    rOnly: summarize('r-only-animals', rRequest, rOnly),
    lOnly: summarize('l-only-home', lRequest, lOnly),
    max12: summarize('rl-max-12', maxRequest, max),
  };
  const runList = Object.values(classified);
  const settingsSufficed = smokeSettingsSufficed(runList);
  const truncated = smokeTruncated(runList);
  const report = {
    vocabularyPromptVersion: VOCABULARY_PROMPT_VERSION,
    exercisesPromptVersion: EXERCISES_PROMPT_VERSION,
    agePromptVersion: AGE_PROMPT_VERSION,
    languagePromptVersion: LANGUAGE_PROMPT_VERSION,
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
    runs: classified,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ready = runList.every(
    (run) =>
      run.readyForReview &&
      run.checksPassed &&
      run.qualities?.some((item) => item.id === 'schema-valid' && item.passed),
  );
  if (!ready || truncated === true || !gpu.fullyOnGpu) process.exitCode = 1;
}

function summarize(
  id: string,
  request: ContentRequest,
  run: { value: Awaited<ReturnType<typeof postDraft>>; wallMs: number },
) {
  const classification = classifySmokeRun(request, run.value);
  return {
    id,
    requestId: run.value.requestId,
    wallMs: run.wallMs,
    httpStatus: run.value.status,
    httpOk: classification.httpOk,
    workflowStatus: classification.workflowStatus,
    readyForReview: classification.readyForReview,
    checksPassed: classification.checksPassed,
    revisionAssisted: classification.revisionAssisted,
    firstAttemptReady: classification.firstAttemptReady,
    truncated: classification.truncated,
    code: run.value.code,
    qualities: classification.qualities,
  };
}

async function postDraft(baseUrl: string, token: string, body: ContentRequest, timeoutMs: number) {
  const { response, body: payload } = await fetchJson(
    `${baseUrl}/content-drafts`,
    'content-drafts',
    timeoutMs,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  const error =
    typeof payload.error === 'object' && payload.error !== null
      ? (payload.error as { code?: string })
      : undefined;
  return {
    httpOk: response.ok,
    status: response.status,
    code: error?.code ?? null,
    requestId:
      (typeof payload.requestId === 'string' && payload.requestId) ||
      response.headers.get('x-request-id'),
    body: payload,
  };
}

await main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
